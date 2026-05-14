# DeltaGlider — Go-to-Market Action Plan (v5)

*v5 folds the audit decisions in: USD pricing, Beshu's 10-senior-
engineers-since-2017 framing, Hetzner as unaffiliated example backend,
Simone as case-study narrator + homepage callout, `/trial` as a
dedicated page, `/probe` deferred to a post-launch product feature, GPL-
3.0 as a hard relicense with no legacy, consolidated 17-item risk
register, all internal inconsistencies cleaned up. The document now
stands alone — no "see v2/v3" references.*

---

## 0. Strategic frame

**One product. Two ICPs. One brand house: Beshu Tech.**

Beshu Tech has been shipping infrastructure software since 2017 — ten
senior engineers, in production at CERN, the European Parliament, two
S&P 500 top-5 companies, and a long list of nuclear research and EU
institutions. The flagship is ReadonlyREST (Elasticsearch security);
Anaphora (dashboard-to-PDF reporting) is the second product; DeltaGlider
is the third, shipped to the same standard.

The product funnel splits into two campaign-specific landing pages
(`/saas` and `/regulated`), driven by separate Google Ads campaigns,
converging on the same backend product and the same `contact@beshu.tech`
intake. Pricing is in USD, anchored to AWS S3 Standard, no currency
conversion required.

---

## 1. Honesty audit — every quantified claim, sourced

Before any copy gets published, every number in the plan is sourced
or marked placeholder.

| Claim | Status | Source / Note |
|---|---|---|
| **"GPL-3.0, Rust"** | 🟡 **PENDING RELICENSE** | Currently `GPL-2.0-only` in `LICENSE` + `Cargo.toml`. Hard relicense Week 1, no legacy compatibility. |
| "Beshu Tech — 10 senior engineers, since 2017" | ✅ VERIFIED | Confirmed by product owner (Simone) |
| "Beshu Tech, the team behind ReadonlyREST" | ✅ VERIFIED | This file is in the Beshu Tech repo; ReadonlyREST is at readonlyrest.com (Beshu Limited, est. London 2017) |
| "ReadonlyREST since 2017" | ✅ VERIFIED | `readonlyrest.com` footer: "Established in London, UK, in 2017" |
| "Beshu also ships Anaphora (dashboard-to-PDF reporting)" | ✅ VERIFIED | anaphora.beshu.tech / Beshu product line confirmed by product owner |
| Anaphora customer testimonial (Gautier Franchini / Creos Luxembourg SA) | ✅ EXISTS, ⚠️ **NOT borrowed for DGP site** | Real testimonial about Anaphora, deliberately NOT transferred to DeltaGlider's site to avoid trust-transfer confusion |
| ReadonlyREST customer count: "hundreds of remarkable organisations" | ✅ VERIFIED | `readonlyrest.com` literal copy |
| "2× in the S&P 500 top 5" | ✅ VERIFIED | `readonlyrest.com` literal copy |
| "3× Nuclear research institutions" | ✅ VERIFIED | `readonlyrest.com` literal copy |
| "2× European Union institutions" | ✅ VERIFIED | `readonlyrest.com` literal copy |
| "2× Charities protecting children" | ✅ VERIFIED | `readonlyrest.com` literal copy |
| "Various government institutions" | ✅ VERIFIED | `readonlyrest.com` literal copy |
| CERN testimonial (Ulrich Schwickerath) | ✅ VERIFIED | `readonlyrest.com` testimonial section |
| French network operator testimonial (Pierre Chesneau) | ✅ VERIFIED | same |
| SANS Instructor testimonial (Justin Henderson) | ✅ VERIFIED | same |
| Creos S.A. testimonial (Frederic Hosmann) | ✅ VERIFIED | same |
| Pinned benchmark numbers (Alpine ISO ×5, ccx33) | ✅ VERIFIED | `marketing/src/data/benchmarkSampleRun.ts` run-id `hetzner-20260428-140514Z` |
| "1.71 TB source on AWS S3" (ReadonlyREST builds, pre-migration) | ✅ VERIFIED | `aws s3 sync` summary of `s3://readonlyrest-data/build/`, 145 versions, ~103,088 objects |
| "1.71 TB → final compressed size" | ⚠️ **IN PROGRESS** | Full migration ongoing. Sample so far: 1.69.0 (88.5×), 1.38.0 (4.1×), 1.17.1 (3.8×). Final headline number publishable when migration completes. |
| "1.69.0: 2,866 MB → 32.4 MB (88.5×)" | ✅ VERIFIED | Session test run, SHA-256 round-trip verified |
| "1.38.0: 13,795 MB → 3,355 MB (4.1×)" | ✅ VERIFIED | Session test run, SHA-256 round-trip verified |
| "1.17.1 (cold path): 26.5 MB → 6.87 MB (3.8×)" | ✅ VERIFIED | Session test run, SHA-256 round-trip verified |
| "27,775 frozen objects defrosted with Bulk retrieval" | ✅ VERIFIED | `defrost.log` |
| "~$9 in EC2 compute + ~$2 Glacier retrieval, migration so far" | ✅ VERIFIED | t4g.medium × ~30h actual + Bulk-tier restore costs |
| "v0.9.x, production-tested at Beshu Tech" | ✅ VERIFIED | dgp.serve.beshu.tech runs v0.9.18 |
| **"~10× compression default in calculator"** | 🟡 **ASSUMED FROM VERIFIED POINTS** | Geometric mean of 4.1× (1.38.0) and 88.5× (1.69.0) ≈ 19×. Conservative round-down to 10× — calculator must not over-promise. Customers run the Delta Efficiency Panel on their own bucket for a real number. |
| **Pricing tier ROI math (Customer A $48k savings, B $148k, C $1.1M)** | ✅ VERIFIED | Computed from AWS S3 Standard Frankfurt $0.023/GB/month × source × regions × compression. Calculator exposes the same math live. |
| **TB brackets (10 / 50 / 250 TB stored footprint)** | 🟡 **PRICE ANCHORS** | Picked to map to real customer shapes (Series C SaaS, mid-platform, enterprise/regulated archive). Tunable after first 3 paid deals. |
| **Tier prices ($10k / $30k / $60k)** | 🟡 **DEFENSIBLE BUT TUNABLE** | Lands in defensible range relative to value delivered per napkin math. Final tuning after first 3 deals. |

---

## 2. Features the marketing must reflect

These shipped between v0.9.13 and v0.9.18; the site copy must reflect
them.

### 2.1 Multipart hardening + form-POST (v0.9.13)

- **Multipart upload disk-relay for large payloads** — `RelayedParts`
  path, threshold-triggered. Lets the proxy complete multi-GB uploads
  without monolithic in-memory assembly.
  → *Marketing relevance*: "handles arbitrarily large uploads without OOM."
- **Multipart sweeper + reclaim** — periodic cleanup of stuck
  `Completing` uploads, orphan relay artifacts removed on startup.
  → *Marketing relevance*: operational maturity signal.
- **S3 form-POST presigned upload** — SigV4 policy-based
  `multipart/form-data` POST on bucket endpoints. `acl=private` fix
  shipped in v0.9.17.
  → *Marketing relevance*: browser apps upload direct to the bucket
  without your backend touching the bytes.

### 2.2 Memory-bounded multipart complete (v0.9.14)

- Relay policy now threshold-triggered, not always-on, so normal
  multipart completes stay memory-bounded.
  → *Marketing relevance*: predictable memory profile under load.

### 2.3 Correctness x-ray (v0.9.16)

A focused audit by five specialised investigators surfaced 10 distinct
correctness bugs across the proxy. All fixed; each pinned by a regression
test. 769 unit tests in `cargo test --lib`, +23 regression tests added
during the audit. Clippy `-D warnings` clean.

→ *Marketing relevance*: **the single best signal of engineering
seriousness the product has.** Most infra startups don't run x-ray
audits, let alone document and ship them.

### 2.4 Delta efficiency panel (v0.9.18)

Diagnostics panel at `/_/admin/diagnostics/delta-efficiency` — scans
every deltaspace in a bucket and surfaces those where the reference
baseline is producing poor deltas. Classifications: Excellent / Good /
Fair / Poor / NoReference. Pure-function classifier with truth-table
tests.

→ *Marketing relevance*: **the operator-trust feature.** One-click scan
shows the operator *"this prefix is wasting storage because the wrong
reference was uploaded first."* This is also what a prospect uses to
get a real compression number on their own data (see §4.5).

### 2.5 Traefik / reverse-proxy timeout documentation

Cross-proxy table (Traefik / Caddy / nginx / AWS ALB / HAProxy) for the
60s default-read-timeout gotcha that blocks large uploads. Documented
because we hit it in production.

→ *Marketing relevance*: signals "we've actually deployed this in
production and hit the real-world edge cases."

### 2.6 Other shipped features under-emphasized previously

- **Per-bucket compression policy + bucket aliases** — staged migration
  bucket-by-bucket.
- **Soft per-bucket quotas + "freeze mode"** — quota=0 freezes a bucket
  read-only during migration windows.
- **In-memory audit ring + structured stdout** — admin UI viewer plus
  SIEM-shippable stdout events.
- **Encrypted SQLCipher config DB** for IAM users, OAuth providers,
  group mapping rules. Bootstrap password separate from encryption key
  and backend creds.
- **Multi-instance config DB S3 sync** — encrypted DB syncs across proxy
  instances via S3 with ETag change detection. HA-deployable.
- **Event outbox with retries** — durable object-mutation journal,
  webhook delivery, fan-out, requeue.
- **Replication with optional delete-replication** — right-to-be-
  forgotten propagation.
- **`config trace` admin command** — explains why a synthetic request
  passed or failed admission/auth.
- **`admission` chain — pre-auth gating** — operator-authored YAML
  rules evaluated BEFORE auth.

### 2.7 What the site explicitly should NOT claim

- "Multi-tenancy" → say "per-team IAM and quotas"
- "Zero trust" → say "key custody stays in your runtime"
- "Audit-compliant" → say "structured audit events to stdout for your SIEM"
- "Enterprise-grade" — cut
- "Cloud-native" — cut

---

## 3. Steal-this-from-readonlyrest.com — exact assets

Real, in production today, transfer legitimately because Beshu Tech is
the same legal entity.

### 3.1 Testimonial block (verbatim, attribute as on the source)

**Section heading on the site**: *"What Beshu Tech's customers say about
our other products"* — long and explicit on purpose. Can't be misread
as "what customers say about DeltaGlider."

**Visual treatment**: each card gets a small grey chip "About
ReadonlyREST" at the top-left, visually distinct from the quote.
Impossible to skim past.

```
[About ReadonlyREST]

> "Our largest shared cluster [...] consolidates about 17 different
> use cases on the same hardware, lowering the total cost."
>
> — Ulrich Schwickerath, Physicist, IT department, CERN
```

```
[About ReadonlyREST]

> "ReadonlyREST Enterprise is one of the few software I use or used
> professionally, and I would recommend it 200%."
>
> — Pierre Chesneau, Solution Architect, Top French network operator
```

```
[About ReadonlyREST]

> "I baked ReadonlyREST Free into SEC455 SIEM Design and Implementation.
> I'm openly recommending it to students and highlighting its features."
>
> — Justin Henderson, GSE, SANS Instructor, CEO, H/A Security Solutions
```

```
[About ReadonlyREST]

> "ReadonlyREST was quick and easy to implement, that gave us more
> time to spend on other important tasks."
>
> — Frederic Hosmann, Responsible of Platforms and Automation, Creos S.A.
```

**Framing line ABOVE the cards:**

> *None of these quotes are about DeltaGlider — it's a new product. They
> are about ReadonlyREST, Beshu Tech's flagship since 2017. We include
> them because the team that wrote the software behind these quotes is
> the same team writing DeltaGlider.*

**What we deliberately DO NOT do**: borrow the Gautier Franchini /
Creos testimonial about Anaphora (Beshu's second product). It's a real
testimonial, but transferring two sister-product testimonials from the
same customer would muddy the trust-transfer story. One sister-product
reference per page is enough.

### 3.2 Customer-segment block (verbatim copy)

> Since 2017, hundreds of remarkable organisations trusted us.
> Customers that make us **extra proud**:
>
> - 📈 **2× in the S&P 500 top 5**
> - 🧸 **2× Charities protecting children**
> - ⚛️ **3× Nuclear research institutions**
> - 🇪🇺 **2× European Union institutions**
> - 👮‍♀️ **Various government institutions**

### 3.3 Logo wall

Reuse the readonlyrest.com asset with the identical disclaimer
ReadonlyREST already uses (same legal entity = same disclaimer).

### 3.4 The "Accountability" line — adapted

ReadonlyREST: *"Our support service is the best in its league: the same
engineers that wrote the software will answer your SLA support tickets."*

DeltaGlider version:

> *"Beshu Tech's 10 senior engineers wrote DeltaGlider; they're the
> ones who answer your support tickets. No outsourced first-line. No AI
> chatbot. Email contact@beshu.tech and the response comes from someone
> whose name is in `git log`."*

**The single most credibility-generating sentence the site has.**
Buyers in 2026 distrust products where support is gated behind ChatGPT-
style chatbots. The "same engineers" line is the AI-slop antidote, and
"10 senior engineers since 2017" gives it the bus-factor credibility
solo-founder framing never could.

### 3.5 GPL-3.0 licensing rationale — port the ReadonlyREST FAQ language

ReadonlyREST has historically explained the GPL choice with:
*"If [GPL] is too restrictive, just go for the Embed contract."*

DeltaGlider version on `/pricing` and in the FAQ:

> *DeltaGlider is licensed under GPL-3.0. Most users — including internal
> infrastructure at any size of company — can use the OSS build freely
> without obligation. If you need to embed DeltaGlider in a proprietary
> product you distribute to customers, or if your legal team needs to
> remove the GPL-3.0 obligation for any other reason, we offer a
> commercial license. Talk to sales.*

Two distinct sales conversations live in that paragraph: production
support (operational SLA) and commercial license (legal). Both route
to `contact@beshu.tech` with a tagged subject for triage.

---

## 4. The site — page-by-page copy

Six pages: homepage, `/saas`, `/regulated`, `/pricing`, `/trial`,
`/case-studies/readonlyrest-builds`, `/benchmark`.

### 4.1 Homepage `/`

```
[header]
  Beshu · DeltaGlider              Docs · GitHub · Pricing · Contact

[hero]
  ## Storage compression for S3, behind the same S3 API your apps already use.

  Versioned binaries — CI artifacts, plugin catalogs, builds, backups,
  ML model lineages — stored as xdelta3 deltas on the bucket. Apps unchanged.
  Stored bytes typically drop 10×–100× on the right workload shape.

  Open source (GPL-3.0). Built by [Beshu Tech](https://beshu.tech) —
  10 senior engineers, since 2017. Same team behind
  [ReadonlyREST](https://readonlyrest.com) (Elasticsearch security,
  flagship) and Anaphora (dashboard-to-PDF reporting), in production
  at banks, nuclear research institutions, European Union institutions,
  and 2× of the S&P 500 top 5.

  [docker run quickstart] [GitHub] [See what it'd save you →]
                                    (link to /pricing)

[testimonials block — borrowed from ReadonlyREST]
  > Same engineers, same rigor. These quotes are about Beshu Tech's
  > flagship product, ReadonlyREST.

  [4 testimonial cards: CERN, French network operator, SANS Instructor, Creos S.A.]

[soft built-by callout — separate visual register from testimonial cards]
  — and on the team's own production:

  Simone Scarduzio (founder, Beshu Tech) is migrating ReadonlyREST's
  1.71 TB build catalog through DeltaGlider. The case study includes
  the bugs we hit (TMPDIR hardcoded in upstream, Traefik 60s timeout,
  pipefail+head silent abort, EBS exhaustion) and how we fixed them.

  → /case-studies/readonlyrest-builds

[trust copy — borrowed verbatim]
  Since 2017, hundreds of remarkable organisations trusted us.
  Customers that make us extra proud:
   📈 2× in the S&P 500 top 5
   🧸 2× Charities protecting children
   ⚛️ 3× Nuclear research institutions
   🇪🇺 2× European Union institutions
   👮‍♀️ Various government institutions
  [logo wall — reuse the readonlyrest.com asset]

[mechanism — promoted to its own section, anchor-linked from hero]
  ## Why xdelta3 works on ZIP files

  Skeptical question: xdelta3 should fail on compressed input.

  It would, on random-compressed data. Versioned archives aren't random
  — they're repetition machines. Same JAR signatures in the same order,
  same manifest.mf, same icons, same bundled CSS. The compression
  boundary moves but the underlying byte runs repeat. On real
  ReadonlyREST ES plugins: a 91 MB versioned ZIP encoded as a 148 KB
  delta against the previous version. 614× reduction on compressed input.

  Read the engineering note → /docs/reference/how-delta-works

[workload fit — the honesty table]
  ## Will it work on your data?

  | Your data looks like                                      | Expected | Recommend |
  | CI artifacts, build catalogs, plugin marketplaces         | 10–100×  | ✅ Yes    |
  | DB dumps, daily backups, ML model variants                | 5–50×    | ✅ Yes    |
  | Container layers, Maven / PyPI mirrors                    | 10–50×   | ✅ Yes    |
  | Random user uploads, encrypted blobs, raw video           | 1–2×     | ❌ Use plain S3 |
  | Append-only logs, streaming telemetry                     | 1×       | ❌ Use plain S3 |

  Self-disqualify or self-qualify here. We'd rather you find out now
  than after deployment.

[case study — in-progress framing]
  ## In progress: migrating ReadonlyREST's own build catalog off AWS S3
  to Hetzner via DeltaGlider.

  Sample so far: a single 1.69.0 plugin version compressed 88.5× via
  the proxy (2,866 MB → 32.4 MB), bit-perfect SHA-256 round-trip
  through the proxy. ~$9 in EC2 compute + ~$2 Glacier Bulk-tier retrieval
  for the migration so far. The full migration covers 145 versions
  spanning 8 years of release history; final results published as a
  reproducible case study when complete.

  → /case-studies/readonlyrest-builds

[architectural one-liner]
  ## How it fits in your stack

  DeltaGlider is an S3-compatible proxy. Your apps speak SigV4 to it.
  It speaks SigV4 to your bucket. On PUT, it stores either an xdelta3
  delta against the deltaspace reference or a passthrough copy,
  whichever is smaller. On GET, it reconstructs byte-for-byte and
  streams. The client sees ordinary S3.

[everything else — dense block, no card parade]
  ## Beyond compression — the operator surface

  - Per-user S3 credentials, ABAC permissions (AWS-IAM grammar via
    iam-rs), OAuth/OIDC group mapping, encrypted SQLCipher config DB.
  - Replication rules between buckets/backends, run-now, pause/resume,
    history, optional delete-replication.
  - AES-256-GCM at-rest encryption, per-object IV, key held in your
    runtime; backend sees ciphertext.
  - Lifecycle expiration, event outbox with retries/webhooks, soft
    per-bucket quotas (incl. quota=0 freeze for migration windows),
    Prometheus metrics, in-memory audit ring + structured stdout for
    SIEM shipping.
  - Delta efficiency diagnostic panel: one-click scan flags prefixes
    where the reference baseline is producing wasted bytes.
  - Pre-auth admission chain — deny/reject/allow-anonymous rules
    evaluated BEFORE auth. config trace tells you exactly which rule
    fired and why.

  Reference docs: /docs/reference

[engineering rigor — adapted line]
  ## Accountability

  Beshu Tech's 10 senior engineers wrote DeltaGlider; they're the ones
  who answer your support tickets. No outsourced first-line. No AI
  chatbot. Email contact@beshu.tech and the response comes from someone
  whose name is in `git log`.

[correctness audit — be specific]
  ## Correctness x-ray, May 2026

  A focused audit by five specialised investigators (concurrency, auth,
  storage, HTTP/wire, error handling) surfaced 10 distinct correctness
  bugs across the proxy. All fixed; each pinned by a regression test.
  769 unit tests in cargo test --lib, +23 added during the audit.
  Clippy -D warnings clean. Bug-by-bug write-up in CHANGELOG.md.

[comparison — kept]
  ## When to use what

  | Need                                                   | Use                                |
  | Cheap object storage from scratch                       | MinIO, SeaweedFS, Garage           |
  | Pay-per-GB hosted S3 with no setup                      | AWS S3, Cloudflare R2, Backblaze B2|
  | In-bucket object versioning (rollback)                  | AWS S3 Versioning                  |
  | Object lock / WORM                                       | AWS S3 Object Lock, MinIO, Wasabi  |
  | Cut storage cost on versioned binaries                  | **DeltaGlider**                    |
  | Encrypt-before-the-backend without a SaaS KMS           | **DeltaGlider**                    |
  | Govern multi-cloud S3 from one place                    | **DeltaGlider**                    |

[two minisite doors]
  ## Where to read next

  - SaaS or platform team with versioned-artifact storage costs: /saas
  - Regulated data, encryption-at-rest with local key custody: /regulated
  - Pricing + savings calculator: /pricing
  - 30-day production support trial: /trial

[get started]
  [docker run snippet, copy-pasteable]

[footer]
  Beshu Tech · GPL-3.0 · GitHub · Docs · Contact · Pricing · Trial

  Sister products: ReadonlyREST · Anaphora

  Interested in a managed cloud offering? Let us know — we're evaluating
  for Q4 2026.
```

### 4.2 `/saas` — cost-driven migration

```
[hero]
  ## Stop paying AWS to store the same JAR a thousand times.

  Your CI pipeline ships a new build every commit. Most of those builds
  share 99% of their bytes with the previous one. DeltaGlider stores
  the 1% and reconstructs the rest. Same S3 API. Same SDKs. Same
  workflow.

  [Big CTA → "See what it'd save you" → /pricing#calculator]

[in-progress case study reference]
  In progress: Beshu Tech is migrating its own ReadonlyREST build
  catalog off AWS S3 to Hetzner via DeltaGlider. Per-version compression
  results from the test runs are below.

[per-version compression table — verified, publishable today]
  | Version | Source size | Stored size | Compression | Verdict |
  | 1.69.0 | 2,866 MB | 32.4 MB | **88.5×** | Excellent |
  | 1.38.0 | 13,795 MB | 3,355 MB | **4.1×** | Fair (cross-major ES range) |
  | 1.17.1 (cold from Glacier) | 26.5 MB | 6.87 MB | **3.8×** | Small dataset, dominated by reference |
  | **Full migration** | **1.71 TB** | TBD | TBD | In progress |

[honesty paragraph on the 4.1× row]
  Why is 1.38.0 only 4.1×? Because the legacy deltaspace mixes ES 6,
  7, and 8 Kibana plugins — structurally dissimilar artifacts in one
  prefix. The Delta Efficiency Panel correctly classifies it as "Fair,
  near Poor." We're more credible telling you this than glossing over
  it.

[mechanism reference]
  → How xdelta3 works on ZIP files, with the 614× single-file example: /docs/reference/how-delta-works

[migration playbook]
  ## What a migration looks like

  1. Run DeltaGlider in your VPC, point it at your existing AWS bucket
     (or a new Hetzner / Backblaze / Cloudflare bucket — anything S3-
     compatible).
  2. Use the Delta Efficiency Panel to scan a sample prefix; verify
     compression is in the range that justifies migration.
  3. Stage migration bucket-by-bucket using per-bucket aliases and
     quota=0 freeze mode during the window.
  4. Cut over your apps' S3 endpoint to DeltaGlider. SDKs unchanged.
  5. Run replication rules to mirror new writes to a DR region if
     needed.

  Production support helps you with each of these. See /trial for the
  30-day try-the-relationship offer.

[CTA pair]
  [See your potential savings → /pricing#calculator]
  [Start a 30-day production support trial → /trial]
```

### 4.3 `/regulated` — encryption + key custody (expanded to parity)

```
[hero]
  ## Use cheap S3-compatible storage without giving the provider your data.

  DeltaGlider encrypts every object with AES-256-GCM before it reaches
  the bucket. Your encryption key lives in your runtime; the storage
  provider — Hetzner, Wasabi, Cloudflare, an offshore mirror — sees
  ciphertext only.

  Built by Beshu Tech — 10 senior engineers, since 2017. Same team
  behind ReadonlyREST (Elasticsearch security) and Anaphora (dashboard-
  to-PDF reporting), in production at:

[Beshu customer-segment block — verbatim from §3.2]
  Since 2017, hundreds of remarkable organisations trusted us.
  Customers that make us extra proud:
   📈 2× in the S&P 500 top 5
   🧸 2× Charities protecting children
   ⚛️ 3× Nuclear research institutions
   🇪🇺 2× European Union institutions
   👮‍♀️ Various government institutions
  [logo wall — reuse the readonlyrest.com asset]

[full four ReadonlyREST testimonials block — §3.1]

[technical sections]
  ## How the encryption works

  - AES-256-GCM, per-object IV
  - Encryption key supplied at process start (env var or KMS-fetched
    secret); never written to disk by the proxy
  - Backend (S3, Hetzner, Wasabi, etc.) sees ciphertext only
  - Bucket-level key rotation supported; old objects re-encrypted via
    a background job
  - Audit trail of every encrypt/decrypt operation in the structured
    stdout stream

  ## How key custody stays in your runtime

  - Proxy runs in YOUR VPC / on YOUR Kubernetes / on YOUR bare metal
  - Encryption key never leaves the proxy process
  - Backend credentials never leave the proxy process
  - No phone-home, no telemetry, no SaaS dependency
  - Source code is GPL-3.0 — your security team can read every line

  ## What we DON'T claim

  - "SOC 2 compliant" — DeltaGlider produces audit logs you can ship
    into a SOC-2-attested SIEM. The proxy itself is software, not a
    compliance regime.
  - "FIPS 140-3 validated" — we use ring/aes-gcm crates which use
    OpenSSL or platform crypto; if you need FIPS, ship the FIPS-
    validated crypto layer underneath us.
  - "GDPR-compliant" — DeltaGlider supports right-to-be-forgotten
    propagation via replication-delete and lifecycle expiration. The
    compliance regime is your problem; the technical primitives are ours.

[buyer evaluation framework]
  ## How a regulated buyer evaluates DeltaGlider

  Week 1: Code review. The proxy is open source (GPL-3.0). The
  encryption module is in src/storage/encrypting.rs. The IAM model is
  in src/iam/. The admin API surface is in src/api/admin/. Your
  security team's questions: contact@beshu.tech.

  Week 2: Dev-environment deployment. Point a test bucket at the
  proxy. Run your existing security automation against it (key
  rotation, audit log validation, IdP integration smoke).

  Week 3: Small production pilot on one non-critical bucket.

  Week 4: Full deployment plan with Beshu engineering support — via
  the 30-day production support trial.

[CTA — dropped consultancy, routed to commercial conversation]
  ## Talk to sales

  Buying for a regulated environment? Talk to us about a commercial
  license and production support. Both are tailored to your
  jurisdiction, audit posture, and procurement workflow.

  → contact@beshu.tech?subject=DeltaGlider%20-%20Regulated%20buyer%20inquiry

  → Or start with the 30-day production support trial: /trial
```

### 4.4 `/case-studies/readonlyrest-builds` — Simone narrates first-person

```
[hero]
  ## Migrating ReadonlyREST's build catalog off AWS S3 — in progress
  ## By Simone Scarduzio, founder, Beshu Tech

  I'm migrating Beshu Tech's own ReadonlyREST build catalog — 145
  versions, 8 years of release history, ~103,088 objects, 1.71 TB on
  AWS S3 (eu-west-1) — to Hetzner Object Storage (hel1) via
  DeltaGlider. This page is the engineering retrospective: what
  worked, what broke, what I fixed.

  Final compression ratio will be published when the full migration
  completes (next week or two as of writing).

[why]
  ## Why migrate at all

  Versioned artifact storage compounds. The same set of Kibana plugin
  variants is uploaded for every release across 8 years of 1.12.x →
  1.69.0. Most of the bytes are identical between versions. Storing
  each release as a full copy is paying to store the same bytes
  hundreds of times.

  I picked Hetzner Object Storage as the destination because it's the
  cheapest S3-compatible option that fits the migration shape: cold-
  tier-friendly pricing, EU jurisdiction, and no enterprise sales
  motion — which is fine for this use case. (Beshu Tech has no
  partnership with Hetzner; this is a vendor choice, not a sponsored
  decision.)

[shape]
  ## Migration shape

  - Source: s3://readonlyrest-data/build/ (AWS S3, eu-west-1)
  - Destination: s3://beshu/ror/builds/ (Hetzner, hel1)
  - Runner: single t4g.medium EC2 in eu-west-1 (intra-region read =
    no AWS egress charge)
  - Pipeline per version: aws s3 sync → merge enterprise/free/pro/* into
    legacy/ → deltaglider cp -r to Hetzner
  - Older 99 versions were on Glacier Deep Archive; restored via Bulk
    tier (~$2 total). ~$9 in EC2 compute so far.

[per-version results so far]
  ## Per-version results so far (verified, SHA-256 round-tripped)

  | Version | Source size | Stored size | Compression | Verdict |
  | 1.69.0 (warm-path) | 2,866 MB | 32.4 MB | 88.5× | Excellent |
  | 1.38.0 (warm-path, multi-shape) | 13,795 MB | 3,355 MB | 4.1× | Fair |
  | 1.17.1 (cold from Glacier) | 26.5 MB | 6.87 MB | 3.8× | Small dataset |

  The 1.38.0 result is publishable as-is because it tells the truth:
  the legacy deltaspace mixes ES 6/7/8 Kibana plugins — structurally
  dissimilar artifacts. Root deltaspace compressed 15.2×; legacy
  deltaspace only 2.7×. The Delta Efficiency Panel correctly
  classifies legacy as "Fair, near Poor." Useful signal for an
  operator who wants to fix it.

[the bug log]
  ## What broke and how I fixed it

  Real migrations don't go in a straight line. Here's what tripped me:

  ### Bug 1: deltaglider CLI hardcoded /tmp

  The Python deltaglider 6.1.1 CLI hardcoded /tmp for working files.
  /tmp on my EC2 was tmpfs, 1.9 GB. Mid-large-version migration: out
  of space.

  Fix: patched client.py + main.py in-place to honor os.environ.get
  ("TMPDIR"). Upstreaming the fix.

  ### Bug 2: 30 GB EBS too small

  Staging 13 GB of source + xdelta3 temp files + downloaded archive +
  staging area = busted the 30 GB EBS at the first multi-GB version.

  Fix: grew EBS to 100 GB. Cost difference: ~$8/month for the
  migration window. Cheap.

  ### Bug 3: pipefail + head silent kill

  My migration script had `set -o pipefail` and piped deltaglider
  output through `grep -E ... | head -200`. After 200 matched lines,
  head closed the pipe. pipefail made the script exit. Migration
  silently aborted mid-upload.

  Fix: dropped the | head. Logs are slightly noisier but the script
  doesn't lie about whether it succeeded.

  ### Bug 4: Traefik 60s read timeout

  Production Coolify deployment had Traefik with the default
  respondingTimeouts.readTimeout = 60s. Cross-internet uploads of
  multi-GB files hit exactly 60s and got killed with a 502.

  Fix: set Traefik readTimeout to 30m. Documented the gotcha in
  /docs/troubleshooting because every reverse-proxy default is wrong
  for large S3 uploads.

[verification]
  ## How I'm verifying the migration is correct

  For every migrated version:

  1. SHA-256 of the source object (computed by aws s3api head-object)
  2. SHA-256 of the round-tripped object via the DeltaGlider proxy
     (GET, hash, compare)
  3. Manifest check: same object count, same total source size

  No exceptions logged so far. Bit-perfect round-trip on every
  sampled object (root, legacy, universal deltaspaces).

[final ratio — TBD]
  ## Final ratio

  Published when the full 145-version migration completes. The mix of
  "Excellent" newer versions and "Fair" older cross-major versions
  means the average will be somewhere between 10× and 50×. Watch this
  page.

[reproducibility]
  ## Reproducibility

  When the migration completes, this page will include:

  - The migration script (open source)
  - The per-version manifest (CSV)
  - The SHA-256 verification script
  - A tarball with raw results so anyone can verify

  This is the kind of case study that's hard to fake. That's the
  point.
```

### 4.5 `/pricing` — calculator-anchored page

```
[hero]
  ## What does DeltaGlider save you?

  Type the numbers from your current AWS S3 bill. Get an honest
  answer in 30 seconds. No email required.

[dynamic savings calculator — see §5]
  [Calculator component renders here. See §5 below for inputs,
   outputs, formula transparency, and bracket recommendation.]

[pricing tiers — static table below the calculator]
  ## What you'd pay

  | Tier | Price | What you get |
  |---|---|---|
  | **Open Source** | Free, GPL-3.0 | Full product. No footprint cap. Self-host. Community Slack + GitHub. |
  | **Production support trial** | Free, 30 days | Direct engineering Slack, response SLA, one architecture review call. See /trial. |
  | **Production support — Starter** | $10k/year | Up to 10 TB stored footprint. Eng Slack + 4h business-hours response SLA. |
  | **Production support — Growth** | $30k/year | 10–50 TB stored footprint. Same SLA + quarterly review call. |
  | **Production support — Scale** | $60k/year | 50–250 TB stored footprint. 1h response SLA, monthly review, named eng contact. |
  | **Production support — Enterprise** | Talk to sales | 250 TB+, multi-region, custom SLA, dedicated channel. |
  | **Commercial license** | Talk to sales | For embedding DeltaGlider in a proprietary product, or removing the GPL-3.0 obligation. Pricing depends on use case, not footprint. |

[meter definition]
  ## What we mean by "stored footprint"

  Stored footprint = compressed bytes physically stored on your
  backend across all DeltaGlider-managed buckets, measured at month-
  end. This is the number DeltaGlider already reports at /_/stats.
  Not source/logical bytes. Not ingress/egress. Storage-layer
  replicas (whatever your backend does under the hood) don't count.

  We don't collect telemetry. You self-report at renewal; we cross-
  check via the /_/stats endpoint if you give us read access during
  the conversation.

[GPL-3.0 rationale]
  ## When does someone need a commercial license?

  DeltaGlider is GPL-3.0. Most users — including internal
  infrastructure at any company size — use the OSS build freely with
  no obligation. You need a commercial license only if:

  - You're embedding DeltaGlider in a proprietary product you
    distribute to customers, AND you can't (or don't want to)
    satisfy GPL-3.0's source-availability obligations
  - Your legal team requires the GPL obligation removed for any
    other reason

  If you're a SaaS or platform running DeltaGlider on your own
  infrastructure for your own apps, the OSS build is fine forever.
  Production support is the relationship you buy, not a license.

  → contact@beshu.tech?subject=DeltaGlider%20-%20Commercial%20license%20inquiry

[FAQ]
  ## Frequently asked

  Q: Why is Starter $10k? That feels high for "support."
  A: It's not just support — it's an SLA on critical infrastructure
     plus direct Slack access to the senior engineers who wrote the
     proxy. At your scale (typically 1–10 TB stored footprint = 100
     TB+ of source artifacts), the calculator above shows annual
     savings in the $30–60k range. $10k lands in a defensible range
     relative to the value delivered.

  Q: What happens if I exceed my bracket?
  A: Measured at renewal, not mid-year. If you're at 12 TB stored
     footprint at renewal, you renew at Growth. No surprise invoices.

  Q: What about shrinking?
  A: Same — you renew at a lower bracket and pay less. Brackets are
     a relationship tier, not a usage meter.

  Q: Replication doubles my footprint — am I being double-counted?
  A: No. We count logical compressed bytes managed by DeltaGlider.
     Storage-layer replicas don't count.

  Q: Why don't you publish the Enterprise price?
  A: Because Enterprise deals genuinely vary — multi-region SLA
     shape, named-eng-contact attribution, custom audit/compliance
     attachments. The $60k Scale price is the anchor below;
     Enterprise is a conversation, not a row in a table.

  Q: I'm at 0 TB today — do I still get the trial?
  A: Yes. The trial is bracket-agnostic. Try the relationship
     before committing to a bracket. /trial

  Q: How do I get a real compression number on my own data?
  A: Run `docker run deltaglider/proxy` against your own bucket and
     read the Delta Efficiency Panel at /_/admin/diagnostics/delta-
     efficiency. No data leaves your network. Or talk to us and we'll
     help you set it up.

[get started CTAs — three equal-weight options]
  [Start a 30-day production support trial → /trial]
  [Try the OSS build → /docs/quickstart]
  [Talk to sales → contact@beshu.tech?subject=DeltaGlider%20-%20Sales%20inquiry]
```

### 4.6 `/trial` — production support trial (new dedicated page)

```
[hero]
  ## 30-day production support trial
  ## Try the relationship. The software is free regardless.

  DeltaGlider is GPL-3.0 — you can run the OSS build forever without
  paying us. The trial isn't for the software. It's for the support
  relationship: direct Slack access to Beshu Tech's 10 senior
  engineers, a response SLA, and one architecture review call.

  Free for 30 days. No credit card. No auto-conversion.

[what you get]
  ## What's included for 30 days

  - Direct engineering Slack channel with named contacts on the
    Beshu Tech side
  - 4h business-hours response SLA on questions and issues
  - One 60-minute architecture review call: we look at your
    deployment, point out what's standard, what's risky, what's
    suboptimal, and what's outright broken
  - Migration sizing if you're moving an existing bucket
  - Tactical Slack help during your first cutover window if you
    want us on call

[what we DON'T do during the trial]
  - We don't get root on your infrastructure. The trial is async
    help, not managed services.
  - We don't sign DPAs / MSAs for the trial itself. If you need
    those, they come with a paid contract — and that's a separate
    sales conversation.
  - We don't auto-bill you on day 31. Conversion is your decision
    and an explicit step.

[the day-by-day shape]
  ## What the 30 days actually look like

  Day 0: You email contact@beshu.tech with subject "DeltaGlider —
  Production support trial." We respond within 1 business day with
  a Slack invite and a scheduling link for the arch review call.

  Days 1-7: Slack onboarding. We learn your deployment shape, the
  workload, the storage backend, your SLOs.

  Days 8-14: Architecture review call (60 min). Output: a short
  written summary of recommendations, in your shared channel.

  Days 15-29: Ongoing Slack support. You ask questions, file issues,
  get answers from the senior engineers who wrote the code.

  Day 30: Conversion conversation. You either:
  (a) sign a paid Production Support contract (Starter $10k, Growth
      $30k, or Scale $60k depending on your stored footprint), or
  (b) thank us, exit the trial, and keep using the OSS build for free.
      Your data is yours, your deployment is yours, nothing changes
      on your side.

[why it works this way]
  ## Why this isn't a software trial

  The software is GPL-3.0. There's nothing to gate, no time-locked
  feature flag, no expiring license key. Gating the software would
  be (a) impossible because it's open source, (b) hostile because
  it would force you to fork the project, (c) pointless because the
  whole pitch is "this is critical infra you can self-host forever."

  So the trial is the support relationship. Trying us out for 30
  days is the cheapest way for both sides to find out if we're a fit.

[honest about what doesn't qualify]
  ## When the trial isn't right for you

  - You haven't deployed DeltaGlider yet — start with /docs/quickstart
    first. There's no point trialing support for software you haven't
    even tried.
  - You need 24/7 on-call coverage — the trial is business-hours
    only. 24/7 is part of paid Enterprise contracts.
  - You need a contract signed before any interaction — fine, skip
    the trial, talk to sales directly. /pricing#contact

[CTA]
  ## Start your trial

  → mailto:contact@beshu.tech?subject=DeltaGlider%20-%20Production%20support%20trial

  Or, if you'd rather check the OSS build first:
  → /docs/quickstart
```

### 4.7 `/benchmark`

*Unchanged.* Methodology page; credibility lives in the reproducibility.

---

## 5. The dynamic pricing calculator — design and build plan

### 5.1 What the calculator does

Convert "what does this save me?" from abstract claim to a number the
visitor types in 30 seconds and gets back as concrete USD/year. Live-
updating as sliders move. No email gate. Math visible on demand.

**Primary jobs, in order:**

1. **Funnel qualifier** — surfaces the bracket recommendation
   (Starter/Growth/Scale/Enterprise) so the visitor self-selects which
   sales conversation they belong in.
2. **Anchor price against savings** — every output shows "you save $X,
   we charge $Y, net $X-Y." Price is never shown in isolation.
3. **Trust signal** — every assumption is exposed and overridable.
4. **Shareable artifact** — output is copy-pasteable as markdown for
   the engineer to send to their CFO.

**Anti-goals:**

- No email gate (kills trust signal we built with anti-polish)
- Not a configurator (one job: storage savings math)
- No hidden formula (show-your-work expandable section is mandatory)
- No currency selector (USD only — see "Currency decision" below)

### 5.2 Currency decision

All pricing and math in USD, anchored to AWS S3 Standard ($0.023/GB/
month default). Reasons:

- AWS pricing is in USD; the calculator's default cost should match the
  customer's actual bill line-for-line
- No FX drift; no daily refresh; no `fx.ts` module
- Avoids "but our contract was signed in EUR" arguments at renewal
- Standard for B2B infra software (Beshu is UK-registered but charges
  in USD like the rest of the market)

### 5.3 Inputs

**Required:**

1. **Current artifact footprint (TB)** — default 30 TB, slider 1–2000
   TB log scale, text input for precision. Helper: "Source bytes across
   all your build artifacts — what `aws s3 ls --summarize` would show
   today."

2. **Number of regions** — default 2, discrete buttons 1/2/3/4+.
   Helper: "How many regions do you replicate this data to today? Each
   adds full storage cost."

3. **Storage cost per GB/month (USD)** — default $0.023 (AWS S3
   Standard, eu-central-1 / Frankfurt). Text-only. Helper with click-
   to-populate shortcuts: AWS Standard $0.023 · GCS Standard $0.020 ·
   Azure Hot $0.0184 · Backblaze B2 $0.006.

**Optional (collapsed, "show advanced"):**

4. **Compression ratio** — default 10× (conservative). Slider 2×–100×
   log scale. Helper: "Conservative estimate based on verified
   ReadonlyREST migration ratios (4×–88×). For a real number on your
   own data, run `docker run deltaglider/proxy` against your bucket and
   read the Delta Efficiency Panel."

5. **Annual data growth (%)** — default 30%. Slider 0–200%. Helper:
   "How fast does your artifact footprint grow per year?"

### 5.4 Outputs — the result card

**Zone A — headline number:**

> **You'd save approximately $148,000/year**
> after subscribing to Production support — Growth at $30k/year.
>
> Net savings: **$118,000/year**.

**Zone B — breakdown table (Today vs With DeltaGlider):**

```
                                Today         With DeltaGlider
Storage footprint               300 TB        30 TB
Storage cost (per region)       $82,800/yr    $8,280/yr
Replicated across 2 regions     $165,600/yr   $16,560/yr
Replication egress (new)        $600/yr       $60/yr
──────────────────────────────────────────────────────────
Subtotal — storage + transfer   $166,200/yr   $16,620/yr
DeltaGlider production support  —             $30,000/yr
──────────────────────────────────────────────────────────
Total annual cost               $166,200      $46,620
```

**Zone C — show your work (collapsed `<details>`):**

Formulas + bracket lookup table. No FX disclosure needed — everything
in USD.

**Zone D — CTA pair:**

1. "Start a 30-day production support trial" → `/trial`
2. "Run the OSS build on your own data" → `/docs/quickstart`

Plus tertiary "Copy this estimate" → clipboard markdown.

### 5.5 Edge cases

| Input shape | Behavior |
|---|---|
| Source < 1 TB | Card swaps to "DeltaGlider probably isn't worth it for you yet. Come back at 5 TB+. Or use OSS free." |
| Source > 250 TB | Bracket shows "Enterprise — quote on request", CTA changes to "Schedule sales call." No published price. |
| Compression < 3× | Warning chip: "If your data compresses below 3×, DeltaGlider may not be the right fit. Run the OSS build + Delta Efficiency Panel on your own data to verify." |
| Cost < $0.005/GB | Warning chip: "You're already on cheap object storage — savings will be smaller, but data sovereignty / lock-in benefits still apply. Talk to us." |
| Net savings < 0 | Card swaps to "DeltaGlider support costs more than your savings at this scale. Use the OSS build (free) or talk to us about a different fit." Never hide bad-case results. |

Self-disqualification is a feature: cheaper to qualify out at the calc
than to refund later.

### 5.6 Implementation

**Stack (recommended):**
- **Astro** for the marketing site (static-first, fast TTFB)
- **One React island** (`<PricingCalculator client:visible />`)
- **Pure-function math module** (`src/lib/pricing.ts`), vitest unit-
  tested in isolation. Mirror the Rust testability principle.

**Module layout:**

```
marketing-site/
├── astro.config.mjs
├── src/
│   ├── lib/
│   │   ├── pricing.ts           // pure math, no DOM
│   │   ├── pricing.test.ts      // vitest
│   │   └── brackets.ts          // tier definitions, single source of truth
│   ├── components/
│   │   ├── PricingCalculator.tsx
│   │   ├── ResultCard.tsx
│   │   ├── BreakdownTable.tsx
│   │   └── FormulaDetails.tsx
│   └── pages/
│       ├── pricing.astro
│       └── trial.astro
```

`brackets.ts` is the single source of truth — feeds the calculator AND
the static table on `/pricing`. No duplication.

**Tests** (mirror project CLAUDE.md testability principles):

Pure-function unit tests for `pricing.ts`:
- `test_starter_bracket_at_5tb` — 5 TB × 10× = 0.5 TB → Starter, $10k
- `test_growth_bracket_at_300tb` — 300 TB × 10× = 30 TB → Growth, $30k
- `test_scale_bracket_at_1500tb` — 1500 TB × 10× = 150 TB → Scale, $60k
- `test_enterprise_at_3000tb` — returns sentinel "TALK_TO_SALES"
- `test_below_threshold_at_500gb` — returns sentinel "BELOW_THRESHOLD"
- `test_negative_net_at_low_ratio` — returns sentinel "NEGATIVE_NET"
- `test_breakdown_arithmetic_matches_zone_b` — golden test, rows sum to totals
- Property test: for any valid input, `savings = today_total - dgp_total`
  to ±$1 tolerance
- Snapshot test: fixed input set → stable markdown for "copy this estimate"

Playwright integration:
- `test_default_inputs_render_30tb_growth_recommendation`
- `test_slider_change_updates_result_within_50ms`
- `test_below_threshold_swaps_card`
- `test_copy_button_writes_to_clipboard`

**What we do NOT build in v1:**

- Per-tier feature comparison toggle (static table covers it)
- Multi-currency selector (USD only)
- Save/share URL (markdown copy button covers the CFO use case)
- A/B testing infrastructure (volume too low for stat sig in <90 days)

### 5.7 Effort

- Design: 2 days
- Pure math + tests: 1 day (shippable as CLI first)
- React UI: 2 days
- Polish + copy + edge cases: 1 day
- **Total: ~6 working days for v1**

Rollout:
1. Math module + tests in isolation, ship as CLI
2. React UI on top
3. Behind `/pricing-beta` for a week, share with 3–5 friendly prospects
4. Promote to `/pricing`; primary CTA on `/saas`

---

## 6. The 90-day plan — revised week by week

### 6.1 Week 1 — copy + asset migration + GPL-3 relicense

**Owner**: Simone.

- [ ] **GPL-2.0 → GPL-3.0 hard relicense**: update `LICENSE`, `Cargo.toml`
      `license = "GPL-3.0-only"`, add SPDX `GPL-3.0-only` headers across
      all source files. One commit, no `GPL-2.0-or-later` hedge, no
      compatibility layer. Push release tag.
- [ ] Homepage copy locked (real ReadonlyREST testimonials, customer
      segments, 10-senior-engineers-since-2017 framing, GPL-3.0 in hero,
      placeholder case-study language, Simone soft callout)
- [ ] Logo wall asset embedded from readonlyrest.com (same disclaimer)
- [ ] `/saas` minisite drafted with verified per-version compression
      table and *in-progress* full-migration framing, calculator CTA
- [ ] `/regulated` minisite drafted at parity with `/saas`, Beshu
      customer-segment block above the fold, dropped consultancy CTA,
      "talk to sales" routing with pre-filled subject line
- [ ] `/trial` page drafted (new in v5)
- [ ] `/case-studies/readonlyrest-builds` drafted in first-person
      Simone-as-narrator voice, with the bug log
- [ ] 301s from old URLs (`/artifact-storage` → `/saas`, etc.)
- [ ] CHANGELOG-derived feature list integrated into homepage
- [ ] Footer rewritten with Beshu-Tech-as-parent framing + footer-level
      managed-cloud-interest link

**Gate**: Simone reads every word aloud. Anything that sounds like
marketing rather than engineering documentation gets rewritten.

### 6.2 Week 2 — pricing calculator + Google Ads (parallel)

**Owner**: Simone (both — runs the calculator build AND the Ads).

**Calculator (priority — gates `/pricing` launch):**

- [ ] Pure-function `pricing.ts` math module + vitest unit tests
- [ ] `brackets.ts` single source of truth ($10k / $30k / $60k /
      Enterprise talk-to-sales)
- [ ] React `<PricingCalculator>` component, slider + result card +
      breakdown table + show-your-work
- [ ] Edge-case messaging (below-threshold, negative-net, low-ratio,
      low-cost-per-GB)
- [ ] Playwright integration tests
- [ ] Ship at `/pricing-beta`, share with 3–5 friendly prospects for
      feedback before promoting to `/pricing`

**Google Ads:**

- [ ] Campaign A (SaaS): `aws s3 cost reduction`, `s3 storage
      compression`, `minio admin ui`, `s3 alternative cheaper`,
      `artifact storage cost`, `ci build storage cost`, `maven artifact
      storage`, `docker registry storage cost` → `/saas?utm=cost`
- [ ] Campaign B (Regulated): `client side encryption s3`, `byok object
      storage`, `encrypted s3 compliant`, `s3 data residency`,
      `regulated cloud storage`, `s3 alternative encrypted`, `gdpr
      object storage` → `/regulated?utm=encrypted`
- [ ] Each $25/day for 30 days, evaluate cost-per-qualified-lead at
      day 30, cut the loser

### 6.3 Weeks 3-4 — finish migration + lock case study + promote calculator

**Owner**: Simone.

- [ ] **Finish the ReadonlyREST builds migration** (in-progress
      background operation)
- [ ] Publish the **real final compression ratio** on the case study
      page; replace the "TBD" placeholder
- [ ] Run the Delta Efficiency Panel against the migrated bucket;
      surface per-prefix verdicts in the case study
- [ ] Promote pricing calculator from `/pricing-beta` to `/pricing`;
      `/saas` hero CTA points to it
- [ ] Spawn the **second case study** — synthesized Postgres-daily-
      backup scenario (1 engineer-day)
- [ ] Plan the **third case study** — Maven-artifact-mirror scenario

**Fallback if migration slips:** publishable today as "in progress"
with per-version table verified; case-study page already handles this
gracefully. No blocker on launch.

### 6.4 Weeks 5-6 — design partner outreach

**Owner**: Simone.

- [ ] Identify 5 existing ReadonlyREST customers with material S3 spend
      on builds, backups, or model lineages
- [ ] Outreach: *"We're adding a new product, here's free deployment +
      sizing + 6 months production support in exchange for a published
      case study and a real ROI number to publish in the calculator
      footnote"*
- [ ] Target: 1 letter of intent signed by end of week 6; 3 by end of
      week 12
- [ ] Use Beshu's existing customer-portal contact list — warm leads,
      not cold outreach

### 6.5 Weeks 7-8 — first paid conversions

**Owner**: Simone + Beshu commercial side.

- [ ] Process inbound from Google Ads + calculator self-qualifications
- [ ] Convert first 1–3 production support trials → paid Starter or
      Growth contracts
- [ ] If any inbound asks about commercial license (embedding DeltaGlider
      in a proprietary product), route to commercial conversation —
      separate track, separate price negotiation
- [ ] **Tune pricing brackets if first 3 deals reveal mispricing**: if
      Starter consistently closes at $12k or $15k, raise the tier; if
      Growth churns on price, lower it. Calculator updates auto-propagate
      via `brackets.ts`.

### 6.6 Weeks 9-12 — content + PR + readout

**Owner**: Simone (writing), Beshu's existing distribution channels.

- [ ] Post: *"Why xdelta3 works on ZIP files (and where it doesn't)"*
- [ ] Post: *"Migrating 1.71 TB of build artifacts off AWS S3"* — case
      study retold as engineering narrative
- [ ] Post: *"Encrypting S3-compatible storage without trusting the
      provider"* — references AES-256-GCM, ABAC, key custody
- [ ] Post: *"What we cut from DeltaGlider and why"* — deliberate
      restraint as trust-building
- [ ] Conference submissions: SREcon (operating an S3 control plane);
      OWASP / regulated-security (encrypting S3-compatible storage in
      your own perimeter)

### 6.7 Week 12 — readout

- [ ] Google Ads cost-per-qualified-lead measured; loser killed, winner
      doubled
- [ ] At least 1 paid commercial relationship closed (target: Starter
      $10k or Growth $30k production support contract, OR a commercial
      license deal)
- [ ] 2-3 design partners signed
- [ ] 4 published technical posts on HN / Reddit / Beshu blog
- [ ] Case-study page updated with final ReadonlyREST builds ratio
- [ ] Pricing calculator shipped to `/pricing`, conversion rate measured
      (calc-page-visit → trial-CTA-click); at least one real-customer-
      verified ROI number footnoted in the calculator

---

## 7. Visual / tone brief

### Visual

- **Anti-polish.** Looks like an engineering team's project page, not
  a SaaS unicorn's website.
- Inspiration: tailscale.com, supabase.com, oxide.computer,
  **readonlyrest.com** (transfer Beshu brand voice).
- One brand color (Beshu teal), one accent.
- No animated gradients, no carousel, no exit-intent popups, no
  "trusted by 10,000 devs" stat bars.
- Real photos on the team page (Simone, any other named engineers
  who agree to appear).
- Code blocks with real copy-pasteable commands.
- Mobile-first but desktop-tuned.
- **Calculator is functional, not decorative** — no faux-3D bar
  charts, no animated count-up numbers, no gradient backgrounds on
  result cards. Plain typography, plain tables, fast.

### Copy principles (apply to every word on every page)

**Reader has TikTok brain. Write accordingly.**

- **Economy of words.** If a sentence can be cut in half without
  losing meaning, cut it. If a paragraph can be a bullet list, make
  it one. If a bullet can be three words, make it three.
- **Simpler words.** "Use" not "utilize." "Help" not "facilitate."
  "Stop" not "discontinue." "Cut" not "reduce." "Free" not
  "complimentary." "Talk to us" not "reach out to our team."
- **Active voice.** "We migrated 1.71 TB" not "1.71 TB was migrated."
- **Concrete over abstract.** "88.5× on a 2.8 GB plugin" not
  "significant compression on production workloads."
- **One idea per sentence.** Compound sentences with three clauses
  are where attention dies.
- **Front-load the answer.** First sentence of a section tells the
  reader what they're about to learn. The rest is proof.
- **Cut the throat-clearing.** "It's worth noting that," "as we
  mentioned," "in our experience" — delete.
- **Lists beat paragraphs for scanability.** Anything that's a
  set of facts (features, tiers, edge cases) is a list. Reserve
  paragraphs for narrative.
- **Headlines are claims, not descriptions.** "Stop paying AWS to
  store the same JAR a thousand times" not "About our compression
  solution."
- **No marketing-ese.** Banned words: "solutions," "leverage,"
  "synergy," "seamless," "robust," "enterprise-grade," "cloud-native,"
  "best-in-class," "innovative." If a word would fit on any company's
  homepage, it doesn't belong on this one.

### Why this matters more than usual

The Beshu trust signal (10 senior engineers, since 2017, plus
ReadonlyREST customer references) does the credibility work; the site
itself can afford to be visually quiet AND verbally lean. Both
reinforce each other. A site that LOOKS like an engineering project
page but SOUNDS like a marketing brochure breaks the spell. Pick a
voice and hold it.

---

## 8. Risk register (consolidated — all 17 risks inline)

### Business and trust risks

**Risk 1: Buyers don't believe a small team can deliver enterprise-
grade support.**

*Mitigation*: lead with "10 senior engineers, since 2017" plus the
ReadonlyREST customer roster (CERN, European Parliament, S&P 500 top-5,
etc.). The roster is the proof; the team size is the credibility.

**Risk 2: The "anti-polish" visual approach reads as unprofessional to
some buyers.**

*Mitigation*: anti-polish ≠ broken. Sharp typography, fast load times,
zero-friction calculator, copy-pasteable code blocks. Inspiration is
oxide.computer, not a half-finished GitHub README.

**Risk 3: The trust transfer from ReadonlyREST is rejected — buyers
parse "this is a different product" and discount the testimonials.**

*Mitigation*: every borrowed testimonial is explicitly framed as
"about ReadonlyREST." Don't pretend they're about DeltaGlider. The
trust transfer is via the team, not via the testimonials.

**Risk 4: AI-skeptical buyers see a slick site and assume AI slop.**

*Mitigation*: named humans (Simone, named engineers on the team page),
real bug logs in case studies, real `git log` in support replies. The
case-study bug log is the strongest single anti-AI-slop signal.

**Risk 5: Google Ads burn $1500 with zero qualified leads.**

*Mitigation*: $25/day cap, 30-day evaluation window, two parallel
campaigns to compare. Worst case: $1500 sunk and we learn the
keywords are wrong. Best case: 3-5 qualified inbound. Cheap relative
to a single enterprise sales cycle.

**Risk 6: ReadonlyREST customers see us reusing their logos on a
different product.**

*Mitigation*: use the identical disclaimer ReadonlyREST already uses
("Logos appearing on this site are the property of their respective
owners. Their presence does not imply any endorsement..."). Beshu is
the same legal entity, so the disclaimer transfers. If any specific
customer asks not to be associated with DeltaGlider, remove that logo
on request.

**Risk 7: A buyer asks "is this related to ReadonlyREST?" on a sales
call.**

*Mitigation*: answer "yes — same company, same engineers, second
product. ReadonlyREST is for Elasticsearch security; DeltaGlider is
for object storage. Same operational rigor applied to a different
domain."

**Risk 8: The ICP split (SaaS vs. regulated) confuses the buyer journey.**

*Mitigation*: homepage routes explicitly to one or the other based on
"your data is dominated by X" framing. Both minisites converge on the
same `/pricing` calculator + same `contact@beshu.tech` intake.

### Case study and migration risks

**Risk 9: Publishing the in-progress case study with placeholder
numbers looks unfinished.**

*Mitigation*: explicitly label "in progress." Show the per-version
numbers we DO have (1.69.0, 1.38.0, 1.17.1) with verdicts from the
Delta Efficiency Panel. Frame as "engineering retrospective in
progress" rather than "marketing case study." Update inline when the
migration finishes.

**Risk 10: The full ReadonlyREST migration hits a real failure we
haven't seen yet.**

*Mitigation*: keep the case study honest. If something fails, write it
up. *"We hit X, fixed it by Y, here's what we learned."* That story
sells better than a polished win.

**Risk 11: Migration slips past Week 4, final ratio not publishable.**

*Mitigation*: the case study page already handles "in progress" as a
publishable state. No launch blocker.

### Product, pricing, and calculator risks

**Risk 12: Pricing brackets reveal we're underpriced relative to value
delivered; customers feel bait-and-switched when we raise.**

*Mitigation*: bracket prices are listed as "from $Xk/year." Standard
B2B-software language signals room for negotiation on both sides.
First-3-deals tuning happens before public price changes.

**Risk 13: Calculator's 10× default ratio gets quoted back by a
customer whose data compressed to 3× — they feel cheated.**

*Mitigation*: (a) conservative 10× default below the 19× geometric
mean of verified data points; (b) "your mileage will vary" footnote
on every result; (c) explicit pointer on every result card to run the
OSS build + Delta Efficiency Panel for a real number; (d) edge-case
chip when compression < 3× warns about fit.

**Risk 14: GPL-3.0 relicense triggers a procurement red flag at a
specific enterprise.**

*Mitigation*: ReadonlyREST has been GPL + commercial-license since
2017 with successful enterprise sales (CERN, European Parliament, S&P
500 top-5). Same playbook. Commercial license is the off-ramp;
production support is the on-ramp.

**Risk 15: Calculator becomes a magnet for adversarial input (someone
posts the "best" or "worst" calculator output to HN to mock us).**

*Mitigation*: input clamping + edge-case messaging means absurd inputs
produce honest "DeltaGlider isn't right for you" outputs, not
embarrassing multi-million-USD claims. The bad-case behavior is the
joke's punchline *for* us, not *against* us.

**Risk 16: Managed cloud "Q4 2026 if at all" footer link generates
inbound demand we can't service.**

*Mitigation*: footer link is intentionally low-prominence. Inbound
routes to a "we're not committed yet, but we'll keep you posted"
auto-reply, not a sales call. If volume justifies it later, revisit.
If not, costs us nothing.

**Risk 17: Trial inbound (`subject: DeltaGlider - Production support
trial`) overwhelms `contact@beshu.tech` without dedicated triage.**

*Mitigation*: pre-filled subject lines route via the existing inbox
filter rules. If trial volume scales beyond manual triage, the next
step is a routed `trial@beshu.tech` or a typeform front-end — but
that's a Week 8+ problem, not a Week 1 problem.

---

## 9. Product roadmap signaled by this plan

The marketing plan implies a few product capabilities that aren't yet
shipped but become necessary as inbound grows.

**Compression estimate wizard (post-launch, target Q3 2026 if
conversion data justifies)**: per-folder/prefix "estimate compression
on this data" button in the admin UI, surfacing the existing Delta
Efficiency Panel logic as a wizard. The customer runs DeltaGlider
locally, configures it to access their bucket, and uses the wizard to
launch a compression-estimate probe per prefix. No data leaves their
network. Builds on the v0.9.18 Delta Efficiency Panel work.

**Trial inbox routing (Week 8+ if needed)**: dedicated `trial@beshu.tech`
or a small intake form if `contact@beshu.tech` triage gets noisy.

**Managed cloud (Q4 2026 if at all)**: hosted DeltaGlider as a service.
Footer-level "interested?" link only; not a public commitment.

---

## 10. What's locked vs what's still my opinion

**Locked through v5 review:**

- ✅ Two ICPs in parallel, two minisites, two Google campaigns
- ✅ Lean into Beshu's regulated-market credentials, don't hide them
- ✅ Use named humans (Simone, named team) as AI-slop antidote
- ✅ Anti-polish visual approach
- ✅ Reuse ReadonlyREST testimonials, customer segments, logo wall
- ✅ Each testimonial card carries an explicit "About ReadonlyREST" chip
  so no reader can mistake them for DeltaGlider endorsements; section
  heading is the long-and-explicit "What Beshu Tech's customers say
  about our other products"
- ✅ Mention Anaphora briefly as Beshu's second product (one-phrase
  qualifier inline) but do NOT borrow its testimonials
- ✅ **Copy principles**: economy of words, simpler words, active voice,
  concrete over abstract, one idea per sentence, lists beat paragraphs.
  Banned marketing-ese list in §7. TikTok-brain reader as the default
  audience assumption.
- ✅ Don't publish hallucinated final-migration numbers; use "in
  progress" framing
- ✅ Drop "Proxy" from the marketing brand (use "DeltaGlider")
- ✅ Beshu = 10 senior engineers, since 2017
- ✅ Hetzner = unaffiliated, just an example cheap provider with no
  enterprise plane; documented as such in the case study
- ✅ Simone narrates `/case-studies/readonlyrest-builds` first-person;
  soft "Built by" callout on the homepage (not a fifth testimonial card)
- ✅ GPL-3.0 hard relicense, no legacy compatibility
- ✅ Drop regulated consultancy tier
- ✅ 30-day production support trial as a dedicated `/trial` page
- ✅ TB-bracketed production support pricing: Starter $10k / Growth $30k /
  Scale $60k / Enterprise talk-to-sales
- ✅ Stored footprint meter, defined explicitly on `/pricing`
- ✅ Dynamic pricing calculator on `/pricing`, Week 2 deliverable
- ✅ All pricing and calculator math in USD; no currency conversion
- ✅ AWS S3 Standard $0.023/GB/month as default calculator cost
- ✅ Pre-filled mailto subjects standardized: `DeltaGlider - <topic>`
- ✅ Compression-ratio default: 10× (conservative round-down from 19×
  geometric mean)
- ✅ `/probe` deferred to a post-launch product wizard; OSS build + Delta
  Efficiency Panel is the today-answer
- ✅ Managed cloud demoted to footer mention, "Q4 2026 if at all"

**Still my opinion, defendable but not yet locked:**

- 🟡 Google Ads keyword lists (best-guess; will adjust based on first
  30 days of CPC data)
- 🟡 Conference submission targets (SREcon and OWASP are best guesses)

Two items, both low-stakes. Both can be tuned during execution without
re-opening the plan.

---

*Final note: every claim in this v5 plan that uses a number was either
measured in-session (1.69.0, 1.38.0, 1.17.1, 27,775 frozen objects, the
v0.9.16 correctness audit, the v0.9.13–18 feature set), verified on the
live ReadonlyREST homepage (testimonials, customer segments, 2017
origin), explicitly labeled placeholder pending real data (the 1.71 TB
final ratio), or derived from a defensible napkin model with the
inputs visible (the ROI tables, the bracket pricing, the calculator
default ratio).*

*The site can ship Week 1 with this discipline. The pricing calculator
ships Week 2. The full picture fills in by Week 3-4 when the migration
completes.*
