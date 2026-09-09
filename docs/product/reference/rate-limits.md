# Rate limits and concurrency

Reference for the proxy's protection layers against overload, abuse, and resource exhaustion. Every limit has a default and an environment-variable override.

## Auth rate limiter

Per-IP brute-force protection for SigV4 authentication and admin login endpoints.

| Setting | Default | Env var |
|---------|---------|---------|
| Max failures before lockout | 100 | `DGP_RATE_LIMIT_MAX_ATTEMPTS` |
| Rolling window | 300 s (5 min) | `DGP_RATE_LIMIT_WINDOW_SECS` |
| Lockout duration | 600 s (10 min) | `DGP_RATE_LIMIT_LOCKOUT_SECS` |

After a lockout expires, the failure counter resets and the IP can authenticate again. Lockout responses are `429 SlowDown`.

### Progressive delay

Failed auth attempts add an artificial delay to responses before the lockout threshold is reached:

| Failures | Delay |
|----------|-------|
| 1–10 | none |
| 11 | 200 ms |
| 12 | 400 ms |
| 13 | 800 ms |
| 14 | 1.6 s |
| 15 | 3.2 s |
| 16+ | 5 s (cap) |

### IP extraction

Rate limiting requires a client IP. The proxy reads `X-Forwarded-For` or `X-Real-IP` headers only when `DGP_TRUST_PROXY_HEADERS=true`; the default is `false`, so direct-to-internet deployments are protected against IP spoofing out of the box. `DGP_TRUST_PROXY_HEADERS=true` is appropriate only behind a trusted reverse proxy (nginx, Caddy, ALB) that injects these headers.

> **Failure mode behind a proxy.** If the proxy sits behind a reverse proxy and `DGP_TRUST_PROXY_HEADERS` stays `false`, every request appears to originate from the proxy's own IP. All clients then share **one** rate-limit bucket, so a single busy client exhausts it and **locks out everyone** with `503 SlowDown`. Set `DGP_TRUST_PROXY_HEADERS=true` behind any trusted proxy; the save-time config advisories flag the rate-limit-on + trust-off combination.

For direct-to-internet deployments without trusted headers, the rate limiter receives no IP and is effectively a no-op for those requests; SigV4 signature verification and the replay cache still apply. The admission chain's `source_ip_list` predicates use axum `ConnectInfo` (wired at startup) and continue to work in the direct case; the rate limiter does not consume `ConnectInfo`.

## Codec semaphore

Limits concurrent xdelta3 encode/decode subprocesses. Delta reconstruction (decode) is CPU-fast but I/O-bound (fetching reference + delta from storage), so the default is generous.

| Setting | Default | Env var |
|---------|---------|---------|
| Max concurrent xdelta3 processes | `num_cpus * 4` (min 16) | `DGP_CODEC_CONCURRENCY` |

Behavior differs by operation:

- **GET (decode)**: waits up to 60 seconds for a codec slot, then returns `503 SlowDown`.
- **PUT (encode)**: fails immediately with `503 SlowDown` when no slot is available, so queued uploads do not hold large request bodies in memory while waiting.

## HTTP concurrency limit

Caps total in-flight HTTP requests across the server. Requests beyond the limit queue until a slot opens or the request timeout fires.

| Setting | Default | Env var |
|---------|---------|---------|
| Max concurrent requests | 1024 | `DGP_MAX_CONCURRENT_REQUESTS` |

## Request timeout

Per-request deadline applied to all S3 API requests; returns HTTP `504 Gateway Timeout` when exceeded. Large delta reconstructions over slow storage links count toward this deadline.

| Setting | Default | Env var |
|---------|---------|---------|
| Request timeout | 300 s | `DGP_REQUEST_TIMEOUT_SECS` |

## Multipart upload limit

Caps concurrent in-progress multipart uploads. By default, parts start in memory; relay policy can move them to disk. Returns `503 SlowDown` when exceeded. The fixed opt-in disk profile below replaces this upload-count limit.

| Setting | Default | Env var |
|---------|---------|---------|
| Max concurrent uploads | 1000 | `DGP_MAX_MULTIPART_UPLOADS` |

### Optional UploadPart body admission

Two startup-only environment settings bound request bodies independently of
retained multipart parts. Both are unset by default, preserving existing limits.
They do **not** enable a large-backup profile, raise object caps, force disk relay,
or bound completion and retained spool resources.

| Setting | Unset behavior | Env var |
|---------|----------------|---------|
| UploadPart bytes | Current engine object limit | `DGP_MPU_MAX_PART_BYTES` |
| Concurrent UploadPart body collectors | No additional body-only semaphore | `DGP_MPU_MAX_BUFFERED_PARTS` |

The effective byte limit is the lesser of the part setting and the current
object limit. Zero bytes allows only empty bodies; zero collectors refuses all
UploadPart requests. Excess declared length is rejected before polling the body;
unknown or understated length is checked while streaming, before appending the
crossing chunk. Size refusal returns `EntityTooLarge`. A saturated collector pool
returns `503 SlowDown` without queuing or polling the body. A slot remains owned
through collection, integrity validation and insertion into the multipart store;
errors and cancellation release it. Accepted parts remain subject to the separate
retained-state limits after the collector slot is released.

Setting **either** control disables UploadPartCopy with `InvalidRequest` before
source lookup/retrieval. That operation currently hydrates the complete source,
even for a small range, and could otherwise bypass the body bounds. Use UploadPart
instead, or unset both controls and restart to restore legacy copy behavior.
CreateMultipartUpload remains available; these two controls do not change the small-object delta policy.

For example, `16777216` bytes and `2` collectors constrain accepted ingress to
two 16 MiB bodies, **not** 32 MiB process RSS. The collector's growing Vec may
reserve additional capacity; AWS chunk decoding can temporarily retain both
encoded and decoded buffers. Incoming transport chunks, s3s integrity processing,
HTTP/TLS buffers, caches, retained parts, and completion/SDK allocations are
additional. Neither these settings nor the part limit alone establish a container
memory or disk envelope. Do not raise object/spool caps on their basis.

### Opt-in native-S3 large-backup profile

`DGP_MPU_LARGE_SPOOL_DIR` is **unset (disabled) by default** and takes effect only
at startup. A nonempty path opts into a fixed multipart disk profile; it is not a
general increase to PUT, GET, copy, cache or delta-engine memory limits. This is
intended for operator-controlled native gzip backup streams, not delta savings.
It does not enable or configure Barman itself.

| Boundary | Fixed profile value |
|----------|---------------------|
| Object payload | 2 GiB (`2147483648` bytes) |
| UploadPart body | 16 MiB (`16777216` bytes) |
| Admitted S3 PUT/POST bodies / UploadPart collectors | Two of each, not four UploadPart bodies |
| Retained payload **including overwrite temporaries** | 4 GiB (`4294967296` bytes) process-wide |
| Tracked uploads (including failed cleanup) | 32 |
| Retained parts | 256 per upload; 4096 process-wide |
| Active owned completions | One, including SDK create/abort and local settlement |
| Create metadata | 64 entries / 8 KiB total; key 1 KiB; content type 1 KiB |
| S3 PUT/POST wire envelope | PUT 16 MiB; POST 128 KiB; headers 16 KiB; URI 4096 bytes |

This profile overrides `DGP_MPU_MAX_PART_BYTES`, `DGP_MPU_MAX_BUFFERED_PARTS`,
`DGP_MAX_MULTIPART_UPLOADS` and `DGP_MAX_TOTAL_MULTIPART_BYTES`; these cannot
enlarge it. Ordinary object-engine
caps remain unchanged. Without native-S3 admission, Create still succeeds but
accepted multipart payload is capped at the lesser of the engine object cap and
`DGP_MPU_DELTA_RECONSTRUCT_MAX_BYTES` (default 64 MiB); the disk profile also
caps this small path at 64 MiB. The next part's remaining allowance is checked
before collection and rechecked under the insertion lock. Unsupported large
uploads are refused at that threshold, not silently stored without the requested
compression/encryption policy. This threshold refusal also applies when the disk
profile is disabled; it replaces the previous above-threshold forced passthrough.
Small/default delta operation is unchanged below the threshold.

Large admission requires a routed **native S3 backend** with encryption `none`,
`sse-s3`, or `sse-kms`, and a passthrough key (such as `.gz`) or bucket compression
disabled. Filesystem/B2 and proxy AES-GCM encryption (including missing-key proxy
configuration) cannot gain large admission. Route, native-SSE and wrapper
integrity policy are frozen together. A later engine reload refuses subsequent
parts/completion of an admitted upload: abort and start a new upload. A completion
already started keeps its admitted target and can finish there; it is never
re-routed in flight. SHA256, MD5, length, part ETags and native-SSE handling remain
in effect. Ordered source files are hashed and read directly; S3 receives
sequential 8 MiB repacked parts without a local complete-object assembly.

**Client constraints:** use Create / UploadPart / Complete / Abort, gzip bytes
unchanged, and preferably 8 or 16 MiB parts (at most 256 parts for an object).
Only one UploadPart per upload may be admitted at a time; two different uploads
can collect bodies concurrently. Handle `503 SlowDown` with bounded retry/backoff.
UploadPartCopy is refused. All S3 PUT/POST requests with `aws-chunked` encoding
or a `STREAMING-*` payload signature are refused **before s3s polls the body**:
its decoder otherwise buffers a declared encoded chunk. Plain HTTP chunked
transfer is supported, as is ordinary SigV4 payload hashing. Configure clients
not to send AWS streaming/trailer checksums (for botocore, request checksum
calculation `when_required` avoids optional trailer checksums; verify the actual
client emits a non-streaming payload signature). Do not disable ordinary
integrity or required upstream encryption to work around refusal. Single PUTs
are also limited to 16 MiB while this profile is on; use multipart for larger
objects. Browser form POST and other S3 POSTs share the 128 KiB envelope.

**Spool prerequisites and accounting:** pre-provision a process-owned mode-0700
real directory with working file locking and no snapshots, hard links or external
writers in the spool. Do not share it across replicas. Owner-approved disk-backed
Kubernetes emptyDir with a 6 GiB sizeLimit and explicit ephemeral-storage resources
is supported under a **shared-node pressure and asynchronous eviction risk
contract**, not a hard filesystem quota. The proxy does not create or verify a
quota. Do not use memory-backed emptyDir. Startup refuses symlinks, insecure
permissions, another lock owner,
failed restart reclamation, insufficient free space, or an allocation quantum
over 64 KiB. It holds `owner.lock` for the store lifetime; never unlink that inode
or edit its `data/` directory while running. Startup reclaims old `data/` only
after exclusive acquisition. Multipart IDs are ephemeral and cannot resume
across restart; clients must restart their upload.

All profile parts go directly to disk after bounded body collection. Writes are
synchronous and serialized by the store write lock: one `incoming.tmp` can be
actively written globally, not two simultaneous disk overwrite copies. Its full
payload is reserved **before** writing, in addition to the old part; successful
rename releases only the old reservation. A write/rename/allocation failure puts
the upload into cleanup-only state, retaining both reservations until deletion.
Up to 32 such failed temporaries remain counted. There is no assembly-file copy
and S3 retries share their `Bytes` payload allocation.

For successfully persisted files, allocated blocks may exceed payload by at most
320 KiB per file (checked before rename). A conservative 4128-file allowance
(4096 parts + 32 temporary slots) adds 1290 MiB over the 4 GiB payload reservation:
5386 MiB. Before each write the proxy checks available space for the incoming
payload plus a 512 MiB reserve. Relative to a 6 GiB sizeLimit, this leaves a
nominal 246 MiB, **not reserved space or an absolute physical ceiling**. Failed
allocations, directory/inode/journal metadata, delayed allocation and filesystem
transients are not bounded by this successful-file arithmetic. Other node users
can consume space between check and write. ENOSPC/allocation refusal is not
success: failed files stay Cleaning with their reservations and upload slots,
saturating admission until deletion succeeds. Verify filesystem accounting and
node capacity before activation. Kubelet sizeLimit and ephemeral-storage limits
are accounting/eviction controls, not synchronous quotas; usage may exceed them
before eviction. Node/inode pressure, other volumes, writable layers and logs can
also evict the pod. Eviction/replacement may discard spool and always loses upload
IDs; clients restart with new IDs. Container restart retaining emptyDir still
requires exclusive lock acquisition before reclamation. Remote incomplete-upload
lifecycle cleanup and ambiguous-completion reconciliation remain necessary.

Two 16 MiB accepted bodies are **not a 32 MiB RSS bound**. The collector Vec may
reserve almost twice its current payload, with old and new allocations briefly
coexisting during growth. Transport frames and s3s hashing are additional.
One large completion holds an 8 MiB remote payload, a 64 KiB relay scratch, a
64 KiB wrapper hash buffer and a 1 MiB engine hash buffer (plus Tokio file-read,
SDK retry/HTTP/TLS/checksum buffers and bounded metadata). SDK uploads are
sequential; retries reuse the same bytes. Small delta completion can still
hydrate/assemble up to the small threshold and invoke the existing codec/cache
paths. Neither this allocation inventory nor a loopback SDK test measures proxy
RSS; validate the operator's complete workload and container memory separately.

**Failure and recovery:** client timeout/disconnect detaches the completion
owner, not its SDK future; an already started completion may still publish.
Expiry, Abort and bucket purge cannot reclaim its files, reservations or permit
until it settles. SDK failures await an abort attempt; SDK calls have finite
operation/attempt timeouts, but there is no whole-object completion deadline.
Do not infer abort success from an HTTP timeout. Failed local deletion keeps
bytes and upload slots and retries on the existing multipart sweeper cadence
(default 300 s); abort reports cleanup pending. Correct permissions/free-space
issues and allow the sweeper to retry. Never manually delete a live owner's files.
A stopped process can be restarted against its exclusive spool to reclaim local
residue, but this does not clean upstream multipart uploads.

Upstream AbortIncompleteMultipartUpload lifecycle cleanup and reconciliation
remain prerequisites: crashes, lost create responses, lost complete responses,
and failed aborts can leave remote parts or an ambiguously committed object.
After a timeout, reconcile the object with HEAD/length/integrity metadata before
re-uploading. Disabling the profile requires draining/quiescing the process and
unsetting the directory variable at restart; arrange explicit cleanup of the
stopped spool, since the disabled profile does not reclaim that configured path.
No live provider/Barman compatibility, deployed-image provenance or rollout
acceptance is implied by this local implementation.

## Replay detection cache

Caches SigV4 signatures and rejects duplicates within the replay window. This is independent of `DGP_CLOCK_SKEW_SECONDS`, which governs how far a request timestamp may drift from the server clock during SigV4 verification — a different check.

| Setting | Default | Env var |
|---------|---------|---------|
| Replay window | 2 s | `DGP_REPLAY_WINDOW_SECS` |
| Clock skew tolerance | 300 s | `DGP_CLOCK_SKEW_SECONDS` |
| Max cache entries | 500,000 | — |

A duplicate of a **mutating** request (PUT/POST/DELETE) within the window is rejected with 400. A duplicate of an **idempotent read** (GET/HEAD) is tolerated and served — boto3 emits byte-identical signatures for the same request within one signing second, and replaying a read re-reads the same bytes. Replay rejections are not counted toward the auth-failure lockout. `DGP_REPLAY_WINDOW_SECS=0` disables replay rejection entirely. When the cache exceeds 500K entries, expired signatures are evicted first.

The native-S3 large-backup profile makes one narrow exception: a completion
rejected with `503 SlowDown` **before acquiring completion ownership** releases
that request's replay entry. A client or HTTP intermediary can retry the same
signed completion without turning capacity rejection into `400 InvalidArgument`.
The completion slot, retained parts and resource limits are unchanged. Successful,
in-flight, cancelled and ambiguously failed storage work retain replay protection;
an arbitrary 5xx response does not grant permission to replay a mutation. Other
admission errors are not covered by this exception. Clients still need bounded
backoff: an intermediary's immediate retries may all encounter the occupied slot.

## S3 backend HEAD concurrency

During LIST operations that require per-object metadata, the proxy issues HEAD requests to the upstream S3 backend. These are limited to avoid triggering the backend's own throttling.

| Setting | Default | Configurable |
|---------|---------|--------------|
| Max concurrent HEADs | 50 | No |

## Summary of all env vars

| Env var | Default | Description |
|---------|---------|-------------|
| `DGP_RATE_LIMIT_MAX_ATTEMPTS` | 100 | Auth failures before lockout |
| `DGP_RATE_LIMIT_WINDOW_SECS` | 300 | Rolling window for failure counting |
| `DGP_RATE_LIMIT_LOCKOUT_SECS` | 600 | Lockout duration after max failures |
| `DGP_TRUST_PROXY_HEADERS` | false | Trust `X-Forwarded-For` / `X-Real-IP` for IP extraction (only behind a reverse proxy) |
| `DGP_CODEC_CONCURRENCY` | cpus*4 (min 16) | Max concurrent xdelta3 processes |
| `DGP_MAX_CONCURRENT_REQUESTS` | 1024 | Max in-flight HTTP requests |
| `DGP_REQUEST_TIMEOUT_SECS` | 300 | Per-request timeout |
| `DGP_MAX_MULTIPART_UPLOADS` | 1000 | Max concurrent multipart uploads outside the fixed disk profile |
| `DGP_MPU_LARGE_SPOOL_DIR` | unset | Opt-in fixed native-S3 disk profile; exclusive pre-provisioned path; restart required |
| `DGP_MPU_MAX_PART_BYTES` | unset | Independent UploadPart body ceiling; disables UploadPartCopy |
| `DGP_MPU_MAX_BUFFERED_PARTS` | unset | Independent UploadPart collector count; disables UploadPartCopy |
| `DGP_CLOCK_SKEW_SECONDS` | 300 | SigV4 request-timestamp drift tolerance |
| `DGP_REPLAY_WINDOW_SECS` | 2 | SigV4 replay detection window (0 disables) |

## Related

- [Authentication and access](authentication.md) — SigV4 verification and replay-detection semantics
- [Configuration](configuration.md) — full env-var registry
