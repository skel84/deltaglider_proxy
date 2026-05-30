import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Transpile traceRequest.ts to an importable data: URL. The module is
// pure (no imports, no browser globals) so importing it in Node is safe.
const sourceUrl = new URL('../src/traceRequest.ts', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2020,
    target: ts.ScriptTarget.ES2020,
  },
  fileName: 'traceRequest.ts',
}).outputText;

const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`;
const { buildTraceBody } = await import(moduleUrl);

// --- buildTraceBody ----------------------------------------------------------
// WIRE CONTRACT: this body is POSTed verbatim to /_/api/admin/config/trace.
// It must be byte-identical to the prior inline builder in TracePanel.run().

// Base shape: method/path/authenticated always present; query/source_ip omitted
// when empty after trimming.
assert.deepEqual(
  buildTraceBody({ method: 'GET', path: '/', query: '', sourceIp: '', authenticated: false }),
  { method: 'GET', path: '/', authenticated: false },
);

// authenticated round-trips both booleans.
assert.deepEqual(
  buildTraceBody({ method: 'PUT', path: '/b/k', query: '', sourceIp: '', authenticated: true }),
  { method: 'PUT', path: '/b/k', authenticated: true },
);

// Non-empty query is included, trimmed.
assert.deepEqual(
  buildTraceBody({ method: 'GET', path: '/b', query: '  prefix=x/ ', sourceIp: '', authenticated: false }),
  { method: 'GET', path: '/b', authenticated: false, query: 'prefix=x/' },
);

// Non-empty source IP is included, trimmed.
assert.deepEqual(
  buildTraceBody({ method: 'GET', path: '/b', query: '', sourceIp: '  203.0.113.5 ', authenticated: false }),
  { method: 'GET', path: '/b', authenticated: false, source_ip: '203.0.113.5' },
);

// Whitespace-only query / source_ip → key omitted entirely (not '').
const onlySpaces = buildTraceBody({
  method: 'GET',
  path: '/',
  query: '   ',
  sourceIp: '\t\n',
  authenticated: false,
});
assert.deepEqual(onlySpaces, { method: 'GET', path: '/', authenticated: false });
assert.ok(!('query' in onlySpaces), 'whitespace-only query must not add the key');
assert.ok(!('source_ip' in onlySpaces), 'whitespace-only source_ip must not add the key');

// Both present together.
assert.deepEqual(
  buildTraceBody({ method: 'DELETE', path: '/b/k', query: 'list-type=2', sourceIp: '2001:db8::1', authenticated: true }),
  { method: 'DELETE', path: '/b/k', authenticated: true, query: 'list-type=2', source_ip: '2001:db8::1' },
);

console.log('trace request body regression checks passed');
