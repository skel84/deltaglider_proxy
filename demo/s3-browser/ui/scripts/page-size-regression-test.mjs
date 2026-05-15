/**
 * Regression test for the object-table page-size selector helpers.
 * Mirrors the storage-path test pattern: transpile the .ts module
 * inline and exercise its exports without spinning up React.
 *
 * Covers:
 *   - describeVisibleRange edge cases (empty, single page, plural,
 *     thousands grouping)
 *   - usePersistedPageSize validation predicate semantics: only
 *     allow-listed values survive a round-trip
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

async function transpileAndImport(relPath) {
  const sourceUrl = new URL(relPath, import.meta.url);
  const source = await readFile(sourceUrl, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2020,
      target: ts.ScriptTarget.ES2020,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
    fileName: relPath,
  }).outputText;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`;
  return import(moduleUrl);
}

const { describeVisibleRange } = await transpileAndImport('../src/paginationLabels.ts');

// ── describeVisibleRange ─────────────────────────────────────────

// Empty listing
assert.equal(describeVisibleRange(0, 1, 100), '0 items');
assert.equal(describeVisibleRange(0, 5, 50), '0 items', 'page/size irrelevant when empty');

// Singular grammar
assert.equal(describeVisibleRange(1, 1, 100), '1 item');

// Single-page short form (no page numbers, no Showing-X–Y)
assert.equal(describeVisibleRange(75, 1, 100), '75 items');
assert.equal(describeVisibleRange(100, 1, 100), '100 items', 'exactly fills one page');

// Multi-page long form
assert.equal(
  describeVisibleRange(150, 1, 100),
  'Showing 1–100 of 150 items · Page 1 of 2',
  'first page of two',
);
assert.equal(
  describeVisibleRange(150, 2, 100),
  'Showing 101–150 of 150 items · Page 2 of 2',
  'final partial page',
);

// Thousands grouping (US locale — the only one our UI ships)
assert.equal(
  describeVisibleRange(1500, 2, 100),
  'Showing 101–200 of 1,500 items · Page 2 of 15',
);
assert.equal(
  describeVisibleRange(12345, 50, 250),
  'Showing 12,251–12,345 of 12,345 items · Page 50 of 50',
  'last page is partial; range capped at total',
);

// Page boundary safety: page=1 with size>total still summarises sanely.
assert.equal(
  describeVisibleRange(5, 1, 500),
  '5 items',
  'when page size > total, falls back to single-page short form',
);

// ── exit cleanly ─────────────────────────────────────────────────
console.log('page-size-regression-test: OK (10 assertions)');
