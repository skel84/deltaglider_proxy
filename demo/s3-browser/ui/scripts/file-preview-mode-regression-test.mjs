// Regression test for getPreviewMode — the pure resolver that decides how the
// object browser previews a file (text / image / video / audio / none). Adding
// video + audio must not regress text/image detection, and extensions must be
// matched case-insensitively off the final path segment.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourceUrl = new URL('../src/components/filePreviewMode.ts', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2020,
    target: ts.ScriptTarget.ES2020,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
  fileName: 'filePreviewMode.ts',
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`;
const { getPreviewMode } = await import(moduleUrl);

// video
for (const f of ['demo.mp4', 'clip.webm', 'movie.MOV', 'a/b/render.m4v', 'screen.ogv']) {
  assert.equal(getPreviewMode(f), 'video', `expected video for ${f}`);
}
// audio
for (const f of ['song.mp3', 'voice.WAV', 'track.flac', 'note.m4a', 'bed.ogg', 'pod.opus']) {
  assert.equal(getPreviewMode(f), 'audio', `expected audio for ${f}`);
}
// image (unchanged)
for (const f of ['logo.png', 'shot.JPEG', 'icon.svg', 'pic.webp']) {
  assert.equal(getPreviewMode(f), 'image', `expected image for ${f}`);
}
// text (unchanged)
for (const f of ['readme.md', 'config.yaml', 'data.json', 'Dockerfile', 'CHANGELOG']) {
  assert.equal(getPreviewMode(f), 'text', `expected text for ${f}`);
}
// none
for (const f of ['archive.tar', 'blob.bin', 'firmware.zip', 'noext', 'a.b.unknownext']) {
  assert.equal(getPreviewMode(f), null, `expected null for ${f}`);
}
// extension comes from the LAST dot of the LAST path segment
assert.equal(getPreviewMode('releases/v1.2.3/demo.mp4'), 'video');
assert.equal(getPreviewMode('weird.mp4/notavideo.txt'), 'text');

console.log('file-preview-mode-regression-test: OK');
