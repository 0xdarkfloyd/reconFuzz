import generate from '@babel/generator';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { JsGrammar } from '../src/generator/js-grammar';

const NEW_NUMBER_EDGES = new Set([
  2 ** 53 - 1,
  -(2 ** 53 - 1),
  2 ** 32 - 1,
  0.1,
  -0.1,
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  Number.EPSILON,
]);

const NEW_BIGINT_EDGES = new Set([
  '18446744073709551615',
  '18446744073709551616',
]);

const NEW_TYPED_ARRAYS = new Set([
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Uint32Array',
  'Float64Array',
  'BigUint64Array',
]);

const NEW_ASSIGNMENT_OPERATORS = new Set([
  '*=',
  '/=',
  '%=',
  '**=',
  '|=',
  '&=',
  '^=',
  '<<=',
  '>>=',
  '>>>=',
  '&&=',
  '||=',
  '??=',
]);

describe('widened JavaScript edge values', () => {
  it('reaches the added values and operators across deterministic seeds', () => {
    const observed = {
      number: false,
      bigint: false,
      string: false,
      regexp: false,
      typedArray: false,
      assignment: false,
      negativeZero: false,
      nan: false,
      positiveInfinity: false,
      negativeInfinity: false,
    };

    for (let seed = 0; seed < 2000; seed++) {
      const ast = new JsGrammar({}, seed).generateProgram();
      const source = generate(ast).code;
      expect(() => parse(source, {
        sourceType: 'script',
        plugins: ['v8intrinsic'],
      })).not.toThrow();

      traverse(ast, {
        NumericLiteral(path) {
          if (NEW_NUMBER_EDGES.has(path.node.value)) observed.number = true;
        },
        BigIntLiteral(path) {
          if (NEW_BIGINT_EDGES.has(path.node.value)) observed.bigint = true;
        },
        StringLiteral(path) {
          if (path.node.value.includes('\u{1F600}') || path.node.value.includes('\0')) {
            observed.string = true;
          }
        },
        RegExpLiteral(path) {
          if (/[mid]/.test(path.node.flags)) observed.regexp = true;
        },
        NewExpression(path) {
          if (t.isIdentifier(path.node.callee) && NEW_TYPED_ARRAYS.has(path.node.callee.name)) {
            observed.typedArray = true;
          }
        },
        AssignmentExpression(path) {
          if (NEW_ASSIGNMENT_OPERATORS.has(path.node.operator)) observed.assignment = true;
        },
        UnaryExpression(path) {
          if (path.node.operator === '-' && t.isNumericLiteral(path.node.argument, { value: 0 })) {
            observed.negativeZero = true;
          }
        },
        BinaryExpression(path) {
          if (path.node.operator !== '/' || !t.isNumericLiteral(path.node.right, { value: 0 })) return;
          if (t.isNumericLiteral(path.node.left, { value: 0 })) observed.nan = true;
          if (t.isNumericLiteral(path.node.left, { value: 1 })) observed.positiveInfinity = true;
          if (t.isNumericLiteral(path.node.left, { value: -1 })) observed.negativeInfinity = true;
        },
      });
    }

    expect(observed).toEqual({
      number: true,
      bigint: true,
      string: true,
      regexp: true,
      typedArray: true,
      assignment: true,
      negativeZero: true,
      nan: true,
      positiveInfinity: true,
      negativeInfinity: true,
    });
  });

  it('prints identical source for the same seed and config', () => {
    const config = { maxStatements: 20, maxExpressionDepth: 5 };
    const generateInFreshModule = (): string => {
      let source = '';
      jest.isolateModules(() => {
        const { JsGrammar: FreshJsGrammar } = require('../src/generator/js-grammar');
        source = generate(new FreshJsGrammar(config, 12345).generateProgram()).code;
      });
      return source;
    };
    const first = generateInFreshModule();
    const second = generateInFreshModule();

    expect(second).toBe(first);
  });
});
