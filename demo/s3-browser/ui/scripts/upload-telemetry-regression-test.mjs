import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourceUrl = new URL('../src/uploadTelemetry.ts', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2020,
    target: ts.ScriptTarget.ES2020,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
  fileName: 'uploadTelemetry.ts',
}).outputText;

const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`;
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
