import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { ReconfuzzProgram, Scope } from '../src/generator/ast';
import { mulberry32 } from '../src/generator/js-grammar';
import { printProgram } from '../src/generator/printer';
import { buildTierUpHarness, TierUpResult } from '../src/generator/tierup';

interface BuiltHarness {
  result: TierUpResult;
  source: string;
  parsed: ReturnType<typeof parse>;
}

function buildHarness(seed: number, maxLoopIterations: number): BuiltHarness {
  const result = buildTierUpHarness(new Scope(), mulberry32(seed), {
    maxLoopIterations,
  });
  const program: ReconfuzzProgram = {
    javascript: t.file(t.program(result.statements)),
    wasm: [],
    flags: result.flags,
    includes: [],
  };
  const source = printProgram(program);
  const parsed = parse(source, {
    sourceType: 'script',
    plugins: ['v8intrinsic'],
  });
  return { result, source, parsed };
}

function intrinsicName(statement: t.Statement): string | undefined {
  if (!t.isExpressionStatement(statement) ||
      !t.isCallExpression(statement.expression) ||
      !t.isIdentifier(statement.expression.callee, { name: 'eval' })) {
    return undefined;
  }
  const argument = statement.expression.arguments[0];
  return t.isStringLiteral(argument) ? argument.value : undefined;
}

function callsTarget(statement: t.Statement, target: string): boolean {
  return t.isExpressionStatement(statement) &&
    t.isCallExpression(statement.expression) &&
    t.isIdentifier(statement.expression.callee, { name: target });
}

describe.each([1, 9])(
  'buildTierUpHarness with maxLoopIterations=%i',
  (maxLoopIterations) => {
    it('returns parseable statements and the required flag', () => {
      const { result, source } = buildHarness(123, maxLoopIterations);

      expect(result.statements.length).toBeGreaterThanOrEqual(1);
      expect(result.statements.length).toBeLessThanOrEqual(2);
      expect(result.statements.every((statement) => t.isTryStatement(statement))).toBe(true);
      expect(result.flags).toEqual(['--allow-natives-syntax']);
      expect(source).toContain('// Flags: --allow-natives-syntax');
      expect(() => parse(source, {
        sourceType: 'script',
        plugins: ['v8intrinsic'],
      })).not.toThrow();
    });

    it('orders prepare, warm-up, optimize, and trigger calls for every target', () => {
      const { result } = buildHarness(456, maxLoopIterations);

      for (const statement of result.statements) {
        expect(t.isTryStatement(statement)).toBe(true);
        if (!t.isTryStatement(statement)) continue;

        const body = statement.block.body;
        const declaration = body.find((item): item is t.FunctionDeclaration =>
          t.isFunctionDeclaration(item),
        );
        expect(declaration?.id).toBeDefined();
        if (!declaration?.id) continue;

        const target = declaration.id.name;
        const prepareIndex = body.findIndex((item) =>
          intrinsicName(item) === `%PrepareFunctionForOptimization(${target})`,
        );
        const optimizeIndex = body.findIndex((item) =>
          intrinsicName(item) === `%OptimizeFunctionOnNextCall(${target})`,
        );
        const callIndexes = body.flatMap((item, index) =>
          callsTarget(item, target) ? [index] : [],
        );

        expect(prepareIndex).toBeGreaterThanOrEqual(0);
        expect(callIndexes).toHaveLength(3);
        expect(callIndexes[0]).toBeGreaterThan(prepareIndex);
        expect(callIndexes[1]).toBeLessThan(optimizeIndex);
        expect(optimizeIndex).toBeGreaterThan(callIndexes[1]);
        expect(callIndexes[2]).toBeGreaterThan(optimizeIndex);
      }
    });

    it('emits only statically bounded loops within the configured maximum', () => {
      const { parsed } = buildHarness(789, maxLoopIterations);
      let loopCount = 0;

      traverse(parsed, {
        ForStatement(path) {
          loopCount++;
          expect(path.node.init).not.toBeNull();
          expect(path.node.update).not.toBeNull();
          expect(t.isBinaryExpression(path.node.test, { operator: '<' })).toBe(true);
          if (!t.isBinaryExpression(path.node.test, { operator: '<' })) return;
          expect(t.isNumericLiteral(path.node.test.right)).toBe(true);
          if (t.isNumericLiteral(path.node.test.right)) {
            expect(path.node.test.right.value).toBeGreaterThanOrEqual(0);
            expect(path.node.test.right.value).toBeLessThanOrEqual(maxLoopIterations);
          }
        },
        WhileStatement() {
          throw new Error('tier-up harness emitted an unexpected while loop');
        },
        DoWhileStatement() {
          throw new Error('tier-up harness emitted an unexpected do-while loop');
        },
        ForInStatement() {
          throw new Error('tier-up harness emitted an unexpected for-in loop');
        },
        ForOfStatement() {
          throw new Error('tier-up harness emitted an unexpected for-of loop');
        },
      });

      expect(loopCount).toBeGreaterThan(0);
    });
  },
);

it('buildTierUpHarness is deterministic for the same seeded RNG', () => {
  const first = buildHarness(0x12345678, 12);
  const second = buildHarness(0x12345678, 12);

  expect(second.source).toBe(first.source);
  expect(second.result.flags).toEqual(first.result.flags);
});
