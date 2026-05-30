import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Transpile a TS module to an importable data: URL. The payload builder
// lives in a pure module (no React/antd) so it imports directly.
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

const url = await loadModule('../src/backendEncryptionPayload.ts', 'backendEncryptionPayload.ts');
const { buildEncryptionSectionBody } = await import(url);

// ── Oracle: the EXACT inline logic BackendsPanel.handleEncryptionApply
//    used before the extraction. The builder must match this byte-for-byte
//    (compared via JSON.stringify) so the admin-API wire contract is
//    unchanged for identical user input. ────────────────────────────────
function oracleEncBody(patch) {
  const encBody = { mode: patch.mode };
  if (patch.key !== undefined) encBody.key = patch.key;
  if (patch.key_id !== undefined) encBody.key_id = patch.key_id;
  if (patch.kms_key_id !== undefined) encBody.kms_key_id = patch.kms_key_id;
  if (patch.bucket_key_enabled !== undefined) encBody.bucket_key_enabled = patch.bucket_key_enabled;
  if (patch.legacy_key !== undefined) encBody.legacy_key = patch.legacy_key;
  if (patch.legacy_key_id !== undefined) encBody.legacy_key_id = patch.legacy_key_id;
  return encBody;
}

function oracleBody(backendName, patch, backends) {
  const encBody = oracleEncBody(patch);
  let body;
  if (backendName === 'default' && backends.length === 1 && backends[0].name === 'default') {
    body = { backend_encryption: encBody };
  } else {
    const list = backends.map((b) => {
      const backendShape = { name: b.name, type: b.backend_type };
      if (b.path) backendShape.path = b.path;
      if (b.endpoint) backendShape.endpoint = b.endpoint;
      if (b.region) backendShape.region = b.region;
      if (b.force_path_style !== null) backendShape.force_path_style = b.force_path_style;
      if (b.name === backendName) backendShape.encryption = encBody;
      return backendShape;
    });
    body = { backends: list };
  }
  return body;
}

const eq = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);

// Backend fixtures matching the live BackendInfo shape (force_path_style
// is boolean|null, never undefined).
const fsDefault = {
  name: 'default', backend_type: 'filesystem',
  path: './data', endpoint: null, region: null, force_path_style: null,
};
const s3Hetzner = {
  name: 'hetzner', backend_type: 's3',
  path: null, endpoint: 'https://fsn1.example.com', region: 'eu-central-1', force_path_style: true,
};
const fsLocal = {
  name: 'local', backend_type: 'filesystem',
  path: '/srv/data', endpoint: null, region: null, force_path_style: null,
};

// (1) Encryption-block field-inclusion truth table, surfaced through the
//     singleton path (`backend_encryption` carries the raw enc body).
const encOf = (patch) =>
  buildEncryptionSectionBody('default', patch, [fsDefault]).backend_encryption;
{
  eq(encOf({ mode: 'none' }), { mode: 'none' }, 'none → mode only');
  eq(
    encOf({ mode: 'aes256-gcm-proxy', key: 'abc' }),
    { mode: 'aes256-gcm-proxy', key: 'abc' },
    'proxy-AES → mode + key',
  );
  eq(
    encOf({ mode: 'sse-kms', kms_key_id: 'arn:x', bucket_key_enabled: true }),
    { mode: 'sse-kms', kms_key_id: 'arn:x', bucket_key_enabled: true },
    'sse-kms → mode + kms_key_id + bucket_key_enabled',
  );
  // legacy_key null-clear MUST pass through (it's `!== undefined`).
  eq(
    encOf({ mode: 'none', legacy_key: null, legacy_key_id: null }),
    { mode: 'none', legacy_key: null, legacy_key_id: null },
    'legacy_key null-clear passes through',
  );
}

// (2) Singleton path → { backend_encryption: <encBody> }.
{
  const patch = { mode: 'aes256-gcm-proxy', key: 'deadbeef' };
  const got = buildEncryptionSectionBody('default', patch, [fsDefault]);
  eq(got, oracleBody('default', patch, [fsDefault]), 'singleton matches oracle');
  assert.ok('backend_encryption' in got, 'singleton uses backend_encryption key');
  assert.ok(!('backends' in got), 'singleton must NOT emit backends array');
}

// (3) A backend NAMED "default" but NOT a lone singleton takes the LIST path.
{
  const patch = { mode: 'sse-s3' };
  const backends = [fsDefault, s3Hetzner];
  const got = buildEncryptionSectionBody('default', patch, backends);
  eq(got, oracleBody('default', patch, backends), 'named-default-in-list matches oracle');
  assert.ok('backends' in got, 'two-entry list → backends array even when target is named default');
}

// (4) Named-list path: only the target entry gets `encryption`; siblings
//     carry name/type/path/endpoint/region/force_path_style as filtered.
{
  const patch = { mode: 'sse-kms', kms_key_id: 'arn:aws:kms:...', bucket_key_enabled: false };
  const backends = [fsLocal, s3Hetzner];
  const got = buildEncryptionSectionBody('hetzner', patch, backends);
  eq(got, oracleBody('hetzner', patch, backends), 'named-list matches oracle');
  // Structural assertions on the wire shape.
  const list = got.backends;
  assert.equal(list.length, 2);
  // local: filesystem, no endpoint/region, force_path_style null → omitted.
  eq(list[0], { name: 'local', type: 'filesystem', path: '/srv/data' }, 'fs sibling shape');
  assert.ok(!('encryption' in list[0]), 'non-target sibling has no encryption block');
  // hetzner: target → carries encryption; force_path_style true → kept.
  assert.equal(list[1].name, 'hetzner');
  assert.equal(list[1].type, 's3');
  assert.equal(list[1].endpoint, 'https://fsn1.example.com');
  assert.equal(list[1].region, 'eu-central-1');
  assert.equal(list[1].force_path_style, true);
  eq(list[1].encryption, oracleEncBody(patch), 'target carries the encryption body');
}

// (5) force_path_style === false is a real value → must be KEPT (the
//     original used `!== null`, so false is emitted, not dropped).
{
  const s3PathFalse = { ...s3Hetzner, name: 's3b', force_path_style: false };
  const patch = { mode: 'none' };
  const backends = [s3PathFalse];
  const got = buildEncryptionSectionBody('s3b', patch, backends);
  eq(got, oracleBody('s3b', patch, backends), 'force_path_style false matches oracle');
  assert.equal(got.backends[0].force_path_style, false, 'force_path_style:false is preserved');
}

console.log('backend encryption payload regression checks passed');
