import generate from '@babel/generator';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';

const PROGRAM_COUNT = 425;
const TYPED_ARRAYS = new Set([
  'Uint8Array',
  'Uint8ClampedArray',
  'Int8Array',
  'Uint16Array',
  'Int16Array',
  'Uint32Array',
  'Int32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
]);

type GrammarModule = typeof import('../src/generator/js-grammar');

function generateCorpus(): string[] {
  jest.resetModules();
  const { JsGrammar } = require('../src/generator/js-grammar') as GrammarModule;
  return Array.from({ length: PROGRAM_COUNT }, (_, seed) =>
    generate(new JsGrammar({}, seed).generateProgram()).code
  );
}

function isFiniteIterable(
  expression: t.Expression,
  initializers: ReadonlyMap<string, t.Expression>,
  seen = new Set<string>(),
): boolean {
  if (t.isArrayExpression(expression) || t.isStringLiteral(expression) || t.isTemplateLiteral(expression)) {
    return true;
  }
  if (t.isMemberExpression(expression)) {
    return true;
  }
  if (t.isNewExpression(expression) &&
      t.isIdentifier(expression.callee) &&
      TYPED_ARRAYS.has(expression.callee.name)) {
    return true;
  }
  if (t.isBinaryExpression(expression, { operator: '+' })) {
    return t.isExpression(expression.left) &&
      isFiniteIterable(expression.left, initializers, seen) &&
      isFiniteIterable(expression.right, initializers, seen);
  }
  if (t.isIdentifier(expression) && !seen.has(expression.name)) {
    const initializer = initializers.get(expression.name);
    if (initializer !== undefined) {
      const nextSeen = new Set(seen);
      nextSeen.add(expression.name);
      return isFiniteIterable(initializer, initializers, nextSeen);
    }
  }
  return false;
}

jest.setTimeout(60_000);

test('generates deterministic, parseable control-flow statements', () => {
  const sources = generateCorpus();
  const replayedSources = generateCorpus();
  expect(replayedSources).toEqual(sources);

  let forOfCount = 0;
  let forInCount = 0;
  let doWhileCount = 0;
  let throwCount = 0;

  for (const source of sources) {
    const ast = parse(source, {
      sourceType: 'script',
      plugins: ['v8intrinsic'],
    });
    const initializers = new Map<string, t.Expression>();

    traverse(ast, {
      VariableDeclarator(path) {
        const { id, init } = path.node;
        expect(init?.type).not.toBe('ThrowStatement');
        path.traverse({
          ThrowStatement(throwPath) {
            if (init !== null && throwPath.findParent((parent) => parent.node === init)) {
              throw new Error('variable initializer contains a throw statement');
            }
          },
        });
        if (t.isIdentifier(id) && t.isExpression(init)) {
          initializers.set(id.name, init);
        }
      },
    });

    traverse(ast, {
      ForOfStatement(path) {
        forOfCount++;
        if (path.node.await) {
          // for-await-of iterates an async generator (a different iterable
          // category), not a finite array/string — assert it's a call and skip
          // the finite-iterable check.
          expect(t.isCallExpression(path.node.right)).toBe(true);
          return;
        }
        expect(t.isFunctionExpression(path.node.right) && path.node.right.generator).toBe(false);
        expect(isFiniteIterable(path.node.right, initializers)).toBe(true);
      },
      ForInStatement() {
        forInCount++;
      },
      DoWhileStatement(path) {
        doWhileCount++;
        expect(t.isBinaryExpression(path.node.test, { operator: '<' })).toBe(true);
        expect(t.isBlockStatement(path.node.body)).toBe(true);
        if (t.isBlockStatement(path.node.body)) {
          const last = path.node.body.body.at(-1);
          expect(t.isExpressionStatement(last) && t.isUpdateExpression(last.expression, {
            operator: '++',
          })).toBe(true);
        }
      },
      ThrowStatement() {
        throwCount++;
      },
    });
  }

  expect(forOfCount).toBeGreaterThan(0);
  expect(forInCount).toBeGreaterThan(0);
  expect(doWhileCount).toBeGreaterThan(0);
  expect(throwCount).toBeGreaterThan(0);
});
