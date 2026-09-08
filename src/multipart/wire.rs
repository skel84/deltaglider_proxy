// SPDX-License-Identifier: GPL-3.0-only
//! Runs outside s3s: its aws-chunked decoder buffers an entire declared encoded
//! chunk before yielding. The opt-in profile refuses that encoding without a
//! body poll. Ordinary HTTP chunked transfer and SigV4 payload hashing remain.
use super::{MultipartStore, LARGE_PART_BYTES};
use axum::{
    body::Body,
    extract::{Request, State},
    middleware::Next,
    response::{IntoResponse, Response},
};
use futures::StreamExt;
use std::sync::Arc;

fn refusal(status: axum::http::StatusCode, code: &str) -> Response {
    (
        status,
        [("content-type", "application/xml")],
        format!("<Error><Code>{code}</Code></Error>"),
    )
        .into_response()
}

pub async fn bound_multipart_wire(
    State(store): State<Arc<MultipartStore>>,
    request: Request,
    next: Next,
) -> Response {
    use axum::http::{Method, StatusCode};
    if !store.large_profile() {
        return next.run(request).await;
    }
    // Apply to the S3 surface, not admin/UI. The layer is mounted only on the
    // S3 router. All PUT/POST shapes are covered, including escaped query keys.
    if request.method() != Method::PUT && request.method() != Method::POST {
        return next.run(request).await;
    }
    let headers = request.headers();
    let streaming = headers
        .get_all("x-amz-content-sha256")
        .iter()
        .any(|v| v.to_str().map_or(true, |v| v.starts_with("STREAMING-")));
    let aws_chunked = headers.get_all("content-encoding").iter().any(|v| {
        v.to_str().map_or(true, |v| {
            v.split(',')
                .any(|e| e.trim().eq_ignore_ascii_case("aws-chunked"))
        })
    });
    if streaming || aws_chunked {
        return refusal(StatusCode::BAD_REQUEST, "InvalidRequest");
    }
    let header_bytes: usize = headers
        .iter()
        .map(|(k, v)| k.as_str().len() + v.as_bytes().len())
        .sum();
    if header_bytes > 16 * 1024 || request.uri().to_string().len() > 4096 {
        return refusal(StatusCode::BAD_REQUEST, "InvalidRequest");
    }
    let limit = if request.method() == Method::PUT {
        LARGE_PART_BYTES
    } else {
        128 * 1024
    };
    if headers.get("content-length").is_some_and(|v| {
        v.to_str()
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .is_none_or(|n| n > limit)
    }) {
        return refusal(StatusCode::PAYLOAD_TOO_LARGE, "EntityTooLarge");
    }
    let Ok(_permit) = store.wire_bodies.clone().try_acquire_owned() else {
        return refusal(StatusCode::SERVICE_UNAVAILABLE, "SlowDown");
    };
    let (parts, body) = request.into_parts();
    let mut remaining = limit;
    let stream = body.into_data_stream().map(move |chunk| {
        let chunk = chunk.map_err(std::io::Error::other)?;
        if chunk.len() as u64 > remaining {
            remaining = 0;
            return Err(std::io::Error::other("multipart wire body limit"));
        }
        remaining -= chunk.len() as u64;
        Ok(chunk)
    });
    next.run(Request::from_parts(parts, Body::from_stream(stream)))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tower::ServiceExt;

    #[tokio::test]
    async fn hostile_aws_chunked_is_refused_before_decoder_or_body_poll() {
        let dir = crate::multipart::test_spool_dir();
        let store = Arc::new(
            MultipartStore::new(1024)
                .with_large_spool(dir.path())
                .unwrap(),
        );
        let polls = Arc::new(AtomicUsize::new(0));
        for (name, value) in [
            ("content-encoding", "aws-chunked"),
            ("x-amz-content-sha256", "STREAMING-AWS4-HMAC-SHA256-PAYLOAD"),
            ("x-amz-content-sha256", "STREAMING-UNSIGNED-PAYLOAD-TRAILER"),
        ] {
            let count = polls.clone();
            let stream = futures::stream::poll_fn(move |_| {
                count.fetch_add(1, Ordering::Relaxed);
                // Huge encoded chunk declaration: never reaches AwsChunkedStream.
                std::task::Poll::Ready(Some(Ok::<_, std::io::Error>(bytes::Bytes::from_static(
                    b"80000000;chunk-signature=hostile\r\n",
                ))))
            });
            let app = axum::Router::new()
                .fallback(|| async { axum::http::StatusCode::INTERNAL_SERVER_ERROR })
                .layer(axum::middleware::from_fn_with_state(
                    store.clone(),
                    bound_multipart_wire,
                ));
            let response = app
                .oneshot(
                    Request::builder()
                        .method("PUT")
                        .uri("/bucket/archive.gz?%75ploadId=id&partNumber=1")
                        .header(name, value)
                        .body(Body::from_stream(stream))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
            assert_eq!(polls.load(Ordering::Relaxed), 0);
        }
    }

    #[tokio::test]
    async fn wire_bounds_unknown_understated_and_declared_body_lengths() {
        let dir = crate::multipart::test_spool_dir();
        let store = Arc::new(
            MultipartStore::new(1024)
                .with_large_spool(dir.path())
                .unwrap(),
        );
        let app = axum::Router::new()
            .fallback(|body: Body| async {
                // No downstream limit: the outer wire layer must enforce it.
                match axum::body::to_bytes(body, usize::MAX).await {
                    Ok(_) => axum::http::StatusCode::OK,
                    Err(_) => axum::http::StatusCode::BAD_REQUEST,
                }
            })
            .layer(axum::middleware::from_fn_with_state(
                store,
                bound_multipart_wire,
            ));
        for length in [None, Some(1), Some(128 * 1024 + 1)] {
            let polls = Arc::new(AtomicUsize::new(0));
            let count = polls.clone();
            let chunk = bytes::Bytes::from(vec![0; 64 * 1024]);
            let body = Body::from_stream(futures::stream::poll_fn(move |_| {
                count.fetch_add(1, Ordering::Relaxed);
                std::task::Poll::Ready(Some(Ok::<_, std::io::Error>(chunk.clone())))
            }));
            let mut request = Request::builder()
                .method("POST")
                .uri("/bucket/a?%75ploadId=u");
            if let Some(length) = length {
                request = request.header("content-length", length);
            }
            let response = app
                .clone()
                .oneshot(request.body(body).unwrap())
                .await
                .unwrap();
            assert!(!response.status().is_success());
            assert_eq!(
                polls.load(Ordering::Relaxed),
                if length == Some(128 * 1024 + 1) { 0 } else { 3 }
            );
        }
    }

    #[tokio::test]
    async fn wire_holds_two_bodies_and_preserves_plain_chunked_bytes() {
        let dir = crate::multipart::test_spool_dir();
        let store = Arc::new(
            MultipartStore::new(1024)
                .with_large_spool(dir.path())
                .unwrap(),
        );
        let entered = Arc::new(tokio::sync::Semaphore::new(0));
        let app = axum::Router::new()
            .fallback({
                let entered = entered.clone();
                move |body: Body| {
                    let entered = entered.clone();
                    async move {
                        entered.add_permits(1);
                        axum::body::to_bytes(body, LARGE_PART_BYTES as usize)
                            .await
                            .unwrap()
                    }
                }
            })
            .layer(axum::middleware::from_fn_with_state(
                store,
                bound_multipart_wire,
            ));
        let req = || {
            Request::builder()
                .method("PUT")
                .uri("/bucket/a?uploadId=u&partNumber=1")
                .body(Body::from_stream(futures::stream::iter([Ok::<
                    _,
                    std::io::Error,
                >(
                    bytes::Bytes::from_static(b"gzip bytes"),
                )])))
                .unwrap()
        };
        let mut callers = Vec::new();
        for _ in 0..2 {
            let app = app.clone();
            callers.push(tokio::spawn(async move {
                app.oneshot(
                    Request::builder()
                        .method("PUT")
                        .uri("/bucket/a?uploadId=u&partNumber=1")
                        .body(Body::from_stream(futures::stream::pending::<
                            Result<bytes::Bytes, std::io::Error>,
                        >()))
                        .unwrap(),
                )
                .await
            }));
        }
        tokio::time::timeout(std::time::Duration::from_secs(5), entered.acquire_many(2))
            .await
            .unwrap()
            .unwrap()
            .forget();
        assert_eq!(
            app.clone().oneshot(req()).await.unwrap().status(),
            axum::http::StatusCode::SERVICE_UNAVAILABLE
        );
        for caller in callers {
            caller.abort();
            assert!(caller.await.unwrap_err().is_cancelled());
        }
        let response = app.oneshot(req()).await.unwrap();
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 100)
                .await
                .unwrap(),
            "gzip bytes"
        );
    }
}
