import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Transpile the pure helper module to an importable data: URL. It has no runtime
// imports, so it loads without a bundler or a DOM.
function dataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

const url = new URL('../src/components/lifecycleHelpers.ts', import.meta.url);
const source = await readFile(url, 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2020,
    target: ts.ScriptTarget.ES2020,
  },
  fileName: 'lifecycleHelpers.ts',
});

const { fmtDate } = await import(dataUrl(outputText));

// statusTone moved to jobsView.ts (jobStatusTone) — covered by test:jobs-view.

// --- fmtDate -----------------------------------------------------------------
// valid ISO timestamp -> locale string (matches Date#toLocaleString)
const iso = '2024-01-02T03:04:05.000Z';
assert.equal(fmtDate(iso), new Date(iso).toLocaleString());
// unparseable input is returned verbatim
assert.equal(fmtDate('not-a-date'), 'not-a-date');
assert.equal(fmtDate(''), '');

console.log('lifecycle helpers regression checks passed');
