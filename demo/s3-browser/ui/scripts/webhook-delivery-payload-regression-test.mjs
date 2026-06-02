import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Transpile the pure payload helper (no React/antd) to an importable data: URL.
async function loadModule(relPath, fileName) {
  const url = new URL(relPath, import.meta.url);
  const source = await readFile(url, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2020,
      target: ts.ScriptTarget.ES2020,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
    fileName,
  });
  return `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
}

const url = await loadModule('../src/components/webhookDeliveryPayload.ts', 'webhookDeliveryPayload.ts');
const {
  WEBHOOK_REDACTED_SENTINEL,
  DEFAULT_EVENT_DELIVERY,
  normalizeEventDelivery,
  buildEventDeliveryPayload,
} = await import(url);

const SENTINEL = WEBHOOK_REDACTED_SENTINEL;

// ── normalizeEventDelivery: legacy webhook_url folds into the list ──
{
  const norm = normalizeEventDelivery({ webhook_url: 'https://a.example/in', webhook_urls: ['https://b.example/in'] });
  assert.deepEqual(norm.webhook_urls, ['https://a.example/in', 'https://b.example/in'], 'legacy url first, deduped');
}
{
  const norm = normalizeEventDelivery(undefined);
  assert.deepEqual(norm, DEFAULT_EVENT_DELIVERY, 'undefined → defaults');
}
{
  // dedupe: legacy url equal to a list entry must not double.
  const norm = normalizeEventDelivery({ webhook_url: 'https://x.example/h', webhook_urls: ['https://x.example/h'] });
  assert.deepEqual(norm.webhook_urls, ['https://x.example/h']);
}

// ── header DELETE must emit explicit null (RFC 7396) ──
{
  const baseline = normalizeEventDelivery({ webhook_headers: { Authorization: SENTINEL, 'X-Env': SENTINEL } });
  // operator removed X-Env, left Authorization untouched (sentinel).
  const local = { ...baseline, webhook_headers: { Authorization: SENTINEL } };
  const res = buildEventDeliveryPayload(local, baseline);
  assert.ok(res.ok, `expected ok, got ${JSON.stringify(res.errors)}`);
  const h = res.body.event_delivery.webhook_headers;
  assert.equal(h['X-Env'], null, 'removed header must be null (delete)');
  assert.equal(h['Authorization'], SENTINEL, 'untouched header stays sentinel (server preserves)');
  // JSON round-trip must keep the null key.
  const rt = JSON.parse(JSON.stringify(res.body));
  assert.ok('X-Env' in rt.event_delivery.webhook_headers, 'null delete-key must survive JSON.stringify');
}

// ── retyped secret passes through; new secret added ──
{
  const baseline = normalizeEventDelivery({ webhook_headers: { Authorization: SENTINEL } });
  const local = { ...baseline, webhook_headers: { Authorization: 'Bearer NEW', 'X-Trace': 'on' } };
  const res = buildEventDeliveryPayload(local, baseline);
  assert.ok(res.ok);
  assert.equal(res.body.event_delivery.webhook_headers['Authorization'], 'Bearer NEW');
  assert.equal(res.body.event_delivery.webhook_headers['X-Trace'], 'on');
}

// ── legacy webhook_url is always cleared on save ──
{
  const baseline = normalizeEventDelivery({ webhook_url: 'https://legacy.example/h' });
  const local = { ...baseline };
  const res = buildEventDeliveryPayload(local, baseline);
  assert.ok(res.ok);
  assert.equal(res.body.event_delivery.webhook_url, null, 'legacy webhook_url must be cleared');
  assert.deepEqual(res.body.event_delivery.webhook_urls, ['https://legacy.example/h']);
}

// ── enabling with zero endpoints is rejected (usability trap) ──
{
  const baseline = normalizeEventDelivery({});
  const local = { ...baseline, enabled: true, webhook_urls: [] };
  const res = buildEventDeliveryPayload(local, baseline);
  assert.ok(!res.ok, 'enabled + no endpoint must fail');
  assert.ok(res.errors.some((e) => /no endpoint/i.test(e)), 'error should mention no endpoint');
}

// ── duration validation ──
{
  const baseline = normalizeEventDelivery({});
  const ok = buildEventDeliveryPayload({ ...baseline, tick_interval: '30s', retry_max: '5m', delivered_retention: '0s' }, baseline);
  assert.ok(ok.ok, `valid durations should pass, got ${JSON.stringify(ok.errors)}`);
  const bad = buildEventDeliveryPayload({ ...baseline, tick_interval: '30' }, baseline);
  assert.ok(!bad.ok && bad.errors.some((e) => /tick_interval/.test(e)), 'bare number duration rejected');
  const bad2 = buildEventDeliveryPayload({ ...baseline, request_timeout: '5 minutes' }, baseline);
  assert.ok(!bad2.ok, 'prose duration rejected');
}

// ── numeric range validation ──
{
  const baseline = normalizeEventDelivery({});
  const bad = buildEventDeliveryPayload({ ...baseline, batch_size: 0 }, baseline);
  assert.ok(!bad.ok && bad.errors.some((e) => /batch_size/.test(e)), 'batch_size 0 rejected (min 1)');
  const bad2 = buildEventDeliveryPayload({ ...baseline, max_attempts: -1 }, baseline);
  assert.ok(!bad2.ok, 'negative max_attempts rejected');
}

// ── invalid endpoint URL rejected ──
{
  const baseline = normalizeEventDelivery({});
  const res = buildEventDeliveryPayload({ ...baseline, enabled: true, webhook_urls: ['not-a-url'] }, baseline);
  assert.ok(!res.ok && res.errors.some((e) => /not a valid/i.test(e)), 'junk URL rejected');
}

// ── invalid header name rejected ──
{
  const baseline = normalizeEventDelivery({});
  const res = buildEventDeliveryPayload({ ...baseline, webhook_headers: { 'Bad Header': 'v' } }, baseline);
  assert.ok(!res.ok && res.errors.some((e) => /invalid characters/i.test(e)), 'header name with space rejected');
}

console.log('webhook-delivery-payload-regression-test: all assertions passed');
