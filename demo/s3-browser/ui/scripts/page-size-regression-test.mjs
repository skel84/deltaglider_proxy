/**
 * Regression test for the object-table page-size selector helpers.
 * Mirrors the storage-path test pattern: transpile the .ts module
 * inline and exercise its exports without spinning up React.
 *
 * Covers:
 *   - describeVisibleRange: empty, single-page, plural, thousands
 *     grouping, partial last page, size-greater-than-total fallback.
 *   - clampPageToData: page past the end of a shrunken list clamps to
 *     the last real page; in-range pages pass through; empty list → 1.
 *   - coerceStoredPageSize: null / malformed / not-in-allow-list /
 *     valid pass-through.
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

const { describeVisibleRange, clampPageToData } = await transpileAndImport('../src/paginationLabels.ts');
const { coerceStoredPageSize } = await transpileAndImport('../src/persistedPageSize.ts');

const ALLOWED = [25, 50, 100, 250, 500];
let assertions = 0;
function check(actual, expected, msg) {
  assert.equal(actual, expected, msg);
  assertions += 1;
}

// ── describeVisibleRange ─────────────────────────────────────────

// Empty listing
check(describeVisibleRange(0, 1, 100), '0 items');
check(describeVisibleRange(0, 5, 50), '0 items', 'page/size irrelevant when empty');

// Singular grammar
check(describeVisibleRange(1, 1, 100), '1 item');

// Single-page short form (no page numbers, no Showing-X–Y)
check(describeVisibleRange(75, 1, 100), '75 items');
check(describeVisibleRange(100, 1, 100), '100 items', 'exactly fills one page');

// Multi-page long form
check(
  describeVisibleRange(150, 1, 100),
  'Showing 1–100 of 150 items · Page 1 of 2',
  'first page of two',
);
check(
  describeVisibleRange(150, 2, 100),
  'Showing 101–150 of 150 items · Page 2 of 2',
  'final partial page',
);

// Thousands grouping (US locale — the only one our UI ships)
check(
  describeVisibleRange(1500, 2, 100),
  'Showing 101–200 of 1,500 items · Page 2 of 15',
);
check(
  describeVisibleRange(12345, 50, 250),
  'Showing 12,251–12,345 of 12,345 items · Page 50 of 50',
  'last page is partial; range capped at total',
);

// Page boundary safety: page=1 with size>total still summarises sanely.
check(
  describeVisibleRange(5, 1, 500),
  '5 items',
  'when page size > total, falls back to single-page short form',
);

// ── clampPageToData (OBJ-TABLE-001) ──────────────────────────────

// The bug: a search shrank the list from 500 rows to 50 while the table
// sat on page 3; enrichPage then computed start=200 against a 50-row list.
check(clampPageToData(3, 50, 100), 1, 'page 3 of a 50-row list (1 page) clamps to 1');

// In-range pages must pass through untouched (no S3 request-shape change
// for valid inputs).
check(clampPageToData(2, 250, 100), 2, 'page 2 of a 250-row list (3 pages) stays 2');
check(clampPageToData(1, 500, 100), 1, 'page 1 of a full list stays 1');
check(clampPageToData(5, 500, 100), 5, 'last in-range page stays put');

// Past-the-end clamps to the highest real page, not 1.
check(clampPageToData(9, 250, 100), 3, 'page 9 of a 3-page list clamps to last page');

// Edge cases.
check(clampPageToData(1, 0, 100), 1, 'empty list → page 1');
check(clampPageToData(0, 250, 100), 1, 'page 0 floors to 1');
check(clampPageToData(-4, 250, 100), 1, 'negative page floors to 1');
check(clampPageToData(NaN, 250, 100), 1, 'NaN page falls back to 1');
check(clampPageToData(2.9, 500, 100), 2, 'fractional page floors before clamping');

// ── coerceStoredPageSize ─────────────────────────────────────────

check(coerceStoredPageSize(null, 100, ALLOWED), 100, 'null → default');
check(coerceStoredPageSize('not-a-number', 100, ALLOWED), 100, 'garbage → default');
check(coerceStoredPageSize('NaN', 100, ALLOWED), 100, 'NaN string → default');
check(coerceStoredPageSize('Infinity', 100, ALLOWED), 100, 'Infinity → default');
check(coerceStoredPageSize('17', 100, ALLOWED), 100, 'not in allow-list → default');
check(coerceStoredPageSize('250', 100, ALLOWED), 250, 'in allow-list passes through');
check(coerceStoredPageSize('100', 100, ALLOWED), 100, 'default itself passes through');

// ── exit cleanly ─────────────────────────────────────────────────
console.log(`page-size-regression-test: OK (${assertions} assertions)`);
