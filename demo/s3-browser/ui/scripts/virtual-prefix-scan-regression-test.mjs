import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourceUrl = new URL('../src/permissions.ts', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2020,
    target: ts.ScriptTarget.ES2020,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
  fileName: 'permissions.ts',
}).outputText;

const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`;
const { virtualWritableChildren, canRequestPrefixUsageScan } = await import(moduleUrl);

const realFolders = ['team-a/'];
const writablePrefixes = ['team-a/', 'team-b/sub/', 'team-c/releases/canary/'];
const virtualFolders = virtualWritableChildren('', realFolders, writablePrefixes);

assert.deepEqual(virtualFolders, ['team-b/', 'team-c/']);
assert.equal(canRequestPrefixUsageScan('team-a/', virtualFolders), true);
assert.equal(canRequestPrefixUsageScan('team-b/', virtualFolders), false);
assert.equal(canRequestPrefixUsageScan('team-c/', virtualFolders), false);
assert.equal(canRequestPrefixUsageScan('team-c/releases/', virtualFolders), true);

console.log('virtual prefix scan suppression checks passed');
