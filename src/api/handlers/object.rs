//! Object-level S3 handlers: GET, HEAD, PUT (with copy detection), DELETE.

use super::bucket::get_acl_response;
use super::object_helpers::{
    apply_response_overrides, build_range_response, check_conditionals, copy_object_inner,
    decode_body, enqueue_object_event, enqueue_object_events, parse_range_header, put_object_inner,
    resolve_range, upload_part, upload_part_copy,
};
use super::{
    audit_log_s3, build_object_headers, ensure_bucket_exists, xml_response, AppState, ObjectQuery,
    S3Error,
};
use crate::deltaglider::RetrieveResponse;
use crate::event_outbox::{current_unix_seconds, EventKind, EventSource, NewEvent};
use crate::iam::{AuthenticatedUser, IamState, Permission, S3Action, SharedIamState};
use axum::body::{Body, Bytes};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use chrono::Utc;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::Arc;
use subtle::ConstantTimeEq;
use tracing::{debug, info, instrument, warn};

use crate::api::extractors::{ValidatedBucket, ValidatedPath};
use crate::api::xml::{DeleteError, DeleteRequest, DeleteResult, DeletedObject, ListPartsResult};

/// Query parameters for bucket-level POST operations
#[derive(Debug, serde::Deserialize, Default)]
pub struct BucketPostQuery {
    pub delete: Option<String>,
}

/// PUT object handler with copy detection and multipart upload support
/// PUT /{bucket}/{key}
/// Detects x-amz-copy-source header to dispatch to copy operation
/// Detects ?partNumber&uploadId for multipart upload part
#[instrument(skip(state, body))]
pub async fn put_object_or_copy(
    State(state): State<Arc<AppState>>,
    ValidatedPath { bucket, key }: ValidatedPath,
    Query(query): Query<ObjectQuery>,
    auth_user: Option<axum::Extension<AuthenticatedUser>>,
    // H1: SigV4-verified `x-amz-content-sha256` header value, stashed
    // by the auth middleware after successful signature verification.
    // Used by put_object_inner / upload_part to confirm the body's
    // actual SHA-256 matches what the client signed.
    signed_payload_hash: Option<axum::Extension<crate::api::auth::SignedPayloadHash>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, S3Error> {
    let auth_user = auth_user.map(|axum::Extension(u)| u);
    let signed_payload_hash = signed_payload_hash.map(|axum::Extension(h)| h);

    // PUT /{bucket}/{key}?acl — return 501 NotImplemented.
    //
    // M4 fix: pre-fix this returned 200 OK while silently discarding
    // the ACL XML. Clients believed grants had been applied. We use
    // IAM policies instead; ACLs are unsupported. NoSuchKey takes
    // precedence over 501 (matches AWS).
    if query.acl.is_some() {
        info!("PUT object ACL: unsupported (returning 501)");
        state.engine.load().head(&bucket, &key).await?;
        return Err(S3Error::NotImplemented(
            "Object ACLs are not supported by this proxy; use IAM policies instead".to_string(),
        ));
    }

    // PUT /{bucket}/{key}?tagging — return 501 NotImplemented.
    // L1 fix: NoSuchKey precedence over 501.
    if query.tagging.is_some() {
        info!("PUT object tagging: unsupported (returning 501)");
        state.engine.load().head(&bucket, &key).await?;
        return Err(S3Error::NotImplemented(
            "Object tagging is not supported by this proxy".to_string(),
        ));
    }

    let decoded_body = decode_body(&headers, body)?;

    // Multipart upload part (with optional copy-source)
    if let (Some(part_num), Some(upload_id)) = (&query.part_number, &query.upload_id) {
        if headers.contains_key("x-amz-copy-source") {
            return upload_part_copy(
                &state, &bucket, &key, &headers, *part_num, upload_id, &auth_user,
            )
            .await;
        }
        return upload_part(
            &state,
            &bucket,
            &key,
            &headers,
            *part_num,
            upload_id,
            decoded_body,
            signed_payload_hash.as_ref(),
        )
        .await;
    }

    // Copy vs direct put
    let is_copy = headers.contains_key("x-amz-copy-source");
    let result = if is_copy {
        copy_object_inner(&state, &bucket, &key, &headers, &auth_user).await
    } else {
        put_object_inner(
            &state,
            &bucket,
            &key,
            &headers,
            &decoded_body,
            signed_payload_hash.as_ref(),
        )
        .await
    };

    if result.is_ok() {
        let user_name = auth_user
            .as_ref()
            .map(|u| u.name.as_str())
            .unwrap_or("anonymous");
        let action = if is_copy { "s3_copy" } else { "s3_put" };
        audit_log_s3(action, user_name, &headers, &bucket, &key);
    }

    result
}

/// GET object handler
/// GET /{bucket}/{key}
/// GET /{bucket}/{key}?uploadId=X - ListParts
///
/// Direct files are streamed from the backend (constant memory, low TTFB).
/// Delta files are reconstructed in memory and sent as a buffered response.
/// Supports Range requests and conditional headers.
#[instrument(skip(state))]
pub async fn get_object(
    State(state): State<Arc<AppState>>,
    ValidatedPath { bucket, key }: ValidatedPath,
    Query(query): Query<ObjectQuery>,
    req_headers: HeaderMap,
) -> Result<Response, S3Error> {
    // GET /{bucket}/{key}?tagging — return 501 NotImplemented.
    //
    // M4 fix: 404 wins over 501 when the object doesn't exist. AWS
    // returns NoSuchKey for tagging on a missing object; we should
    // surface that BEFORE the "we don't support this" 501 so clients
    // can distinguish "object missing" from "feature missing."
    if query.tagging.is_some() {
        info!("GET object tagging: unsupported (returning 501)");
        // Propagate NoSuchKey/NoSuchBucket; only swallow non-404 errors.
        state.engine.load().head(&bucket, &key).await?;
        return Err(S3Error::NotImplemented(
            "Object tagging is not supported by this proxy".to_string(),
        ));
    }

    // GET /{bucket}/{key}?acl — return canned ACL response
    if query.acl.is_some() {
        info!("GET object ACL: {}/{}", bucket, key);
        // Verify the object exists first; S3 returns 404 for ACL on non-existent objects
        state.engine.load().head(&bucket, &key).await?;
        return get_acl_response();
    }

    // ListParts (L1 fix: paginate instead of claiming is_truncated=false).
    if let Some(upload_id) = &query.upload_id {
        info!("ListParts {}/{} uploadId={}", bucket, key, upload_id);
        let marker = query.part_number_marker.unwrap_or(0);
        // S3 default + cap: 1000 parts per page.
        let max_parts = query.max_parts.unwrap_or(1000).clamp(1, 1000);
        let (parts, is_truncated, next_marker) = state
            .multipart
            .list_parts_paginated(upload_id, &bucket, &key, marker, max_parts)?;
        let result = ListPartsResult {
            bucket: bucket.clone(),
            key: key.clone(),
            upload_id: upload_id.clone(),
            parts,
            max_parts,
            is_truncated,
            part_number_marker: marker,
            next_part_number_marker: next_marker,
        };
        let xml = result.to_xml();
        return Ok(xml_response(xml));
    }

    info!("GET {}/{}", bucket, key);

    // Parse Range header early (before retrieval) so we know if it's requested
    let range_request = req_headers
        .get("range")
        .and_then(|v| v.to_str().ok())
        .and_then(parse_range_header);

    // For Range requests on passthrough objects, try the range-aware path first
    // to avoid buffering the entire file.
    if let Some(ref range) = range_request {
        // We need to know the total file size to resolve the range.
        // HEAD is cheap and gives us the metadata we need.
        let metadata = state.engine.load().head(&bucket, &key).await?;

        // Check conditional headers before fetching body
        if let Some(err) = check_conditionals(&req_headers, &metadata) {
            return Err(err);
        }

        let total = metadata.file_size;
        let (start, end) = resolve_range(range, total).ok_or(S3Error::InvalidRange)?;

        // Try range-aware streaming (only succeeds for passthrough objects)
        if let Some((stream, content_length, meta)) = state
            .engine
            .load()
            .retrieve_stream_range(&bucket, &key, start, end)
            .await?
        {
            // Build 206 Partial Content response from the range stream
            let mut headers = build_object_headers(&meta);
            let range_len = content_length;
            headers.insert(
                "Content-Length",
                HeaderValue::from_str(&range_len.to_string()).unwrap(),
            );
            headers.insert(
                "Content-Range",
                HeaderValue::from_str(&format!("bytes {}-{}/{}", start, end, total)).unwrap(),
            );
            apply_response_overrides(&mut headers, &query);
            let body = Body::from_stream(stream);
            return Ok((StatusCode::PARTIAL_CONTENT, headers, body).into_response());
        }

        // Fall through: delta/reference/unmanaged objects need full retrieval
        // then buffered slicing.
        let response = state.engine.load().retrieve_stream(&bucket, &key).await?;
        return match response {
            RetrieveResponse::Streamed {
                stream, metadata, ..
            } => {
                use futures::TryStreamExt;
                let chunks: Vec<Bytes> = stream
                    .map_err(|e| std::io::Error::other(e.to_string()))
                    .try_collect()
                    .await
                    .map_err(|e| {
                        S3Error::InternalError(crate::api::errors::sanitise_for_client(&e))
                    })?;
                let total_len: usize = chunks.iter().map(|b| b.len()).sum();
                let mut data = Vec::with_capacity(total_len);
                for chunk in &chunks {
                    data.extend_from_slice(chunk);
                }
                build_range_response(data, &metadata, range, None, &query)
            }
            RetrieveResponse::Buffered {
                data,
                metadata,
                cache_hit,
            } => build_range_response(data, &metadata, range, cache_hit, &query),
        };
    }

    let response = state.engine.load().retrieve_stream(&bucket, &key).await?;

    match response {
        RetrieveResponse::Streamed {
            stream, metadata, ..
        } => {
            debug!(
                "Streaming {}/{} (stored as {})",
                bucket,
                key,
                metadata.storage_info.label()
            );

            // Check conditional headers before streaming body
            if let Some(err) = check_conditionals(&req_headers, &metadata) {
                return Err(err);
            }

            let mut headers = build_object_headers(&metadata);
            apply_response_overrides(&mut headers, &query);
            let body = Body::from_stream(stream);
            Ok((StatusCode::OK, headers, body).into_response())
        }
        RetrieveResponse::Buffered {
            data,
            metadata,
            cache_hit,
        } => {
            debug!(
                "Retrieved {}/{} ({} bytes, stored as {})",
                bucket,
                key,
                data.len(),
                metadata.storage_info.label()
            );

            // Check conditional headers before returning body
            if let Some(err) = check_conditionals(&req_headers, &metadata) {
                return Err(err);
            }

            // Handle Range request
            if let Some(ref range) = range_request {
                return build_range_response(data, &metadata, range, cache_hit, &query);
            }

            let mut headers = build_object_headers(&metadata);
            if let Some(hit) = cache_hit {
                headers.insert(
                    "x-deltaglider-cache",
                    if hit {
                        HeaderValue::from_static("hit")
                    } else {
                        HeaderValue::from_static("miss")
                    },
                );
            }
            apply_response_overrides(&mut headers, &query);
            Ok((StatusCode::OK, headers, data).into_response())
        }
    }
}

/// HEAD object handler
/// HEAD /{bucket}/{key}
/// Supports conditional headers (If-Match, If-None-Match, If-Modified-Since, If-Unmodified-Since).
#[instrument(skip(state))]
pub async fn head_object(
    State(state): State<Arc<AppState>>,
    ValidatedPath { bucket, key }: ValidatedPath,
    req_headers: HeaderMap,
) -> Result<Response, S3Error> {
    info!("HEAD {}/{}", bucket, key);

    let metadata = state.engine.load().head(&bucket, &key).await?;

    // Check conditional headers
    if let Some(err) = check_conditionals(&req_headers, &metadata) {
        return Err(err);
    }

    let headers = build_object_headers(&metadata);
    Ok((StatusCode::OK, headers).into_response())
}

/// DELETE object handler
/// DELETE /{bucket}/{key}
/// DELETE /{bucket}/{key}?uploadId=X - AbortMultipartUpload
#[instrument(skip(state))]
pub async fn delete_object(
    State(state): State<Arc<AppState>>,
    ValidatedPath { bucket, key }: ValidatedPath,
    Query(query): Query<ObjectQuery>,
    auth_user: Option<axum::Extension<AuthenticatedUser>>,
    headers: HeaderMap,
) -> Result<Response, S3Error> {
    // DELETE /{bucket}/{key}?tagging — return 501 NotImplemented.
    // L1 fix: 404 NoSuchKey wins over 501 NotImplemented when the
    // object doesn't exist. Pre-fix DELETE returned 501 even for
    // missing keys; AWS returns 404 first.
    if query.tagging.is_some() {
        info!("DELETE object tagging: unsupported (returning 501)");
        state.engine.load().head(&bucket, &key).await?;
        return Err(S3Error::NotImplemented(
            "Object tagging is not supported by this proxy".to_string(),
        ));
    }

    // AbortMultipartUpload
    if let Some(upload_id) = &query.upload_id {
        info!(
            "AbortMultipartUpload {}/{} uploadId={}",
            bucket, key, upload_id
        );
        state.multipart.abort(upload_id, &bucket, &key)?;
        return Ok(StatusCode::NO_CONTENT.into_response());
    }

    // Recursive prefix delete: DELETE /{bucket}/{prefix}/ (trailing slash)
    if key.ends_with('/') {
        info!("DELETE recursive {}/{}*", bucket, key);
        let engine = state.engine.load();

        // E1 fix: iterate pages of 1000 keys at a time instead of materialising
        // the full listing with u32::MAX. A prefix with millions of keys used
        // to balloon memory by ~300 B × key-count before a single delete ran.
        // Page-level progress means interrupting mid-run leaves partial
        // deletes — same semantics as AWS console's recursive delete.
        const DELETE_PAGE_SIZE: u32 = 1000;

        let mut deleted = 0u32;
        let mut denied = 0u32;
        let mut next_token: Option<String> = None;

        loop {
            let page = engine
                .list_objects(
                    &bucket,
                    &key,
                    None,
                    DELETE_PAGE_SIZE,
                    next_token.as_deref(),
                    false,
                )
                .await?;

            let mut page_deleted_events = Vec::new();
            for (obj_key, _meta) in &page.objects {
                // Per-object IAM check (respects Deny rules on sub-prefixes)
                if let Some(axum::Extension(ref user)) = auth_user {
                    if !user.can(S3Action::Delete, &bucket, obj_key) {
                        denied += 1;
                        continue;
                    }
                }
                match engine.delete(&bucket, obj_key).await {
                    Ok(()) => {
                        deleted += 1;
                        page_deleted_events.push(NewEvent::new(
                            EventKind::ObjectDeleted,
                            bucket.as_str(),
                            obj_key.as_str(),
                            EventSource::S3Api,
                            current_unix_seconds(),
                            serde_json::json!({ "delete_type": "recursive" }),
                        ));
                    }
                    Err(e) => {
                        let s3_err = S3Error::from(e);
                        if matches!(s3_err, S3Error::NoSuchKey(_)) {
                            deleted += 1; // Already gone
                        } else {
                            warn!("Failed to delete {}/{}: {}", bucket, obj_key, s3_err);
                        }
                    }
                }
            }
            enqueue_object_events(&state, &page_deleted_events).await;

            if !page.is_truncated {
                break;
            }
            // continuation_token is the ENGINE-LEVEL token. Feed it straight
            // back without re-encoding (that's only for client-visible tokens).
            next_token = page.next_continuation_token;
            if next_token.is_none() {
                // Defensive: truncated=true but no token → don't infinite-loop.
                warn!(
                    "Recursive delete: is_truncated=true but no continuation token at {}/{}*",
                    bucket, key
                );
                break;
            }
        }

        let user_name = auth_user
            .as_ref()
            .map(|axum::Extension(u)| u.name.as_str())
            .unwrap_or("anonymous");
        audit_log_s3("s3_delete_recursive", user_name, &headers, &bucket, &key);
        return Ok((
            StatusCode::OK,
            axum::Json(serde_json::json!({"deleted": deleted, "denied": denied})),
        )
            .into_response());
    }

    info!("DELETE {}/{}", bucket, key);

    let mut deleted_existing = false;
    if let Err(err) = state.engine.load().delete(&bucket, &key).await {
        match S3Error::from(err) {
            S3Error::NoSuchKey(_) => {}
            other => return Err(other),
        }
    } else {
        deleted_existing = true;
    }

    debug!("Deleted {}/{}", bucket, key);
    if deleted_existing {
        enqueue_object_event(
            &state,
            NewEvent::new(
                EventKind::ObjectDeleted,
                bucket.as_str(),
                key.as_str(),
                EventSource::S3Api,
                current_unix_seconds(),
                serde_json::json!({ "delete_type": "single" }),
            ),
        )
        .await;
    }

    let user_name = auth_user
        .as_ref()
        .map(|u| u.name.as_str())
        .unwrap_or("anonymous");
    audit_log_s3("s3_delete", user_name, &headers, &bucket, &key);

    // S3 returns 204 No Content on successful delete
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// DELETE multiple objects handler
/// POST /{bucket}?delete
#[instrument(skip(state, iam_state, body))]
pub async fn delete_objects(
    State(state): State<Arc<AppState>>,
    ValidatedBucket(bucket): ValidatedBucket,
    Query(query): Query<BucketPostQuery>,
    iam_state: Option<axum::Extension<SharedIamState>>,
    auth_user: Option<axum::Extension<AuthenticatedUser>>,
    req_headers: HeaderMap,
    body: Bytes,
) -> Result<Response, S3Error> {
    use super::body_to_utf8;

    if query.delete.is_none() && is_multipart_form_upload(&req_headers) {
        return handle_form_post_upload(
            &state,
            &bucket,
            iam_state.as_ref().map(|axum::Extension(s)| s),
            &req_headers,
            body,
        )
        .await;
    }

    // Ensure this is a delete request
    if query.delete.is_none() {
        return Err(S3Error::InvalidRequest(
            "POST requires ?delete query parameter".to_string(),
        ));
    }

    // Parse XML body
    let body_str = body_to_utf8(&body)?;

    let delete_req = DeleteRequest::from_xml(body_str).map_err(|e| {
        warn!("Failed to parse DeleteObjects XML: {}", e);
        S3Error::MalformedXML
    })?;
    validate_delete_objects_count(delete_req.objects.len())?;

    info!(
        "DELETE multiple objects in {} ({} objects)",
        bucket,
        delete_req.objects.len()
    );

    let quiet = delete_req.quiet.unwrap_or(false);
    let mut deleted = Vec::new();
    let mut errors = Vec::new();
    let mut deleted_events = Vec::new();

    for obj in delete_req.objects {
        let key = obj.key.trim_start_matches('/');

        // Per-key authorization check: the middleware only validated at bucket level,
        // but each key needs its own permission check for prefix-scoped policies.
        if let Some(axum::Extension(ref user)) = auth_user {
            if !user.can(S3Action::Delete, &bucket, key) {
                errors.push(DeleteError {
                    key: obj.key.clone(),
                    version_id: obj.version_id.clone(),
                    code: "AccessDenied".to_string(),
                    message: "Access Denied".to_string(),
                });
                continue;
            }
        }

        match state.engine.load().delete(&bucket, key).await {
            Ok(()) => {
                debug!("Deleted {}/{}", bucket, key);
                deleted_events.push(NewEvent::new(
                    EventKind::ObjectDeleted,
                    bucket.as_str(),
                    key,
                    EventSource::S3Api,
                    current_unix_seconds(),
                    serde_json::json!({ "delete_type": "batch" }),
                ));
                deleted.push(DeletedObject {
                    key: obj.key.clone(),
                    version_id: obj.version_id.clone(),
                });
            }
            Err(e) => {
                let s3_err = S3Error::from(e);
                // S3 treats NoSuchKey as success in batch delete
                if matches!(s3_err, S3Error::NoSuchKey(_)) {
                    deleted.push(DeletedObject {
                        key: obj.key.clone(),
                        version_id: obj.version_id.clone(),
                    });
                } else {
                    warn!("Failed to delete {}/{}: {}", bucket, key, s3_err);
                    errors.push(DeleteError {
                        key: obj.key.clone(),
                        version_id: obj.version_id.clone(),
                        code: s3_err.code().to_string(),
                        message: s3_err.to_string(),
                    });
                }
            }
        }
    }

    enqueue_object_events(&state, &deleted_events).await;

    // Audit log each successfully deleted object
    if !deleted.is_empty() {
        let user_name = auth_user
            .as_ref()
            .map(|u| u.name.as_str())
            .unwrap_or("anonymous");
        for d in &deleted {
            audit_log_s3("s3_delete", user_name, &req_headers, &bucket, &d.key);
        }
    }

    let result = DeleteResult { deleted, errors };
    let xml = result.to_xml(quiet);

    Ok(xml_response(xml))
}

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug)]
struct ParsedFormPost {
    key_field: String,
    resolved_key: String,
    content_type: Option<String>,
    user_metadata: HashMap<String, String>,
    file_data: Bytes,
    fields_ci: HashMap<String, String>,
}

fn is_multipart_form_upload(headers: &HeaderMap) -> bool {
    headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|ct| ct.to_ascii_lowercase().starts_with("multipart/form-data"))
        .unwrap_or(false)
}

fn derive_v4_signing_key(secret_access_key: &str, date: &str, region: &str) -> [u8; 32] {
    let k_date = hmac_sha256(
        format!("AWS4{}", secret_access_key).as_bytes(),
        date.as_bytes(),
    );
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, b"s3");
    hmac_sha256(&k_service, b"aws4_request")
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC key init");
    mac.update(data);
    let out = mac.finalize().into_bytes();
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&out);
    arr
}

fn parse_policy_scope(credential: &str) -> Result<(&str, &str, &str), S3Error> {
    let mut parts = credential.split('/');
    let access_key = parts
        .next()
        .ok_or_else(|| S3Error::InvalidArgument("x-amz-credential is missing access key".into()))?;
    let date = parts
        .next()
        .ok_or_else(|| S3Error::InvalidArgument("x-amz-credential is missing scope date".into()))?;
    let region = parts.next().ok_or_else(|| {
        S3Error::InvalidArgument("x-amz-credential is missing scope region".into())
    })?;
    let service = parts
        .next()
        .ok_or_else(|| S3Error::InvalidArgument("x-amz-credential is missing service".into()))?;
    let term = parts.next().ok_or_else(|| {
        S3Error::InvalidArgument("x-amz-credential is missing terminal scope".into())
    })?;
    if parts.next().is_some() {
        return Err(S3Error::InvalidArgument(
            "x-amz-credential has unexpected extra scope components".into(),
        ));
    }
    if service != "s3" || term != "aws4_request" {
        return Err(S3Error::InvalidArgument(
            "x-amz-credential must use */*/s3/aws4_request scope".into(),
        ));
    }
    Ok((access_key, date, region))
}

fn lookup_form_field<'a>(fields_ci: &'a HashMap<String, String>, name: &str) -> Option<&'a str> {
    fields_ci
        .get(&name.to_ascii_lowercase())
        .map(std::string::String::as_str)
}

fn ensure_supported_form_fields(fields_ci: &HashMap<String, String>) -> Result<(), S3Error> {
    if lookup_form_field(fields_ci, "x-amz-security-token").is_some() {
        return Err(S3Error::NotImplemented(
            "POST form uploads with x-amz-security-token are not supported".into(),
        ));
    }
    if lookup_form_field(fields_ci, "acl").is_some() {
        return Err(S3Error::NotImplemented(
            "POST form upload ACL overrides are not supported".into(),
        ));
    }
    if lookup_form_field(fields_ci, "success_action_redirect").is_some() {
        return Err(S3Error::NotImplemented(
            "POST form upload success_action_redirect is not supported".into(),
        ));
    }
    if lookup_form_field(fields_ci, "success_action_status").is_some() {
        return Err(S3Error::NotImplemented(
            "POST form upload success_action_status override is not supported".into(),
        ));
    }
    Ok(())
}

fn resolve_form_key(key_field: &str, filename: Option<&str>) -> Result<String, S3Error> {
    let mut out = key_field.to_string();
    if out.contains("${filename}") {
        let name = filename.ok_or_else(|| {
            S3Error::InvalidArgument(
                "Form key uses ${filename} but file part has no filename".into(),
            )
        })?;
        out = out.replace("${filename}", name);
    }
    if out.contains("${") {
        return Err(S3Error::NotImplemented(
            "Only ${filename} substitution is supported in form POST key".into(),
        ));
    }
    Ok(out.trim_start_matches('/').to_string())
}

fn policy_lookup_variable(
    variable: &str,
    fields_ci: &HashMap<String, String>,
    bucket: &str,
    key_field: &str,
    resolved_content_type: &str,
) -> Result<String, S3Error> {
    match variable {
        "$bucket" => Ok(bucket.to_string()),
        "$key" => Ok(key_field.to_string()),
        "$Content-Type" | "$content-type" => Ok(resolved_content_type.to_string()),
        _ => {
            let key = variable.trim_start_matches('$').to_ascii_lowercase();
            fields_ci.get(&key).cloned().ok_or_else(|| {
                S3Error::InvalidArgument(format!(
                    "Policy references form field {} that is missing",
                    variable
                ))
            })
        }
    }
}

fn validate_form_post_policy(
    policy_json: &serde_json::Value,
    fields_ci: &HashMap<String, String>,
    bucket: &str,
    key_field: &str,
    resolved_content_type: &str,
    file_len: u64,
) -> Result<(), S3Error> {
    let expiration = policy_json
        .get("expiration")
        .and_then(|v| v.as_str())
        .ok_or_else(|| S3Error::InvalidArgument("Policy is missing expiration".into()))?;
    let expires_at = chrono::DateTime::parse_from_rfc3339(expiration)
        .map_err(|_| S3Error::InvalidArgument("Policy expiration is not valid RFC3339".into()))?;
    if Utc::now() > expires_at.with_timezone(&Utc) {
        return Err(S3Error::AccessDenied);
    }

    let conditions = policy_json
        .get("conditions")
        .and_then(|v| v.as_array())
        .ok_or_else(|| S3Error::InvalidArgument("Policy is missing conditions".into()))?;

    for cond in conditions {
        if let Some(obj) = cond.as_object() {
            for (k, v) in obj {
                let expected = v.as_str().ok_or_else(|| {
                    S3Error::InvalidArgument(format!("Policy condition '{}' must be a string", k))
                })?;
                match k.to_ascii_lowercase().as_str() {
                    "bucket" => {
                        if expected != bucket {
                            return Err(S3Error::AccessDenied);
                        }
                    }
                    "key" => {
                        if expected != key_field {
                            return Err(S3Error::AccessDenied);
                        }
                    }
                    "content-type" => {
                        if expected != resolved_content_type {
                            return Err(S3Error::AccessDenied);
                        }
                    }
                    "acl" => {
                        return Err(S3Error::NotImplemented(
                            "POST form upload ACL policy conditions are not supported".into(),
                        ));
                    }
                    x if x.starts_with("x-amz-meta-")
                        || x == "x-amz-algorithm"
                        || x == "x-amz-credential"
                        || x == "x-amz-date"
                        || x == "x-amz-signature"
                        || x == "policy" =>
                    {
                        let actual = lookup_form_field(fields_ci, x).unwrap_or_default();
                        if actual != expected {
                            return Err(S3Error::AccessDenied);
                        }
                    }
                    other => {
                        return Err(S3Error::NotImplemented(format!(
                            "POST form upload policy condition '{}' is not supported",
                            other
                        )));
                    }
                }
            }
            continue;
        }

        let arr = cond.as_array().ok_or_else(|| {
            S3Error::InvalidArgument("Policy conditions entries must be object or array".into())
        })?;
        let op = arr.first().and_then(|v| v.as_str()).ok_or_else(|| {
            S3Error::InvalidArgument("Policy condition array must start with an operator".into())
        })?;
        match op {
            "content-length-range" => {
                if arr.len() != 3 {
                    return Err(S3Error::InvalidArgument(
                        "content-length-range must have exactly 3 elements".into(),
                    ));
                }
                let min = arr[1]
                    .as_u64()
                    .or_else(|| arr[1].as_i64().map(|n| n.max(0) as u64))
                    .ok_or_else(|| {
                        S3Error::InvalidArgument(
                            "content-length-range minimum must be a non-negative integer".into(),
                        )
                    })?;
                let max = arr[2]
                    .as_u64()
                    .or_else(|| arr[2].as_i64().map(|n| n.max(0) as u64))
                    .ok_or_else(|| {
                        S3Error::InvalidArgument(
                            "content-length-range maximum must be a non-negative integer".into(),
                        )
                    })?;
                if file_len < min || file_len > max {
                    return Err(S3Error::AccessDenied);
                }
            }
            "starts-with" | "eq" => {
                if arr.len() != 3 {
                    return Err(S3Error::InvalidArgument(format!(
                        "{} condition must have exactly 3 elements",
                        op
                    )));
                }
                let variable = arr[1].as_str().ok_or_else(|| {
                    S3Error::InvalidArgument(format!("{} variable must be a string", op))
                })?;
                let expected = arr[2].as_str().ok_or_else(|| {
                    S3Error::InvalidArgument(format!("{} match value must be a string", op))
                })?;
                let actual = policy_lookup_variable(
                    variable,
                    fields_ci,
                    bucket,
                    key_field,
                    resolved_content_type,
                )?;
                let matched = if op == "eq" {
                    actual == expected
                } else {
                    actual.starts_with(expected)
                };
                if !matched {
                    return Err(S3Error::AccessDenied);
                }
            }
            other => {
                return Err(S3Error::NotImplemented(format!(
                    "POST form upload policy operator '{}' is not supported",
                    other
                )));
            }
        }
    }

    Ok(())
}

async fn parse_form_post_upload(
    headers: &HeaderMap,
    body: Bytes,
) -> Result<ParsedFormPost, S3Error> {
    let content_type_header = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| S3Error::InvalidRequest("Missing Content-Type header".into()))?;
    let boundary = multer::parse_boundary(content_type_header)
        .map_err(|e| S3Error::InvalidRequest(format!("Invalid multipart boundary: {}", e)))?;
    let stream = futures::stream::once(async move { Ok::<Bytes, std::io::Error>(body) });
    let mut multipart = multer::Multipart::new(stream, boundary);

    let mut fields_ci = HashMap::new();
    let mut user_metadata = HashMap::new();
    let mut file_data: Option<Bytes> = None;
    let mut file_name: Option<String> = None;
    let mut file_content_type: Option<String> = None;

    while let Some(field) = multipart.next_field().await.map_err(|e| {
        S3Error::InvalidRequest(format!("Malformed multipart/form-data body: {}", e))
    })? {
        let name = field
            .name()
            .ok_or_else(|| S3Error::InvalidRequest("Multipart field is missing name".into()))?
            .to_string();
        let lc_name = name.to_ascii_lowercase();
        let part_filename = field.file_name().map(str::to_string);
        let part_content_type = field.content_type().map(|ct| ct.to_string());
        if part_filename.is_some() || lc_name == "file" {
            if file_data.is_some() {
                return Err(S3Error::InvalidRequest(
                    "POST form upload expects exactly one file part".into(),
                ));
            }
            let bytes = field.bytes().await.map_err(|e| {
                S3Error::InvalidRequest(format!("Failed reading multipart file part: {}", e))
            })?;
            file_data = Some(bytes);
            file_name = part_filename;
            file_content_type = part_content_type;
            continue;
        }
        let value = field.text().await.map_err(|e| {
            S3Error::InvalidRequest(format!(
                "Failed reading multipart form field '{}': {}",
                name, e
            ))
        })?;
        if let Some(meta_key) = lc_name.strip_prefix("x-amz-meta-") {
            user_metadata.insert(meta_key.to_string(), value.clone());
        }
        fields_ci.insert(lc_name, value);
    }

    let key_field = lookup_form_field(&fields_ci, "key")
        .ok_or_else(|| {
            S3Error::InvalidArgument("POST form upload is missing required 'key' field".into())
        })?
        .to_string();
    let resolved_key = resolve_form_key(&key_field, file_name.as_deref())?;
    if resolved_key.is_empty() {
        return Err(S3Error::InvalidArgument(
            "POST form upload resolved object key is empty".into(),
        ));
    }

    let content_type = lookup_form_field(&fields_ci, "content-type")
        .map(str::to_string)
        .or(file_content_type);
    let file_data = file_data.ok_or_else(|| {
        S3Error::InvalidArgument("POST form upload requires a multipart file part".into())
    })?;

    Ok(ParsedFormPost {
        key_field,
        resolved_key,
        content_type,
        user_metadata,
        file_data,
        fields_ci,
    })
}

fn authenticate_form_post(
    iam_state: Option<&SharedIamState>,
    bucket: &str,
    parsed: &ParsedFormPost,
) -> Result<Option<AuthenticatedUser>, S3Error> {
    let Some(iam_state) = iam_state else {
        return Ok(None);
    };
    let snapshot = iam_state.load_full();
    if matches!(snapshot.as_ref(), IamState::Disabled) {
        return Ok(None);
    }

    ensure_supported_form_fields(&parsed.fields_ci)?;

    let policy_b64 = lookup_form_field(&parsed.fields_ci, "policy")
        .ok_or(S3Error::AccessDenied)?
        .to_string();
    let credential = lookup_form_field(&parsed.fields_ci, "x-amz-credential")
        .ok_or(S3Error::AccessDenied)?
        .to_string();
    let algorithm = lookup_form_field(&parsed.fields_ci, "x-amz-algorithm")
        .ok_or(S3Error::AccessDenied)?
        .to_string();
    let signature = lookup_form_field(&parsed.fields_ci, "x-amz-signature")
        .ok_or(S3Error::AccessDenied)?
        .to_string();
    let amz_date = lookup_form_field(&parsed.fields_ci, "x-amz-date")
        .ok_or(S3Error::AccessDenied)?
        .to_string();
    if !algorithm.eq_ignore_ascii_case("AWS4-HMAC-SHA256") {
        return Err(S3Error::InvalidArgument(
            "Only x-amz-algorithm=AWS4-HMAC-SHA256 is supported for POST form uploads".into(),
        ));
    }

    let (access_key, scope_date, scope_region) = parse_policy_scope(&credential)?;
    if !amz_date.starts_with(scope_date) {
        return Err(S3Error::AccessDenied);
    }

    let (secret_access_key, auth_user) = match snapshot.as_ref() {
        IamState::Disabled => unreachable!("checked above"),
        IamState::Legacy(auth) => {
            if auth.access_key_id != access_key {
                return Err(S3Error::AccessDenied);
            }
            let bootstrap_perms = vec![Permission {
                id: 0,
                effect: "Allow".to_string(),
                actions: vec!["*".to_string()],
                resources: vec!["*".to_string()],
                conditions: None,
            }];
            let bootstrap_policies: Vec<iam_rs::IAMPolicy> = bootstrap_perms
                .iter()
                .map(crate::iam::permissions::permission_to_iam_policy)
                .collect();
            (
                auth.secret_access_key.clone(),
                AuthenticatedUser {
                    name: "$bootstrap".to_string(),
                    access_key_id: auth.access_key_id.clone(),
                    permissions: bootstrap_perms,
                    iam_policies: bootstrap_policies,
                },
            )
        }
        IamState::Iam(index) => {
            let user = index
                .get(access_key)
                .filter(|u| u.enabled)
                .ok_or(S3Error::AccessDenied)?;
            (
                user.secret_access_key.clone(),
                AuthenticatedUser {
                    name: user.name.clone(),
                    access_key_id: user.access_key_id.clone(),
                    permissions: user.permissions.clone(),
                    iam_policies: user.iam_policies.clone(),
                },
            )
        }
    };

    let signing_key = derive_v4_signing_key(&secret_access_key, scope_date, scope_region);
    let computed_signature = hex::encode(hmac_sha256(&signing_key, policy_b64.as_bytes()));
    let sig_matches: bool = ConstantTimeEq::ct_eq(
        computed_signature.as_bytes(),
        signature.to_ascii_lowercase().as_bytes(),
    )
    .into();
    if !sig_matches {
        return Err(S3Error::SignatureDoesNotMatch);
    }

    let policy_bytes = base64::engine::general_purpose::STANDARD
        .decode(policy_b64.as_bytes())
        .map_err(|_| S3Error::InvalidArgument("Policy field is not valid base64".into()))?;
    let policy_json: serde_json::Value = serde_json::from_slice(&policy_bytes)
        .map_err(|_| S3Error::InvalidArgument("Policy JSON is malformed".into()))?;
    let resolved_ct = parsed
        .content_type
        .as_deref()
        .unwrap_or("application/octet-stream");
    validate_form_post_policy(
        &policy_json,
        &parsed.fields_ci,
        bucket,
        &parsed.key_field,
        resolved_ct,
        parsed.file_data.len() as u64,
    )?;

    if !auth_user.can(S3Action::Write, bucket, &parsed.resolved_key) {
        return Err(S3Error::AccessDenied);
    }
    Ok(Some(auth_user))
}

async fn handle_form_post_upload(
    state: &Arc<AppState>,
    bucket: &str,
    iam_state: Option<&SharedIamState>,
    headers: &HeaderMap,
    body: Bytes,
) -> Result<Response, S3Error> {
    ensure_bucket_exists(state, bucket).await?;
    let parsed = parse_form_post_upload(headers, body).await?;
    let auth_user = authenticate_form_post(iam_state, bucket, &parsed)?;
    super::object_helpers::check_quota(state, bucket, parsed.file_data.len() as u64)?;
    let result = state
        .engine
        .load()
        .store(
            bucket,
            &parsed.resolved_key,
            &parsed.file_data,
            parsed.content_type.clone(),
            parsed.user_metadata.clone(),
        )
        .await?;
    let storage_type = result.metadata.storage_info.label();
    super::object_helpers::enqueue_object_event(
        state,
        NewEvent::new(
            EventKind::ObjectCreated,
            bucket,
            &parsed.resolved_key,
            EventSource::S3Api,
            current_unix_seconds(),
            serde_json::json!({
                "content_length": parsed.file_data.len(),
                "storage_type": storage_type,
                "etag": result.metadata.etag(),
            }),
        ),
    )
    .await;
    let user_name = auth_user
        .as_ref()
        .map(|u| u.name.as_str())
        .unwrap_or("anonymous");
    audit_log_s3("s3_post", user_name, headers, bucket, &parsed.resolved_key);
    Ok((
        StatusCode::NO_CONTENT,
        [
            ("ETag", result.metadata.etag()),
            ("x-amz-storage-type", storage_type.to_string()),
        ],
        "",
    )
        .into_response())
}

fn validate_delete_objects_count(count: usize) -> Result<(), S3Error> {
    if count > 1000 {
        return Err(S3Error::InvalidArgument(
            "DeleteObjects supports at most 1000 keys per request".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delete_objects_rejects_more_than_1000_keys() {
        assert!(validate_delete_objects_count(1000).is_ok());
        assert!(matches!(
            validate_delete_objects_count(1001),
            Err(S3Error::InvalidArgument(_))
        ));
    }
}
