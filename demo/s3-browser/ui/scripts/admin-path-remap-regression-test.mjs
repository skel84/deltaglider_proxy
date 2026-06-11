import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/adminPathRemap.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 },
  fileName: 'adminPathRemap.ts',
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
const { ADMIN_PATH_REMAP, resolveAdminPath } = await import(moduleUrl);

// The live IA's leaves — the membership test the app injects.
const KNOWN = new Set([
  'dashboard',
  'diagnostics/trace',
  'diagnostics/audit',
  'diagnostics/delta-efficiency',
  'access/credentials',
  'access/users',
  'access/groups',
  'access/external-auth',
  'access/admission',
  'storage/backends',
  'storage/buckets',
  'jobs',
  'integrations/event-delivery',
  'integrations/event-outbox',
  'system',
]);
const isKnown = (p) => KNOWN.has(p);

// Every remap target must be a live leaf — a dangling target would send
// the user to the dashboard fallback silently.
for (const [from, to] of Object.entries(ADMIN_PATH_REMAP)) {
  assert.ok(KNOWN.has(to), `remap target for '${from}' is not a live leaf: '${to}'`);
}

// The full historical table (both old URL schemes).
const CASES = {
  // flat aliases
  metrics: 'dashboard',
  users: 'access/users',
  groups: 'access/groups',
  auth: 'access/external-auth',
  backends: 'storage/backends',
  backend: 'storage/backends',
  compression: 'storage/backends',
  encryption: 'storage/backends',
  limits: 'system',
  security: 'system',
  logging: 'system',
  // 4-group scheme
  'diagnostics/dashboard': 'dashboard',
  'diagnostics/event-outbox': 'integrations/event-outbox',
  'configuration/admission': 'access/admission',
  'configuration/access': 'access/credentials',
  'configuration/access/credentials': 'access/credentials',
  'configuration/access/users': 'access/users',
  'configuration/access/groups': 'access/groups',
  'configuration/access/ext-auth': 'access/external-auth',
  'configuration/storage': 'storage/backends',
  'configuration/storage/backends': 'storage/backends',
  'configuration/storage/buckets': 'storage/buckets',
  'configuration/storage/encryption': 'storage/backends',
  'configuration/storage/replication': 'jobs',
  'configuration/storage/lifecycle': 'jobs',
  'configuration/recovery': 'system',
  'configuration/advanced': 'system',
  'configuration/advanced/listener': 'system',
  'configuration/advanced/caches': 'system',
  'configuration/advanced/limits': 'system',
  'configuration/advanced/logging': 'system',
  'configuration/advanced/sync': 'system',
  'configuration/advanced/event-delivery': 'integrations/event-delivery',
};
for (const [from, to] of Object.entries(CASES)) {
  assert.equal(resolveAdminPath(from, isKnown), to, `remap '${from}'`);
}

// Passthroughs: live leaves resolve to themselves; setup is special.
for (const leaf of KNOWN) {
  assert.equal(resolveAdminPath(leaf, isKnown), leaf, `passthrough '${leaf}'`);
}
assert.equal(resolveAdminPath('setup', isKnown), 'setup');

// Slash trimming + empty + unknown → dashboard.
assert.equal(resolveAdminPath('/jobs/', isKnown), 'jobs');
assert.equal(resolveAdminPath('', isKnown), 'dashboard');
assert.equal(resolveAdminPath('totally/unknown', isKnown), 'dashboard');

console.log('admin path remap regression checks passed');
