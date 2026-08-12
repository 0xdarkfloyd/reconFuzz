import generate from '@babel/generator';
import { parse, type ParserOptions } from '@babel/parser';
import traverse from '@babel/traverse';

import { resetIdCounter } from '../src/generator/ast';
import { JsGrammar } from '../src/generator/js-grammar';

const PARSER_OPTIONS: ParserOptions = {
  sourceType: 'script',
  plugins: ['v8intrinsic', 'optionalChaining'],
};

function sourceFor(seed: number): string {
  resetIdCounter();
  return generate(new JsGrammar({}, seed).generateProgram()).code;
}

describe('relational expression generation', () => {
  test('emits in and instanceof across default-config programs', () => {
    let sawIn = false;
    let sawInstanceof = false;

    for (let seed = 0; seed < 2000; seed++) {
      const source = sourceFor(seed);
      const ast = parse(source, PARSER_OPTIONS);
      traverse(ast, {
        BinaryExpression(path) {
          sawIn ||= path.node.operator === 'in';
          sawInstanceof ||= path.node.operator === 'instanceof';
        },
      });
    }

    expect(sawIn).toBe(true);
    expect(sawInstanceof).toBe(true);
  });

  test('is deterministic for the same seed', () => {
    expect(sourceFor(173)).toBe(sourceFor(173));
  });

  test.each([
    "'key' in ({})",
    '({}) instanceof function Constructor() {}',
  ])('parses a standalone %s expression', (source) => {
    expect(() => parse(`${source};`, PARSER_OPTIONS)).not.toThrow();
  });
});
