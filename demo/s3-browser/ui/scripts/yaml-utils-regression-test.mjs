import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Transpile a TS module to an importable data: URL (no bundler).
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

const url = await loadModule('../src/yamlUtils.ts', 'yamlUtils.ts');
const { isRedactedEmptyAccessYaml } = await import(url);

// --- isRedactedEmptyAccessYaml ----------------------------------------------
// "empty" shapes
assert.equal(isRedactedEmptyAccessYaml('access:'), true);
assert.equal(isRedactedEmptyAccessYaml('access: {}'), true);
assert.equal(isRedactedEmptyAccessYaml('access: {   }'), true);

// leading full-line comments are stripped before the emptiness check
assert.equal(isRedactedEmptyAccessYaml('# comment\naccess: {}'), true);
assert.equal(isRedactedEmptyAccessYaml('   # indented\naccess:'), true);
assert.equal(isRedactedEmptyAccessYaml('# a\n# b\n\naccess: {}\n\n'), true);

// non-empty / wrong-section / empty-doc shapes
assert.equal(isRedactedEmptyAccessYaml('access:\n  iam_mode: gui'), false);
assert.equal(isRedactedEmptyAccessYaml('access:\n  iam_users: []'), false);
assert.equal(isRedactedEmptyAccessYaml('storage: {}'), false); // wrong section
assert.equal(isRedactedEmptyAccessYaml(''), false);
// a `#` mid-value (not at line start) is NOT a comment line, so the access body
// is not "empty" — this exercises the strip predicate's line-start anchoring.
assert.equal(isRedactedEmptyAccessYaml('access: val # trailing'), false);

console.log('yaml utils regression checks passed');
