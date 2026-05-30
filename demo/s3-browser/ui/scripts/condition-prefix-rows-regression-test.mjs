import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Transpile a TS module to an importable data: URL. `replaceImports` rewrites
// bare relative imports to already-built data URLs so the dependency graph
// (conditionPrefixRows -> storagePath) resolves without a bundler.
async function loadModule(relPath, fileName, replaceImports = {}) {
  const url = new URL(relPath, import.meta.url);
  let source = await readFile(url, 'utf8');
  for (const [spec, dataUrl] of Object.entries(replaceImports)) {
    source = source.replaceAll(`'${spec}'`, `'${dataUrl}'`);
  }
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

const storagePathUrl = await loadModule('../src/storagePath.ts', 'storagePath.ts');
const rowsUrl = await loadModule('../src/conditionPrefixRows.ts', 'conditionPrefixRows.ts', {
  './storagePath': storagePathUrl,
});

const { parseRows, serializeRows, normalizePrefixPattern, freshRowId } = await import(rowsUrl);

const texts = (rows) => rows.map((r) => r.text);

// --- normalizePrefixPattern --------------------------------------------------
assert.equal(normalizePrefixPattern('uploads/*'), 'uploads/*');
assert.equal(normalizePrefixPattern(' uploads ' ), 'uploads/');
assert.equal(normalizePrefixPattern('ror//builds/*'), 'ror/builds/*');
assert.equal(normalizePrefixPattern('*'), '*');
assert.equal(normalizePrefixPattern('.*'), '.*');
assert.equal(normalizePrefixPattern(''), '');

// --- parseRows ---------------------------------------------------------------
assert.deepEqual(texts(parseRows('uploads/*, ror/, ror/builds/, ror/e2e_reports/')), [
  'uploads/*', 'ror/', 'ror/builds/', 'ror/e2e_reports/',
]);
assert.deepEqual(texts(parseRows('')), ['']); // always at least one editable row
assert.deepEqual(texts(parseRows('a,,b')), ['a', '', 'b']); // empty middle row preserved on parse

// stable, unique ids
const ids = parseRows('a, b, c').map((r) => r.id);
assert.equal(new Set(ids).size, 3);
assert.notEqual(freshRowId(), freshRowId());

// --- serializeRows -----------------------------------------------------------
const mk = (...t) => t.map((text) => ({ id: freshRowId(), text }));
assert.equal(serializeRows(mk('uploads/*', 'ror/')), 'uploads/*, ror/');
assert.equal(serializeRows(mk('uploads/*', '', 'ror/')), 'uploads/*, ror/'); // empty rows dropped
assert.equal(serializeRows(mk('', '')), ''); // all-empty -> empty string, no dangling commas
assert.equal(serializeRows(mk(' a ', ' b ')), 'a, b'); // trimmed

// --- Full edit-lifecycle simulation (THE regression) -------------------------
// Models ConditionPrefixInput's local-state machine: rows live in state keyed
// by stable id; the comma string is only an OUTPUT. The topmost row must NEVER
// disappear when a newly-added row is typed into and then blurred.
function makeEditor(initial) {
  let rows = parseRows(initial);
  let lastEmitted = serializeRows(rows);
  let emitted = lastEmitted;
  const emit = (mutate) => {
    rows = mutate(rows);
    const s = serializeRows(rows);
    if (s !== lastEmitted) {
      lastEmitted = s;
      emitted = s;
    }
  };
  return {
    rows: () => rows,
    emitted: () => emitted,
    addRow: () => { rows = [...rows, { id: freshRowId(), text: '' }]; },
    updateRow: (i, text) => emit((cur) => cur.map((r, idx) => (idx === i ? { ...r, text } : r))),
    blurRow: (i) => emit((cur) => cur.map((r, idx) => (idx === i ? { ...r, text: normalizePrefixPattern(r.text) } : r))),
    deleteRow: (i) => emit((cur) => {
      const remaining = cur.filter((_, idx) => idx !== i);
      return remaining.length > 0 ? remaining : [{ id: freshRowId(), text: '' }];
    }),
  };
}

// Exact repro from the bug report.
{
  const ed = makeEditor('uploads/*, ror/, ror/builds/, ror/e2e_reports/');
  ed.addRow();                                   // "+ Add prefix"
  assert.deepEqual(texts(ed.rows()), ['uploads/*', 'ror/', 'ror/builds/', 'ror/e2e_reports/', '']);
  ed.updateRow(4, 'newprefix');                  // type into the new row
  ed.blurRow(4);                                 // click outside (blur)
  assert.equal(ed.rows()[0].text, 'uploads/*', 'topmost row must survive blur of another row');
  assert.deepEqual(texts(ed.rows()), ['uploads/*', 'ror/', 'ror/builds/', 'ror/e2e_reports/', 'newprefix/']);
  assert.equal(ed.emitted(), 'uploads/*, ror/, ror/builds/, ror/e2e_reports/, newprefix/');
}

// Add a row and blur WITHOUT typing — no existing row may vanish.
{
  const ed = makeEditor('uploads/*, ror/');
  ed.addRow();
  ed.blurRow(2);
  assert.deepEqual(texts(ed.rows()).slice(0, 2), ['uploads/*', 'ror/']);
  assert.equal(ed.emitted(), 'uploads/*, ror/');
}

// Blur the FIRST row — must not touch the others.
{
  const ed = makeEditor('uploads/*, ror/, ror/builds/');
  ed.blurRow(0);
  assert.deepEqual(texts(ed.rows()), ['uploads/*', 'ror/', 'ror/builds/']);
}

// Delete the middle row — neighbors intact.
{
  const ed = makeEditor('uploads/*, ror/, ror/builds/');
  ed.deleteRow(1);
  assert.deepEqual(texts(ed.rows()), ['uploads/*', 'ror/builds/']);
  assert.equal(ed.emitted(), 'uploads/*, ror/builds/');
}

// Edit several rows in a burst (functional updaters build on latest state).
{
  const ed = makeEditor('a/, b/, c/');
  ed.updateRow(0, 'x/');
  ed.updateRow(2, 'z/');
  assert.deepEqual(texts(ed.rows()), ['x/', 'b/', 'z/']);
  assert.equal(ed.emitted(), 'x/, b/, z/');
}

console.log('condition prefix rows regression checks passed');
