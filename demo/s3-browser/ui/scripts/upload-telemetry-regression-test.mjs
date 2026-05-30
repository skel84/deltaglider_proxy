import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Transpile a TS module to an importable data: URL. `replaceImports` rewrites
// bare relative imports to already-built data URLs so the dependency graph
// (uploadTelemetry -> utils) resolves without a bundler.
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

const utilsUrl = await loadModule('../src/utils.ts', 'utils.ts');
const moduleUrl = await loadModule('../src/uploadTelemetry.ts', 'uploadTelemetry.ts', {
  './utils': utilsUrl,
});
const {
  appendThroughputSample,
  clampPercent,
  estimateCompletedParts,
  estimateInFlightParts,
  estimateTotalParts,
  movingAverageSpeedBps,
} = await import(moduleUrl);

assert.equal(clampPercent(-10), 0);
assert.equal(clampPercent(140), 100);
assert.equal(clampPercent(42.5), 42.5);

const partSize = 16 * 1024 * 1024;
const totalBytes = 50 * 1024 * 1024;
assert.equal(estimateTotalParts(totalBytes, partSize), 4);
assert.equal(estimateCompletedParts(0, totalBytes, partSize), 0);
assert.equal(estimateCompletedParts(16 * 1024 * 1024, totalBytes, partSize), 1);
assert.equal(estimateCompletedParts(totalBytes, totalBytes, partSize), 4);

assert.equal(estimateInFlightParts('queued', 4, 1, 4), 0);
assert.equal(estimateInFlightParts('uploading', 4, 0, 4), 4);
assert.equal(estimateInFlightParts('uploading', 4, 3, 4), 1);
assert.equal(estimateInFlightParts('completing', 4, 4, 4), 0);

const samples = [];
const withA = appendThroughputSample(samples, { atMs: 1000, loadedBytes: 0 }, 5000);
const withB = appendThroughputSample(withA, { atMs: 3000, loadedBytes: 4000 }, 5000);
const withC = appendThroughputSample(withB, { atMs: 7000, loadedBytes: 12000 }, 5000);
assert.equal(withC.length, 2);
assert.equal(Math.round(movingAverageSpeedBps(withC)), 2000);

console.log('upload telemetry regression checks passed');
