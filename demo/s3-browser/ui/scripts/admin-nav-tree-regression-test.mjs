import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Transpile a JSX-free TS module to an importable data: URL. The admin
// nav tree-walk lives in its own .ts module precisely so it can be
// imported here without an icon/JSX factory.
async function loadModule(relPath, fileName) {
  const url = new URL(relPath, import.meta.url);
  const source = await readFile(url, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2020,
      target: ts.ScriptTarget.ES2020,
    },
    fileName,
  });
  return `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
}

const treeUrl = await loadModule('../src/adminNavTree.ts', 'adminNavTree.ts');
const { findEntry, leavesUnder } = await import(treeUrl);

// A plain-data stand-in for ADMIN_IA: same shape (groups -> entries ->
// children), no JSX. The exact strings mirror the real IA so the test
// documents the invariants a reader expects.
const IA = [
  {
    group: 'Diagnostics',
    entries: [
      { path: 'diagnostics/dashboard', label: 'Dashboard' },
      { path: 'diagnostics/trace', label: 'Trace' },
    ],
  },
  {
    group: 'Configuration',
    entries: [
      { path: 'configuration/admission', label: 'Admission' },
      {
        path: 'configuration/access',
        label: 'Access',
        children: [
          { path: 'configuration/access/credentials', label: 'Credentials & mode' },
          { path: 'configuration/access/users', label: 'Users' },
          { path: 'configuration/access/groups', label: 'Groups' },
          { path: 'configuration/access/ext-auth', label: 'External authentication' },
        ],
      },
      { path: 'configuration/recovery', label: 'Backup' },
      {
        path: 'configuration/advanced',
        label: 'Advanced',
        children: [
          { path: 'configuration/advanced/listener', label: 'Listener & TLS' },
          { path: 'configuration/advanced/sync', label: 'Config DB sync' },
        ],
      },
    ],
  },
];

// --- findEntry ---------------------------------------------------------------
// Top-level leaf in the first group.
assert.equal(findEntry(IA, 'diagnostics/dashboard')?.label, 'Dashboard');
// Top-level leaf in a later group.
assert.equal(findEntry(IA, 'configuration/admission')?.label, 'Admission');
assert.equal(findEntry(IA, 'configuration/recovery')?.label, 'Backup');
// A parent node is itself findable (drives the overview pages).
assert.equal(findEntry(IA, 'configuration/access')?.label, 'Access');
// Nested leaf (the depth-first descent into children).
assert.equal(findEntry(IA, 'configuration/access/groups')?.label, 'Groups');
assert.equal(findEntry(IA, 'configuration/advanced/sync')?.label, 'Config DB sync');
// Unknown path -> undefined (header/overview helpers degrade gracefully).
assert.equal(findEntry(IA, 'configuration/access/nope'), undefined);
assert.equal(findEntry(IA, 'setup'), undefined);
assert.equal(findEntry(IA, ''), undefined);

// --- leavesUnder -------------------------------------------------------------
// Children of a parent, in declared order (drives overview card order).
assert.deepEqual(
  leavesUnder(IA, 'configuration/access').map((e) => e.path),
  [
    'configuration/access/credentials',
    'configuration/access/users',
    'configuration/access/groups',
    'configuration/access/ext-auth',
  ]
);
assert.deepEqual(
  leavesUnder(IA, 'configuration/advanced').map((e) => e.label),
  ['Listener & TLS', 'Config DB sync']
);
// A leaf (no children) yields an empty list, never throws.
assert.deepEqual(leavesUnder(IA, 'configuration/admission'), []);
assert.deepEqual(leavesUnder(IA, 'diagnostics/dashboard'), []);
// Unknown parent -> empty list.
assert.deepEqual(leavesUnder(IA, 'configuration/nope'), []);

console.log('admin nav tree regression checks passed');
