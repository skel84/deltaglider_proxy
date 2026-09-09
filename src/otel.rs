// SPDX-License-Identifier: GPL-3.0-only

//! Opt-in, allowlisted OTLP traces. Existing tracing events are intentionally
//! NOT bridged: they may carry private object keys or upstream diagnostics.

use axum::{extract::State, middleware::Next, response::Response};
use opentelemetry::{
    trace::{Span, SpanKind, Status, Tracer, TracerProvider},
    KeyValue,
};
use opentelemetry_otlp::{Protocol, WithExportConfig, WithHttpConfig};
use opentelemetry_sdk::{
    trace::{BatchConfigBuilder, BatchSpanProcessor, Sampler, SdkTracer, SdkTracerProvider},
    Resource,
};
use std::time::Duration;

fn batch_processor(
    exporter: impl opentelemetry_sdk::trace::SpanExporter + 'static,
) -> BatchSpanProcessor {
    BatchSpanProcessor::builder(exporter)
        .with_batch_config(
            BatchConfigBuilder::default()
                .with_max_queue_size(512)
                .with_max_export_batch_size(64)
                .with_scheduled_delay(Duration::from_secs(1))
                .build(),
        )
        .build()
}

pub struct Telemetry {
    provider: SdkTracerProvider,
}

impl Telemetry {
    pub fn tracer(&self) -> SdkTracer {
        self.provider.tracer("deltaglider_proxy.http")
    }

    pub fn shutdown(self) {
        // Called on a blocking worker after HTTP shutdown; never on the S3 path.
        let _ = self.provider.shutdown_with_timeout(Duration::from_secs(3));
    }
}

fn endpoint(value: &str) -> Result<String, &'static str> {
    let mut url = reqwest::Url::parse(value).map_err(|_| "invalid OTLP endpoint")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("OTLP endpoint must be HTTP(S) without credentials, query or fragment");
    }
    let path = format!("{}/v1/traces", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url.into())
}

fn resource_attributes(raw: &str) -> Vec<KeyValue> {
    // No automatic environment detectors or unbounded arbitrary resource data.
    const KEYS: [&str; 5] = [
        "k8s.cluster.name",
        "k8s.namespace.name",
        "k8s.pod.name",
        "k8s.pod.uid",
        "k8s.node.name",
    ];
    KEYS.iter()
        .filter_map(|key| {
            raw.split(',')
                .filter_map(|item| item.split_once('='))
                .find_map(|(name, value)| {
                    let value = value.trim();
                    (name.trim() == *key
                        && !value.is_empty()
                        && value.len() <= 253
                        && value
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)))
                    .then(|| KeyValue::new(*key, value.to_owned()))
                })
        })
        .collect()
}

/// Initialize once, outside Tokio's async workers. Disabled means no exporter,
/// worker, provider or collector connection. Errors must be logged by category
/// only, never with the environment value or exporter diagnostic.
pub fn init() -> Result<Option<Telemetry>, &'static str> {
    if !crate::config::env_bool("DGP_OTEL_ENABLED", false) {
        return Ok(None);
    }
    let raw =
        std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").map_err(|_| "OTLP endpoint is required")?;
    if raw.len() > 2048 {
        return Err("OTLP endpoint exceeds bound");
    }
    let endpoint = endpoint(&raw)?;
    let protocol =
        std::env::var("OTEL_EXPORTER_OTLP_PROTOCOL").unwrap_or_else(|_| "http/protobuf".into());
    if protocol != "http/protobuf" {
        return Err("only OTLP HTTP/protobuf is supported");
    }
    let http_client = reqwest_otel::blocking::Client::builder()
        .redirect(reqwest_otel::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(1))
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|_| "OTLP HTTP client initialization failed")?;
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_http_client(http_client)
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(endpoint)
        .with_timeout(Duration::from_secs(2))
        .build()
        .map_err(|_| "OTLP exporter initialization failed")?;
    let mut attributes = vec![
        KeyValue::new("service.name", "deltaglider-proxy"),
        KeyValue::new("service.version", env!("CARGO_PKG_VERSION")),
    ];
    if let Ok(raw) = std::env::var("OTEL_RESOURCE_ATTRIBUTES") {
        if raw.len() > 4096 {
            return Err("OTLP resource attributes exceed bound");
        }
        attributes.extend(resource_attributes(&raw));
    }
    let provider = SdkTracerProvider::builder()
        .with_resource(
            Resource::builder_empty()
                .with_attributes(attributes)
                .build(),
        )
        .with_max_attributes_per_span(8)
        .with_max_events_per_span(0)
        .with_max_links_per_span(0)
        .with_span_processor(batch_processor(exporter));
    // Start with all requests sampled. An explicit standard sampler setting
    // (and its argument) is interpreted by the SDK, without a code override.
    let provider = if std::env::var("OTEL_TRACES_SAMPLER")
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
    {
        provider.with_sampler(Sampler::AlwaysOn)
    } else {
        provider
    };
    let provider = provider.build();
    Ok(Some(Telemetry { provider }))
}

pub async fn request_trace(
    State(tracer): State<SdkTracer>,
    request: axum::http::Request<axum::body::Body>,
    next: Next,
) -> Response {
    // Do not honor remote sampling flags or ingest baggage, URLs, headers,
    // identifiers or body data into a trace. Export queue capacity is bounded
    // independently of the configured sampling probability.
    let mut span = tracer
        .span_builder("s3.request")
        .with_kind(SpanKind::Server)
        .with_attributes([KeyValue::new(
            "http.request.method",
            crate::http_telemetry::method_name(request.method()),
        )])
        .start(&tracer);
    let response = next.run(request).await;
    span.set_attribute(KeyValue::new(
        "http.response.status_code",
        i64::from(response.status().as_u16()),
    ));
    if response.status().is_server_error() {
        span.set_status(Status::error("server_error"));
    }
    span.end();
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry_sdk::trace::{SpanData, SpanExporter};
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    // A separate process isolates SDK environment configuration from parallel
    // tests. Only the owning parent sets this marker; ordinary suite runs noop.
    #[test]
    fn telemetry_wire_child() {
        if std::env::var("DGP_OTEL_WIRE_CHILD").as_deref() != Ok("1") {
            return;
        }
        if let Some(telemetry) = init().unwrap() {
            let runtime = tokio::runtime::Runtime::new().unwrap();
            runtime.block_on(async {
                let app = axum::Router::new()
                    .fallback(|| async { axum::http::StatusCode::NO_CONTENT })
                    .layer(axum::middleware::from_fn_with_state(
                        telemetry.tracer(),
                        request_trace,
                    ));
                let response = app
                    .oneshot(
                        axum::http::Request::builder()
                            .uri("/private-wire-canary?X-Amz-Signature=signature-canary")
                            .header("authorization", "secret-canary")
                            .body(axum::body::Body::from("body-canary"))
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(response.status(), axum::http::StatusCode::NO_CONTENT);
            });
            telemetry.shutdown();
        }
    }

    #[tokio::test]
    async fn real_otlp_export_respects_disable_sampling_and_privacy() {
        let (sender, mut receiver) = tokio::sync::mpsc::channel(8);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let app =
            axum::Router::new().fallback(move |request: axum::http::Request<axum::body::Body>| {
                let sender = sender.clone();
                async move {
                    let (parts, body) = request.into_parts();
                    let body = axum::body::to_bytes(body, 65536).await.unwrap();
                    sender.send((parts, body)).await.unwrap();
                    // Empty ExportTraceServiceResponse is valid protobuf.
                    ([("content-type", "application/x-protobuf")], "")
                }
            });
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        // Abort on assertion failure as well as success; no retained listener.
        struct ServerGuard(tokio::task::JoinHandle<()>);
        impl Drop for ServerGuard {
            fn drop(&mut self) {
                self.0.abort();
            }
        }
        let _server = ServerGuard(server);
        for (enabled, sampler, argument, expect_export) in [
            ("false", "always_on", "1", false),
            ("true", "always_off", "1", false),
            ("true", "traceidratio", "0", false),
            ("true", "traceidratio", "1", true),
            ("true", "", "1", true),
        ] {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .env_clear()
                .args(["--exact", "otel::tests::telemetry_wire_child"])
                .env("DGP_OTEL_WIRE_CHILD", "1")
                .env("DGP_OTEL_ENABLED", enabled)
                .env("OTEL_EXPORTER_OTLP_ENDPOINT", &endpoint)
                .env("OTEL_TRACES_SAMPLER", sampler)
                .env("OTEL_TRACES_SAMPLER_ARG", argument)
                .env(
                    "OTEL_RESOURCE_ATTRIBUTES",
                    "secret=resource-canary,k8s.cluster.name=test",
                );
            let output = tokio::task::spawn_blocking(move || command.output().unwrap())
                .await
                .unwrap();
            assert!(output.status.success(), "isolated telemetry worker failed");
            if expect_export {
                let (parts, body) = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(parts.uri.path(), "/v1/traces");
                assert_eq!(parts.headers["content-type"], "application/x-protobuf");
                assert!(!parts.headers.contains_key("authorization"));
                assert!(
                    body.windows(b"s3.request".len())
                        .any(|bytes| bytes == b"s3.request"),
                    "actual span missing from wire payload"
                );
                assert!(
                    !body
                        .windows(b"canary".len())
                        .any(|bytes| bytes == b"canary"),
                    "private data escaped on OTLP wire"
                );
            }
            assert!(receiver.try_recv().is_err(), "unexpected telemetry export");
        }
    }

    #[derive(Debug, Clone, Default)]
    struct Recorder(Arc<Mutex<Vec<SpanData>>>);

    impl SpanExporter for Recorder {
        async fn export(&self, spans: Vec<SpanData>) -> opentelemetry_sdk::error::OTelSdkResult {
            self.0.lock().unwrap().extend(spans);
            Ok(())
        }
    }

    #[tokio::test]
    async fn exported_request_excludes_private_fields_and_error_contents() {
        let recorder = Recorder::default();
        let provider = SdkTracerProvider::builder()
            .with_sampler(Sampler::AlwaysOn)
            .with_simple_exporter(recorder.clone())
            .build();
        let app = axum::Router::new()
            .fallback(|| async {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "private-error-canary",
                )
            })
            .layer(axum::middleware::from_fn_with_state(
                provider.tracer("test"),
                request_trace,
            ));
        let request = axum::http::Request::builder()
            .method("POST")
            .uri("/private-key-canary?X-Amz-Signature=signature-canary")
            .header("authorization", "secret-canary")
            .header("baggage", "patient=patient-canary")
            .body(axum::body::Body::from("body-canary"))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(
            response.status(),
            axum::http::StatusCode::INTERNAL_SERVER_ERROR
        );
        let records = recorder.0.lock().unwrap();
        assert_eq!(records.len(), 1, "always-on must capture the request");
        let exported = format!("{:?}", records[0]);
        assert!(
            !exported.contains("canary"),
            "private request or response material escaped"
        );
        assert_eq!(records[0].status, Status::error("server_error"));
    }

    #[derive(Debug, Clone)]
    struct BlockedExporter {
        started: Arc<std::sync::atomic::AtomicBool>,
        gate: Arc<(Mutex<bool>, std::sync::Condvar)>,
        exported: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl SpanExporter for BlockedExporter {
        async fn export(&self, spans: Vec<SpanData>) -> opentelemetry_sdk::error::OTelSdkResult {
            use std::sync::atomic::Ordering;
            self.started.store(true, Ordering::SeqCst);
            let (lock, changed) = &*self.gate;
            // Bounded even if a test assertion fails before opening the gate.
            let _ = changed
                .wait_timeout_while(lock.lock().unwrap(), Duration::from_secs(5), |open| !*open)
                .unwrap();
            self.exported.fetch_add(spans.len(), Ordering::SeqCst);
            Ok(())
        }
    }

    #[tokio::test]
    async fn blocked_collector_drops_overflow_without_blocking_requests() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let exporter = BlockedExporter {
            started: Arc::new(AtomicBool::new(false)),
            gate: Arc::new((Mutex::new(false), std::sync::Condvar::new())),
            exported: Arc::new(AtomicUsize::new(0)),
        };
        let provider = SdkTracerProvider::builder()
            .with_sampler(Sampler::AlwaysOn)
            .with_span_processor(batch_processor(exporter.clone()))
            .build();
        let app = axum::Router::new()
            .fallback(|| async { axum::http::StatusCode::NO_CONTENT })
            .layer(axum::middleware::from_fn_with_state(
                provider.tracer("test"),
                request_trace,
            ));
        for _ in 0..64 {
            app.clone()
                .oneshot(axum::http::Request::new(axum::body::Body::empty()))
                .await
                .unwrap();
        }
        tokio::time::timeout(Duration::from_secs(2), async {
            while !exporter.started.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            for _ in 0..2048 {
                let response = app
                    .clone()
                    .oneshot(axum::http::Request::new(axum::body::Body::empty()))
                    .await
                    .unwrap();
                assert_eq!(response.status(), axum::http::StatusCode::NO_CONTENT);
            }
        })
        .await
        .unwrap();
        assert_eq!(
            exporter.exported.load(Ordering::SeqCst),
            0,
            "collector must still be blocked"
        );
        *exporter.gate.0.lock().unwrap() = true;
        exporter.gate.1.notify_all();
        tokio::task::spawn_blocking(move || provider.shutdown())
            .await
            .unwrap()
            .unwrap();
        let count = exporter.exported.load(Ordering::SeqCst);
        assert!(
            count > 0 && count <= 576,
            "queued plus active export must remain bounded"
        );
    }

    #[test]
    fn telemetry_rejects_credential_bearing_endpoints() {
        for value in [
            "http://user:secret@collector",
            "http://collector/?token=secret",
            "http://collector/#secret",
            "file:///tmp/collector",
        ] {
            assert!(endpoint(value).is_err());
        }
        assert!(endpoint("http://collector:4318").is_ok());
    }

    #[test]
    fn telemetry_resources_exclude_non_allowlisted_data() {
        let resources = resource_attributes("k8s.cluster.name=mgmt-cicd,secret=canary,k8s.pod.name=bad value,k8s.node.name=worker-1,k8s.node.name=duplicate");
        assert_eq!(resources.len(), 2);
        assert!(resources
            .iter()
            .all(|kv| !kv.value.to_string().contains("canary")));
    }
}
