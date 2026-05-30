import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Transpile a TS module to an importable data: URL. `undefinedToNullSubset`
// lives in a pure module (no React/antd) so it can be imported directly.
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

const url = await loadModule('../src/components/advancedPayload.ts', 'advancedPayload.ts');
const { undefinedToNullSubset } = await import(url);

// (1) A cleared scalar becomes explicit null; a set scalar is untouched.
{
  const result = undefinedToNullSubset(
    { cache_size_mb: undefined, metadata_cache_mb: 50 },
    ['cache_size_mb', 'metadata_cache_mb']
  );
  assert.deepEqual(result, { cache_size_mb: null, metadata_cache_mb: 50 });
}

// (2) THE core bug: JSON round-trip must PRESERVE the null (not drop the key).
{
  const result = undefinedToNullSubset(
    { cache_size_mb: undefined, metadata_cache_mb: 50 },
    ['cache_size_mb', 'metadata_cache_mb']
  );
  const roundTripped = JSON.parse(JSON.stringify(result));
  assert.ok('cache_size_mb' in roundTripped, 'cleared key must survive JSON.stringify');
  assert.equal(roundTripped.cache_size_mb, null);
  assert.equal(roundTripped.metadata_cache_mb, 50);
}

// (3) listen_addr clear over the listener subset → both null; stringify keeps it.
{
  const result = undefinedToNullSubset(
    { listen_addr: undefined, tls: undefined },
    ['listen_addr', 'tls']
  );
  assert.deepEqual(result, { listen_addr: null, tls: null });
  const json = JSON.stringify(result);
  assert.ok(json.includes('"listen_addr":null'), 'listen_addr null must survive stringify');
}

// (4) A populated tls object passes through unchanged (no recursion, not nulled).
{
  const tls = { enabled: true, cert_path: '/x' };
  const result = undefinedToNullSubset(
    { listen_addr: undefined, tls },
    ['listen_addr', 'tls']
  );
  assert.equal(result.tls, tls, 'populated tls must pass through by reference');
  assert.equal(result.listen_addr, null);
}

// (5) A set scalar passes through unchanged.
{
  const result = undefinedToNullSubset(
    { config_sync_bucket: 'mybucket' },
    ['config_sync_bucket']
  );
  assert.deepEqual(result, { config_sync_bucket: 'mybucket' });
}

console.log('advanced merge-patch regression checks passed');
