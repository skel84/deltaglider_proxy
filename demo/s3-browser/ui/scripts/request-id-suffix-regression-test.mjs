import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Transpile errorHandling.ts to an importable data: URL. The module has no
// relative imports and only touches browser globals (DOMParser/Response)
// inside function bodies, so importing it in Node is import-time safe.
const sourceUrl = new URL('../src/errorHandling.ts', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2020,
    target: ts.ScriptTarget.ES2020,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
  fileName: 'errorHandling.ts',
}).outputText;

const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`;
const { requestIdSuffix } = await import(moduleUrl);

// --- requestIdSuffix ---------------------------------------------------------
// Empty / nullish → no suffix (the 6 error-construction paths all relied on
// the `requestId ? ... : ''` ternary; this helper IS that ternary).
assert.equal(requestIdSuffix(''), '');
assert.equal(requestIdSuffix(undefined), '');
assert.equal(requestIdSuffix(null), '');

// Present → ` (request-id: …)` with the exact leading space and parens.
assert.equal(requestIdSuffix('abc123'), ' (request-id: abc123)');
assert.equal(requestIdSuffix('REQ-7F3A-2025'), ' (request-id: REQ-7F3A-2025)');

// Concatenation contract: appended verbatim to a message tail, no extra space.
assert.equal(`oops${requestIdSuffix('x')}`, 'oops (request-id: x)');
assert.equal(`oops${requestIdSuffix('')}`, 'oops');

console.log('request-id suffix regression checks passed');
