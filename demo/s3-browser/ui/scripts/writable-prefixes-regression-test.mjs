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
const { writablePrefixesForBucket, virtualWritableChildren } = await import(moduleUrl);

const identity = {
  mode: 'iam',
  version: 'test',
  user: {
    name: 'writer',
    access_key_id: 'AKIATEST',
    is_admin: false,
    permissions: [
      {
        effect: 'Allow',
        actions: ['write'],
        resources: ['artifacts/team-a/*', 'artifacts/team-b/sub/*'],
      },
      {
        effect: 'Deny',
        actions: ['write'],
        resources: ['artifacts/team-a/private/*'],
      },
    ],
  },
};

assert.deepEqual(
  writablePrefixesForBucket(identity, 'artifacts'),
  ['team-a/', 'team-b/sub/'],
);

const rootVirtual = virtualWritableChildren('', ['logs/'], ['team-a/', 'team-b/sub/']);
assert.deepEqual(rootVirtual, ['team-a/', 'team-b/']);

const teamBVirtual = virtualWritableChildren('team-b/', [], ['team-a/', 'team-b/sub/']);
assert.deepEqual(teamBVirtual, ['team-b/sub/']);

const noDuplicateWhenRealExists = virtualWritableChildren('', ['team-a/'], ['team-a/', 'team-b/sub/']);
assert.deepEqual(noDuplicateWhenRealExists, ['team-b/']);

console.log('writable prefix regression checks passed');
