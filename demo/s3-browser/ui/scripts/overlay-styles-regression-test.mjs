/**
 * Regression test for the shared overlay-style builder.
 * Mirrors the page-size test pattern: transpile the .ts module inline
 * and exercise its exports without spinning up React.
 *
 * Covers the only non-trivial logic in `getOverlayBaseStyles`:
 *   - minWidth floor (`max(pos.width, minWidth)`) in both directions,
 *   - maxHeight pass-through,
 *   - flexLayout opt-in spreads display:flex / column (and omits it
 *     by default so plain dropdowns stay block),
 *   - the shared shadow / z-index / radius constants are wired in.
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

const { getOverlayBaseStyles, OVERLAY_SHADOW, Z_INDEX_OVERLAY, BORDER_RADIUS } =
  await transpileAndImport('../src/components/overlayStyles.ts');

const colors = { BG_ELEVATED: '#111', BORDER: '#333' };
let assertions = 0;
function check(actual, expected, msg) {
  assert.deepEqual(actual, expected, msg);
  assertions += 1;
}

// ── constants ────────────────────────────────────────────────────
check(OVERLAY_SHADOW, '0 8px 24px rgba(0,0,0,0.3)');
check(Z_INDEX_OVERLAY, 99999);
check(BORDER_RADIUS, { xs: 4, sm: 6, md: 8 });

// ── minWidth floor ───────────────────────────────────────────────
const narrow = getOverlayBaseStyles(colors, { top: 10, left: 20, width: 50 }, {
  minWidth: 200,
  maxHeight: 240,
});
check(narrow.width, 200, 'pos.width below floor → minWidth wins');
check(narrow.top, 10, 'top echoed from pos');
check(narrow.left, 20, 'left echoed from pos');
check(narrow.maxHeight, 240, 'maxHeight passed through');
check(narrow.position, 'fixed');
check(narrow.overflowY, 'auto');
check(narrow.background, '#111', 'background from colors');
check(narrow.border, '1px solid #333', 'border from colors');
check(narrow.borderRadius, BORDER_RADIUS.md);
check(narrow.boxShadow, OVERLAY_SHADOW);
check(narrow.zIndex, Z_INDEX_OVERLAY);

const wide = getOverlayBaseStyles(colors, { top: 0, left: 0, width: 999 }, {
  minWidth: 220,
  maxHeight: 280,
});
check(wide.width, 999, 'pos.width above floor wins');

// ── flexLayout opt-in ────────────────────────────────────────────
check(narrow.display, undefined, 'no flex layout by default');
check(narrow.flexDirection, undefined, 'no flex direction by default');

const flex = getOverlayBaseStyles(colors, { top: 0, left: 0, width: 300 }, {
  minWidth: 220,
  maxHeight: 280,
  flexLayout: true,
});
check(flex.display, 'flex', 'flexLayout spreads display:flex');
check(flex.flexDirection, 'column', 'flexLayout spreads column direction');

// ── exit cleanly ─────────────────────────────────────────────────
console.log(`overlay-styles-regression-test: OK (${assertions} assertions)`);
