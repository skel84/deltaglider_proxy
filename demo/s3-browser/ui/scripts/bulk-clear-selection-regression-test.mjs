import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Regression guard for BULK-COPY-CLEAR-SELECTION.
//
// `bulkCopy`, `bulkMove`, and `bulkDelete` in useS3Browser.ts are all
// destructive/mutating bulk operations. After a successful mutation each MUST
// clear the current selection (so the cleared rows don't linger as selected /
// re-trigger on the next action) and — because they reference `clearSelection`
// — MUST list it in their useCallback dependency array (react-hooks/
// exhaustive-deps).
//
// The bug: bulkCopy refreshed but never called clearSelection(), leaving the
// just-copied objects selected (inconsistent with bulkMove / bulkDelete).
//
// This is a React hook callback, so there's no pure helper to import. Instead
// we parse the source with the TypeScript AST and assert the structural
// invariant directly: each callback (a) calls clearSelection() somewhere in its
// body, and (b) names clearSelection in its dependency array. The
// exhaustive-deps lint rule is the other automated guard; this test pins the
// behavioral intent (clear-after-mutate) that lint alone cannot express.

const url = new URL('../src/useS3Browser.ts', import.meta.url);
const source = await readFile(url, 'utf8');

const sf = ts.createSourceFile('useS3Browser.ts', source, ts.ScriptTarget.Latest, true);

// Find `const <name> = useCallback(<fn>, [<deps>])` declarations.
const callbacks = new Map(); // name -> { fnNode, depsNode }

function visit(node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name &&
    ts.isIdentifier(node.name) &&
    node.initializer &&
    ts.isCallExpression(node.initializer) &&
    ts.isIdentifier(node.initializer.expression) &&
    node.initializer.expression.text === 'useCallback'
  ) {
    const [fnNode, depsNode] = node.initializer.arguments;
    callbacks.set(node.name.text, { fnNode, depsNode });
  }
  ts.forEachChild(node, visit);
}
visit(sf);

function bodyCallsClearSelection(fnNode) {
  let found = false;
  function walk(n) {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'clearSelection'
    ) {
      found = true;
    }
    ts.forEachChild(n, walk);
  }
  if (fnNode) walk(fnNode);
  return found;
}

function depsInclude(depsNode, name) {
  if (!depsNode || !ts.isArrayLiteralExpression(depsNode)) return false;
  return depsNode.elements.some((el) => ts.isIdentifier(el) && el.text === name);
}

const MUTATING_BULK_OPS = ['bulkCopy', 'bulkMove', 'bulkDelete'];

for (const name of MUTATING_BULK_OPS) {
  const cb = callbacks.get(name);
  assert.ok(cb, `expected a useCallback named ${name} in useS3Browser.ts`);
  assert.ok(
    bodyCallsClearSelection(cb.fnNode),
    `${name} must call clearSelection() after a successful bulk mutation (BULK-COPY-CLEAR-SELECTION)`,
  );
  assert.ok(
    depsInclude(cb.depsNode, 'clearSelection'),
    `${name} references clearSelection so it must appear in the useCallback dependency array (react-hooks/exhaustive-deps)`,
  );
}

console.log(`OK: ${MUTATING_BULK_OPS.join(', ')} all clear selection + list clearSelection in deps`);
