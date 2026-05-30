import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Transpile credentialGeneration.ts to an importable data: URL. It has no
// relative imports, so no rewrite map is needed.
async function loadModule(relPath, fileName) {
  const url = new URL(relPath, import.meta.url);
  const source = await readFile(url, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2020,
      target: ts.ScriptTarget.ES2020,
    },
    fileName,
  });
  return `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
}

const url = await loadModule('../src/credentialGeneration.ts', 'credentialGeneration.ts');
const { generateId, generateSecret } = await import(url);

// Deterministic fill: ramp 0,1,2,... so output is reproducible. Lets us assert
// the exact alphabet mapping (b % alphabet.length).
const ramp = (buf) => { for (let i = 0; i < buf.length; i++) buf[i] = i; };
// Constant fill: every byte 0 -> every body char is alphabet[0].
const zeros = (buf) => buf.fill(0);

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// --- generateId --------------------------------------------------------------
{
  const id = generateId(ramp);
  assert.ok(id.startsWith('AK'), 'id must start with AK');
  assert.equal(id.length, 2 + 18, 'AK + 18 body chars');
  const body = id.slice(2);
  assert.match(body, /^[A-Z0-9]+$/, 'body is uppercase-alnum only');
  // ramp body: bytes 0..17 -> ID_ALPHABET[0..17]
  assert.equal(body, ID_ALPHABET.slice(0, 18));

  // zeros -> every body char is the first alphabet char ('A').
  assert.equal(generateId(zeros), 'AK' + 'A'.repeat(18));
}

// --- generateSecret ----------------------------------------------------------
{
  const secret = generateSecret(ramp);
  assert.equal(secret.length, 40, 'secret is 40 chars');
  // base64 alphabet (A-Za-z0-9+/), no padding.
  assert.match(secret, /^[A-Za-z0-9+/]+$/);
  assert.equal(generateSecret(zeros).length, 40);
}

// --- default CSPRNG path (smoke) ---------------------------------------------
{
  const a = generateId();
  const b = generateId();
  assert.notEqual(a, b, 'two CSPRNG ids should differ');
  assert.ok(a.startsWith('AK') && a.length === 20);
  assert.equal(generateSecret().length, 40);
}

console.log('credential generation regression checks passed');
