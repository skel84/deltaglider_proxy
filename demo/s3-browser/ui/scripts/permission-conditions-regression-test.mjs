import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Transpile a TS module to an importable data: URL (no bundler). permissionConditions.ts
// has no relative imports, so the dependency graph is trivial.
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

const modUrl = await loadModule('../src/components/permissionConditions.ts', 'permissionConditions.ts');
const { getConditionValue, setConditionValue, hasConditions } = await import(modUrl);

const OP = 'IpAddress';
const KEY = 'aws:SourceIp';
const set = (conds, value) => setConditionValue(conds, OP, KEY, value);
const get = (conds) => getConditionValue(conds, OP, KEY);

// (1) THE REGRESSION: trailing comma must NOT persist an empty-string element.
{
  const result = set(undefined, '192.168.0.0/16, 10.0.0.0/8, ');
  assert.deepEqual(result, { IpAddress: { 'aws:SourceIp': ['192.168.0.0/16', '10.0.0.0/8'] } });
  const arr = result.IpAddress['aws:SourceIp'];
  assert.deepEqual(arr, ['192.168.0.0/16', '10.0.0.0/8']);
  assert.ok(!arr.includes(''), 'array must not contain an empty string');
}

// (2) trailing comma with a single survivor coalesces to a scalar string,
//     and crucially never ['192.168.0.0/16', ''].
{
  const result = set(undefined, '192.168.0.0/16, ');
  assert.deepEqual(result, { IpAddress: { 'aws:SourceIp': '192.168.0.0/16' } });
  assert.equal(typeof result.IpAddress['aws:SourceIp'], 'string');
  assert.notDeepEqual(result.IpAddress['aws:SourceIp'], ['192.168.0.0/16', '']);
}

// (3) all-empty input removes the key entirely.
{
  const result = set(undefined, ' , , ');
  assert.deepEqual(result, {});
}

// (3b) all-empty input removes a previously-set key (and prunes the op block).
{
  const seeded = set(undefined, 'a/16, b/8');
  const result = set(seeded, ' , , ');
  assert.deepEqual(result, {});
}

// (4) clean multi-value passes through unchanged.
{
  const result = set(undefined, 'a/16, b/8');
  assert.deepEqual(result, { IpAddress: { 'aws:SourceIp': ['a/16', 'b/8'] } });
}

// (5) round-trip via getConditionValue: no dangling ', '.
{
  const roundTripped = get(set(undefined, 'a, b, '));
  assert.equal(roundTripped, 'a, b');
}

// (6) hasConditions returns false for the all-empty result.
{
  const result = set(undefined, ' , , ');
  assert.equal(hasConditions(result), false);
}

// (6b) hasConditions true once a real value lands.
{
  assert.equal(hasConditions(set(undefined, 'a/16, b/8')), true);
}

console.log('permission conditions regression checks passed');
