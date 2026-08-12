import { parseExpression } from '@babel/parser';
import * as t from '@babel/types';

import { Scope } from '../src/generator/ast';
import { JsGrammar } from '../src/generator/js-grammar';

const COMPARISON_OPERATORS = new Set([
  '==',
  '===',
  '!=',
  '!==',
  '<',
  '>',
  '<=',
  '>=',
]);

function binaryOperators(expression: t.Expression): t.BinaryExpression['operator'][] {
  const operators: t.BinaryExpression['operator'][] = [];
  t.traverseFast(expression, (node) => {
    if (t.isBinaryExpression(node)) {
      operators.push(node.operator);
    }
  });
  return operators;
}

describe('type-directed expression generation', () => {
  test('class hints produce class expressions at recursive and terminal depths', () => {
    for (let seed = 0; seed < 10; seed++) {
      const grammar = new JsGrammar({}, seed);
      expect(grammar.generateExpression(new Scope(), 'class', 4).type).toBe('ClassExpression');
      expect(grammar.generateExpression(new Scope(), 'class', 0).type).toBe('ClassExpression');
    }

    expect(parseExpression('class {}').type).toBe('ClassExpression');
  });

  test('number hints exclude comparison operators', () => {
    for (let seed = 0; seed < 300; seed++) {
      const expression = new JsGrammar({}, seed).generateExpression(new Scope(), 'number', 6);
      for (const operator of binaryOperators(expression)) {
        expect(COMPARISON_OPERATORS.has(operator)).toBe(false);
      }
    }
  });

  test('boolean hints include comparison expressions', () => {
    const operators: t.BinaryExpression['operator'][] = [];
    for (let seed = 0; seed < 300; seed++) {
      const expression = new JsGrammar({}, seed).generateExpression(new Scope(), 'boolean', 6);
      operators.push(...binaryOperators(expression));
    }

    expect(operators.some((operator) => COMPARISON_OPERATORS.has(operator))).toBe(true);
  });
});
