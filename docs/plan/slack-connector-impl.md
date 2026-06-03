# Slack connector — implementation checklist

Decisions (locked with user): **both** Slack modes (Incoming Webhook URL + `xoxb-`
bot token); **`format` enum on `event_delivery`** (reuse outbox/retry/secret/GUI
pipeline); **user-objects + prefix include/exclude** volume filter. NO OAuth — the
Grafana-core / Sentry-legacy / GitLab-notifications model (paste-a-credential,
works on private instances, outbound HTTPS only).

## Backend (Rust)

### B1. Config — extend `EventDeliveryConfig` (`src/config_sections.rs`)
- `format: EventDeliveryFormat` (enum `Raw | Slack`, default `Raw`,
  `#[serde(rename_all = "lowercase")]`, `JsonSchema`). When `Raw`, behavior is
  unchanged (the existing `{schema,event}` JSON webhook).
- Slack sub-config (flat fields, all optional, secret-bearing ones masked):
  - `slack_bot_token: Option<String>` — `xoxb-…`. SECRET → redact like
    webhook_headers (REDACTED_SENTINEL mask + preserve-on-untouched).
  - `slack_channel: Option<String>` — channel id/name, required in token mode.
  - `slack_username: Option<String>` / `slack_icon_emoji: Option<String>` —
    cosmetic overrides (webhook mode).
  - `slack_include_globs: Vec<String>` / `slack_exclude_globs: Vec<String>` —
    key-prefix filters (reuse `build_globset`).
  - `slack_notify_kinds: Vec<String>` — which EventKinds notify (default
    `["ObjectCreated"]`; operator can add ObjectDeleted etc.).
- Mode is implicit: `slack_bot_token` present → Web API (chat.postMessage);
  else the existing `webhook_url`/`webhook_urls` (pointed at hooks.slack.com) →
  Incoming Webhook. `is_active()` already requires an endpoint OR (new) a token.
- Validation (`validate_event_delivery`): when `format=slack` + token mode,
  require `slack_channel`; warn if both token and a non-slack webhook URL set;
  validate globs compile; validate notify_kinds are known EventKinds.

### B2. Redaction + preserve (mirror webhook_headers, already the pattern)
- `redact_all_secrets` (`config.rs`): mask `slack_bot_token` →
  `Some(REDACTED_SENTINEL)`.
- `preserve_event_delivery_secrets` (`config/mod.rs`): if incoming
  `slack_bot_token == sentinel` → restore old. Extend the existing fn; both
  section-PUT and document-apply paths already call it. Add unit cases.

### B3. Slack message formatter (`src/event_delivery/slack.rs`, pure + tested)
- `fn slack_message(event: &EventOutboxRecord, cfg) -> serde_json::Value` →
  Block Kit: a header (`📦 New file` / `🗑️ Deleted` per kind), a section with
  `*bucket*/`key`` + size (humanized from payload.content_length) + storage_type
  + a short etag, and a context line with the ISO timestamp. Plus a `text`
  fallback (for notifications/screen readers — accessibility) so the message is
  legible without Block Kit rendering.
- `fn should_notify(event, include, exclude, kinds) -> bool` — pure: kind in
  `notify_kinds` AND `is_user_object_key(key)` AND glob include/exclude pass.
  Unit-tested truth table.
- Emoji/title per `EventKind` (Created/Deleted/Copied/Lifecycle*).

### B4. Delivery (`HttpWebhookDeliveryClient::deliver`, `event_delivery.rs`)
- Early: if `should_notify` is false for a Slack-format config → return `Ok(())`
  (consume the event silently; not every object notifies). Filtering happens at
  delivery so the outbox/cursor accounting is unchanged.
- Branch on `format`:
  - **Raw**: existing path unchanged.
  - **Slack + bot token**: POST `https://slack.com/api/chat.postMessage`,
    `Authorization: Bearer <token>`, body `{channel, text, blocks}`.
    **CRITICAL**: Slack Web API returns HTTP 200 even on failure — parse the JSON
    body and treat `{"ok": false, "error": "..."}` as a delivery error (so retry
    fires). A `{"ok": true}` is success.
  - **Slack + webhook URL** (no token): POST each `hooks.slack.com` endpoint with
    `{text, blocks, username?, icon_emoji?}`; 2xx = success (webhooks don't
    return the ok-envelope).
- Keep the per-endpoint retry/backoff/attempts machinery as-is.

### B5. Tests
- Unit (`event_delivery/slack.rs`): `slack_message` shape (header/section/text
  fallback present; size humanized; bucket/key escaped), `should_notify` truth
  table (kind filter, user-object filter, include/exclude globs).
- Unit (config/mod): preserve restores masked `slack_bot_token`.
- Integration (`event_delivery` test or a new one): a mock Slack endpoint
  (existing `EventDeliveryClient` trait is mockable — there's a test client) —
  assert chat.postMessage `{ok:false}` is treated as failure → retried; webhook
  2xx is success; a filtered-out key produces no POST.

## Frontend (GUI) — the "neat designed card"

### F1. Format toggle in WebhookDeliveryPanel
- A segmented control / radio at the top of the panel: **Raw webhook** |
  **Slack**. Switching to Slack reveals the Slack card and hides the raw-header
  editor (headers don't apply to Slack mode).

### F2. SlackConnectorCard (new, the designed piece)
A self-contained card with a guided, accessible layout:
- **Mode sub-toggle**: "Incoming Webhook (simplest)" | "Bot token (multi-channel
  + @mentions)". Each shows a 2-3 step mini-guide inline:
  - Webhook: "1. Create a Slack app → 2. Enable Incoming Webhooks → 3. Paste the
    `hooks.slack.com/…` URL." + the URL field (reuses the endpoint row editor).
  - Bot token: "1. Create app → 2. Add `chat:write` + `chat:write.public` scopes
    → 3. Install → 4. Paste the `xoxb-` token + channel." + masked token field
    (reuses the secret-mask UX from the header editor) + channel field.
  - A link to Slack's app-create page and (nice-to-have) a "copy app manifest"
    button that gives a pre-filled minimal manifest (scopes preset) so setup is
    one paste on Slack's side.
- **Filters** (collapsible "What gets posted"): notify-on kinds (Created/Deleted
  checkboxes), include/exclude prefix rows (reuse the endpoint row editor).
- **Cosmetics** (collapsible): username, icon emoji.
- **Live preview**: render a faux Slack message from the current settings (a
  styled card mimicking Slack's layout: 📦 header + `bucket/key` + size) so the
  operator sees what lands in the channel before saving. Pure client-side from
  the form state.
- Validation inline (token required-with-channel; at least one endpoint-or-token
  when enabled; globs well-formed).
- Heavy doc affordance: each field has the FormField yamlPath breadcrumb + help;
  a top-of-card callout explains "No OAuth needed — paste a credential. Works on
  private/internal instances (outbound HTTPS only)."

### F3. Payload + types
- Extend `webhookDeliveryPayload.ts`: `format`, slack fields, `slack_bot_token`
  sentinel-preserve (mirror header secret), glob/kind arrays, validation.
- Node regression test: slack-mode payload (token sentinel passthrough, channel
  required, webhook-vs-token mode selection, glob nulls).

## Docs
- `docs/` page or section: "Slack notifications" — both modes, the no-OAuth
  rationale (cite the works-on-private-instances property), the manifest, the
  filter knobs, example YAML. Add a screenshot of the card.
- Update `deltaglider_proxy.example.yaml` `event_delivery` block with a
  commented `format: slack` example.

## Gate
- cargo fmt + clippy -D warnings + test --lib + the new integration test.
- frontend lint + tsc + knip + build + node regression.
- config schema regenerates (new enum/fields) — verify CI "Config JSON Schema".
- Local: restart-with-prod-backup, configure Slack webhook against a test
  hooks.slack.com URL (or a request-bin), PUT an object, confirm a formatted
  message is delivered + filtered keys are skipped.
