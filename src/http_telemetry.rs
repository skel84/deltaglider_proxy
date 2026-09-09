// SPDX-License-Identifier: GPL-3.0-only

//! Allowlisted HTTP telemetry. Never record raw URI, query, headers or bodies:
//! an S3 URI can itself contain credentials and private object identifiers.

pub fn method_name(method: &axum::http::Method) -> &'static str {
    use axum::http::Method;
    match *method {
        Method::GET => "GET",
        Method::HEAD => "HEAD",
        Method::PUT => "PUT",
        Method::POST => "POST",
        Method::DELETE => "DELETE",
        Method::OPTIONS => "OPTIONS",
        Method::PATCH => "PATCH",
        _ => "OTHER",
    }
}

pub fn request_span<B>(request: &axum::http::Request<B>) -> tracing::Span {
    tracing::debug_span!("http.request", method = method_name(request.method()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct Output(Arc<Mutex<Vec<u8>>>);
    impl Write for Output {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn http_span_never_emits_request_material() {
        for method in ["GET", "PRIVATEMETHODCANARY"] {
            let output = Output(Arc::default());
            let writer = output.clone();
            let subscriber = tracing_subscriber::fmt()
                .json()
                .with_max_level(tracing::Level::TRACE)
                .with_writer(move || writer.clone())
                .finish();
            tracing::subscriber::with_default(subscriber, || {
                let request = axum::http::Request::builder()
                    .method(method)
                    .uri("/private-object-canary?X-Amz-Signature=signed-query-canary")
                    .header("authorization", "credential-canary")
                    .body("body-canary")
                    .unwrap();
                request_span(&request).in_scope(|| tracing::info!("completed"));
            });
            let bytes = output.0.lock().unwrap();
            let text = std::str::from_utf8(&bytes).unwrap();
            assert!(
                text.contains("http.request"),
                "span must actually be captured"
            );
            for forbidden in [
                "private-object-canary",
                "signed-query-canary",
                "credential-canary",
                "body-canary",
                "PRIVATEMETHODCANARY",
            ] {
                assert!(
                    !text.contains(forbidden),
                    "request material escaped into telemetry"
                );
            }
        }
    }
}
