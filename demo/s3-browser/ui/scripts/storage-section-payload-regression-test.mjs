import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Transpile a TS module to an importable data: URL. The three payload
// modules are pure (no React / antd) so they import directly. They DO
// import `../storagePath` (also pure), so we resolve that dependency by
// transpiling it too and rewriting the import specifier to the data URL.
async function transpile(relPath, fileName) {
  const url = new URL(relPath, import.meta.url);
  const source = await readFile(url, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2020,
      target: ts.ScriptTarget.ES2020,
    },
    fileName,
  });
  return outputText;
}

function dataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

// storagePath is the only runtime dependency the payload modules pull in.
const storagePathUrl = dataUrl(await transpile('../src/storagePath.ts', 'storagePath.ts'));

async function loadPayloadModule(relPath, fileName) {
  let out = await transpile(relPath, fileName);
  // Rewrite the bare `../storagePath` specifier to the transpiled data URL.
  out = out.replace(/(['"])\.\.\/storagePath\1/g, JSON.stringify(storagePathUrl));
  return import(dataUrl(out));
}

const bucket = await loadPayloadModule(
  '../src/components/bucketPolicyPayload.ts',
  'bucketPolicyPayload.ts'
);
const lifecycle = await loadPayloadModule(
  '../src/components/lifecyclePayload.ts',
  'lifecyclePayload.ts'
);
const replication = await loadPayloadModule(
  '../src/components/replicationPayload.ts',
  'replicationPayload.ts'
);

// ───────────────────────────────────────────────────────────────────
// BucketsPanel — buildBucketPayload
// ───────────────────────────────────────────────────────────────────
const { buildBucketPayload, freshId, policyToRow } = bucket;

// (1) Synthetic ids are unique + monotonic, and NEVER appear in the wire.
{
  const a = freshId();
  const b = freshId();
  assert.notEqual(a, b, 'freshId must be collision-free');
  assert.ok(a.startsWith('bkt-') && b.startsWith('bkt-'));
}

// (2) Empty-name rows are dropped; a populated row serialises with no `_id`.
{
  const rows = [
    {
      _id: 'bkt-x',
      name: '',
      compression: null,
      max_delta_ratio: null,
      backend: '',
      alias: '',
      publicMode: 'none',
      public_prefixes: [],
      quota_bytes: null,
    },
    {
      _id: 'bkt-y',
      name: 'prod',
      compression: false,
      max_delta_ratio: 0.5,
      backend: 'b1',
      alias: 'realprod',
      publicMode: 'none',
      public_prefixes: [],
      quota_bytes: 1073741824,
    },
  ];
  const res = buildBucketPayload(rows);
  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(res.body.buckets), ['prod'], 'unnamed row dropped');
  const p = res.body.buckets.prod;
  assert.ok(!('_id' in p), 'synthetic id must never reach the wire');
  // Byte-identical to the historical rowToPolicy output.
  assert.deepEqual(p, {
    compression: false,
    max_delta_ratio: 0.5,
    backend: 'b1',
    alias: 'realprod',
    quota_bytes: 1073741824,
  });
}

// (3) compression:null is preserved as explicit null (RFC 7396 merge delete).
{
  const res = buildBucketPayload([
    {
      _id: 'bkt-1',
      name: 'b',
      compression: null,
      max_delta_ratio: null,
      backend: '',
      alias: '',
      publicMode: 'none',
      public_prefixes: [],
      quota_bytes: null,
    },
  ]);
  assert.equal(res.ok, true);
  assert.equal(res.body.buckets.b.compression, null);
  const json = JSON.stringify(res.body);
  assert.ok(json.includes('"compression":null'), 'null compression must survive stringify');
}

// (4) Tri-state public mode → wire sentinels. `entire` => [""]; `prefixes`
//     drops blanks; `none` omits public_prefixes entirely.
{
  const entire = buildBucketPayload([
    {
      _id: 'bkt-e', name: 'e', compression: null, max_delta_ratio: null,
      backend: '', alias: '', publicMode: 'entire', public_prefixes: [], quota_bytes: null,
    },
  ]);
  assert.deepEqual(entire.body.buckets.e.public_prefixes, ['']);

  const prefixes = buildBucketPayload([
    {
      _id: 'bkt-p', name: 'p', compression: null, max_delta_ratio: null,
      backend: '', alias: '', publicMode: 'prefixes',
      public_prefixes: [
        { id: 'a', value: 'builds/' },
        { id: 'b', value: '  ' }, // blank dropped
        { id: 'c', value: 'rel/' },
      ],
      quota_bytes: null,
    },
  ]);
  assert.deepEqual(prefixes.body.buckets.p.public_prefixes, ['builds/', 'rel/']);

  const none = buildBucketPayload([
    {
      _id: 'bkt-n', name: 'n', compression: null, max_delta_ratio: null,
      backend: '', alias: '', publicMode: 'none', public_prefixes: [], quota_bytes: null,
    },
  ]);
  assert.ok(!('public_prefixes' in none.body.buckets.n), 'none omits public_prefixes');
}

// (5) Duplicate bucket names abort with an error, zero body.
{
  const res = buildBucketPayload([
    { _id: '1', name: 'dup', compression: null, max_delta_ratio: null, backend: '', alias: '', publicMode: 'none', public_prefixes: [], quota_bytes: null },
    { _id: '2', name: 'dup', compression: null, max_delta_ratio: null, backend: '', alias: '', publicMode: 'none', public_prefixes: [], quota_bytes: null },
  ]);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Duplicate bucket name: dup');
}

// (6) policyToRow round-trip through buildBucketPayload: public:true
//     shorthand decodes to `entire` and re-encodes to [""].
{
  const row = policyToRow('shorthand', { public: true });
  assert.equal(row.publicMode, 'entire');
  const res = buildBucketPayload([row]);
  assert.deepEqual(res.body.buckets.shorthand.public_prefixes, ['']);
  // public_prefixes: [""] expanded form also decodes to entire.
  const row2 = policyToRow('expanded', { public_prefixes: [''] });
  assert.equal(row2.publicMode, 'entire');
  assert.deepEqual(buildBucketPayload([row2]).body.buckets.expanded.public_prefixes, ['']);
}

// ───────────────────────────────────────────────────────────────────
// LifecyclePanel — buildLifecyclePayload
// ───────────────────────────────────────────────────────────────────
const {
  buildLifecyclePayload,
  DEFAULT_LIFECYCLE,
  normalizeLifecycle,
  actionKind,
} = lifecycle;

// (7) A delete rule normalises + trims; body matches the historical shape.
{
  const cfg = {
    ...DEFAULT_LIFECYCLE,
    enabled: true,
    rules: [
      {
        name: '  expire  ',
        enabled: true,
        bucket: '  prod  ',
        prefix: 'builds',
        action: 'delete',
        expire_after: '  30d ',
        include_globs: [],
        exclude_globs: ['.deltaglider/**'],
        batch_size: 0, // → 100
      },
    ],
  };
  const res = buildLifecyclePayload(cfg);
  assert.equal(res.ok, true);
  const rule = res.body.lifecycle.rules[0];
  assert.equal(rule.name, 'expire');
  assert.equal(rule.bucket, 'prod');
  assert.equal(rule.prefix, 'builds/'); // normalizePrefix adds trailing /
  assert.equal(rule.expire_after, '30d');
  assert.equal(rule.batch_size, 100);
  assert.equal(rule.action, 'delete');
}

// (8) Validation order: duplicate > missing-name > regex > bucket > expire
//     > transition-destination. Spot-check the key gates.
{
  assert.equal(
    buildLifecyclePayload({ ...DEFAULT_LIFECYCLE, rules: [
      { ...emptyDeleteRule('dup'), expire_after: '1d', bucket: 'b' },
      { ...emptyDeleteRule('dup'), expire_after: '1d', bucket: 'b' },
    ] }).error,
    'Duplicate rule name: dup'
  );
  assert.equal(
    buildLifecyclePayload({ ...DEFAULT_LIFECYCLE, rules: [emptyDeleteRule('')] }).error,
    'Every lifecycle rule needs a name.'
  );
  assert.equal(
    buildLifecyclePayload({ ...DEFAULT_LIFECYCLE, rules: [{ ...emptyDeleteRule('bad name!'), bucket: 'b', expire_after: '1d' }] }).error,
    'Rule bad name!: names must match [A-Za-z0-9_.-]{1,64}.'
  );
  assert.equal(
    buildLifecyclePayload({ ...DEFAULT_LIFECYCLE, rules: [{ ...emptyDeleteRule('ok'), bucket: '', expire_after: '1d' }] }).error,
    'Rule ok: bucket is required.'
  );
  assert.equal(
    buildLifecyclePayload({ ...DEFAULT_LIFECYCLE, rules: [{ ...emptyDeleteRule('ok'), bucket: 'b', expire_after: '' }] }).error,
    'Rule ok: expire_after is required.'
  );
}

// (9) Transition action requires a destination bucket.
{
  const res = buildLifecyclePayload({
    ...DEFAULT_LIFECYCLE,
    rules: [
      {
        ...emptyDeleteRule('move'),
        bucket: 'src',
        expire_after: '1d',
        action: { type: 'transition', destination: { bucket: '', prefix: 'archive/' }, delete_source_after_success: false },
      },
    ],
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Rule move: transition destination bucket is required.');
  assert.equal(actionKind({ type: 'transition', destination: { bucket: 'x' } }), 'transition');
  assert.equal(actionKind('delete'), 'delete');
}

// (10) normalizeLifecycle backfills defaults from emptyRule for partial rules,
//      and normalises a transition action (exercises normalizeAction).
{
  const norm = normalizeLifecycle({ rules: [{ name: 'r', bucket: 'b' }] });
  const r = norm.rules[0];
  assert.equal(r.expire_after, '30d');
  assert.deepEqual(r.exclude_globs, ['.deltaglider/**']);
  assert.equal(r.batch_size, 100);
  assert.equal(r.action, 'delete'); // normalizeAction('delete') === 'delete'

  const normT = normalizeLifecycle({
    rules: [{
      name: 't', bucket: 'b',
      action: { type: 'transition', destination: { bucket: '  dst  ', prefix: 'arch' }, delete_source_after_success: true },
    }],
  });
  const rt = normT.rules[0].action;
  assert.equal(rt.type, 'transition');
  assert.equal(rt.destination.bucket, 'dst'); // trimmed
  assert.equal(rt.destination.prefix, 'arch/'); // normalizePrefix
  assert.equal(rt.delete_source_after_success, true);
}

function emptyDeleteRule(name) {
  return {
    name,
    enabled: false,
    bucket: '',
    prefix: '',
    action: 'delete',
    expire_after: '30d',
    include_globs: [],
    exclude_globs: ['.deltaglider/**'],
    batch_size: 100,
  };
}

// ───────────────────────────────────────────────────────────────────
// ReplicationPanel — buildReplicationPayload
// ───────────────────────────────────────────────────────────────────
const {
  buildReplicationPayload,
  DEFAULT_REPLICATION,
  normalizeReplication,
} = replication;

// (11) A valid rule normalises source/destination prefixes; body matches.
{
  const cfg = {
    ...DEFAULT_REPLICATION,
    rules: [
      {
        name: 'mirror',
        enabled: true,
        source: { bucket: 'src', prefix: 'a' },
        destination: { bucket: 'dst', prefix: 'b' },
        interval: '15m',
        batch_size: 100,
        replicate_deletes: false,
        conflict: 'newer-wins',
        include_globs: [],
        exclude_globs: ['.dg/*'],
      },
    ],
  };
  const res = buildReplicationPayload(cfg);
  assert.equal(res.ok, true);
  const rule = res.body.replication.rules[0];
  assert.equal(rule.source.prefix, 'a/'); // normalizePrefix
  assert.equal(rule.destination.prefix, 'b/');
  assert.equal(rule.name, 'mirror');
}

// (12) Validation: duplicate names, missing name, missing buckets.
{
  assert.equal(
    buildReplicationPayload({ ...DEFAULT_REPLICATION, rules: [
      emptyReplRule('dup'), emptyReplRule('dup'),
    ] }).error,
    'Duplicate rule name: dup'
  );
  assert.equal(
    buildReplicationPayload({ ...DEFAULT_REPLICATION, rules: [emptyReplRule('  ')] }).error,
    'Every replication rule needs a name.'
  );
  assert.equal(
    buildReplicationPayload({ ...DEFAULT_REPLICATION, rules: [
      { ...emptyReplRule('ok'), source: { bucket: '', prefix: '' } },
    ] }).error,
    'Rule ok: source and destination buckets are required.'
  );
}

// (13) normalizeReplication backfills defaults + nested source/destination.
{
  const norm = normalizeReplication({ rules: [{ name: 'r' }] });
  const r = norm.rules[0];
  assert.deepEqual(r.source, { bucket: '', prefix: '' });
  assert.deepEqual(r.destination, { bucket: '', prefix: '' });
  assert.deepEqual(r.exclude_globs, ['.dg/*']);
  assert.equal(r.conflict, 'newer-wins');
}

function emptyReplRule(name) {
  return {
    name,
    enabled: true,
    source: { bucket: 'src', prefix: '' },
    destination: { bucket: 'dst', prefix: '' },
    interval: '15m',
    batch_size: 100,
    replicate_deletes: false,
    conflict: 'newer-wins',
    include_globs: [],
    exclude_globs: ['.dg/*'],
  };
}

console.log('storage section payload regression checks passed');
