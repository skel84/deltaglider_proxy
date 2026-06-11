import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Transpile droppedFiles.ts (zero runtime deps, duck-typed against the DOM
// entry API precisely so it can be exercised here with mock entries).
const source = await readFile(new URL('../src/droppedFiles.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2020,
    target: ts.ScriptTarget.ES2020,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
  fileName: 'droppedFiles.ts',
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
const { collectDroppedFiles } = await import(moduleUrl);

// ── Mock builders (callback-based, like the real FileSystem*Entry API) ──────
const mkFile = (name, content = 'x') => new File([content], name, { type: 'text/plain' });

function fileEntry(name, file = mkFile(name)) {
  return { isFile: true, isDirectory: false, name, file: (ok) => ok(file) };
}
function brokenFileEntry(name) {
  return { isFile: true, isDirectory: false, name, file: (_ok, err) => err(new Error('NotReadableError')) };
}
/** Directory entry whose reader yields `batches` (arrays of entries), then []. */
function dirEntry(name, batches) {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let i = 0;
      return { readEntries: (ok) => ok(i < batches.length ? batches[i++] : []) };
    },
  };
}
const itemFor = (entry) => ({ webkitGetAsEntry: () => entry });

// 1) No entry API at all → falls back to dt.files verbatim.
{
  const a = mkFile('a.txt');
  const out = await collectDroppedFiles({ files: [a] });
  assert.deepEqual(out, [a], 'no items → dt.files fallback');
}

// 2) Synthetic DataTransfer (items exist, getAsEntry → null) → fallback.
{
  const a = mkFile('a.txt');
  const out = await collectDroppedFiles({
    items: [{ webkitGetAsEntry: () => null, getAsFile: () => a }],
    files: [a],
  });
  assert.deepEqual(out, [a], 'all-null entries → dt.files fallback');
}

// 3) Top-level plain file entry → original File kept, name unchanged.
{
  const a = mkFile('a.txt');
  const out = await collectDroppedFiles({ items: [itemFor(fileEntry('a.txt', a))], files: [a] });
  assert.equal(out.length, 1);
  assert.equal(out[0], a, 'top-level file is not re-wrapped');
}

// 4) Dropped FOLDER with nesting → real files with folder-relative path names.
//    ducky/ { 66000, sub/ { deep.bin } }   ← the reported repro shape
{
  const out = await collectDroppedFiles({
    items: [
      itemFor(
        dirEntry('ducky', [[fileEntry('66000'), dirEntry('sub', [[fileEntry('deep.bin')]])]]),
      ),
    ],
    files: [mkFile('ducky', 'directory-metadata-garbage')], // what dt.files lies with
  });
  const names = out.map((f) => f.name).sort();
  assert.deepEqual(names, ['ducky/66000', 'ducky/sub/deep.bin'], 'folder walked into real files with relative paths');
  // The unreadable directory pseudo-file from dt.files must NOT be included.
  assert.ok(!names.includes('ducky'), 'directory pseudo-file is not enqueued');
}

// 5) readEntries batching: two non-empty batches then the empty terminator.
{
  const batch1 = [fileEntry('one.txt')];
  const batch2 = [fileEntry('two.txt')];
  const out = await collectDroppedFiles({
    items: [itemFor(dirEntry('d', [batch1, batch2]))],
    files: [],
  });
  assert.deepEqual(out.map((f) => f.name).sort(), ['d/one.txt', 'd/two.txt'], 'reader drained across batches');
}

// 6) Unreadable file inside a folder is skipped; siblings survive.
//    (The helper console.warns on the skip — capture it instead of spamming CI.)
{
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...args) => warns.push(args[0]);
  try {
    const out = await collectDroppedFiles({
      items: [itemFor(dirEntry('d', [[brokenFileEntry('bad'), fileEntry('good.txt')]]))],
      files: [],
    });
    assert.deepEqual(out.map((f) => f.name), ['d/good.txt'], 'broken file skipped, sibling kept');
    assert.ok(warns.some((w) => String(w).includes('d/bad')), 'skip is warned with the file path');
  } finally {
    console.warn = realWarn;
  }
}

// 7) Mixed drop: one real folder entry + one null-entry item with getAsFile.
{
  const loose = mkFile('loose.txt');
  const out = await collectDroppedFiles({
    items: [
      itemFor(dirEntry('d', [[fileEntry('in.txt')]])),
      { webkitGetAsEntry: () => null, getAsFile: () => loose },
    ],
    files: [loose],
  });
  assert.deepEqual(out.map((f) => f.name).sort(), ['d/in.txt', 'loose.txt'], 'entry + loose item both collected');
}

console.log('dropped-files regression checks passed');
