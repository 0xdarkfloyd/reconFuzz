import generate from '@babel/generator';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { resetIdCounter } from '../src/generator/ast';
import { JsGrammar } from '../src/generator/js-grammar';

function generateSource(seed: number): string {
  return generate(new JsGrammar({}, seed).generateProgram()).code;
}

function parseScript(source: string): void {
  parse(source, {
    sourceType: 'script',
    plugins: ['v8intrinsic', 'optionalChaining'],
  });
}

describe('optional chaining generation', () => {
  test('emits optional members and calls while keeping every program parseable', () => {
    let sawOptionalMember = false;
    let sawOptionalCall = false;

    for (let seed = 0; seed < 2000; seed++) {
      const program = new JsGrammar({}, seed).generateProgram();
      t.traverseFast(program, (node) => {
        sawOptionalMember ||= t.isOptionalMemberExpression(node);
        sawOptionalCall ||= t.isOptionalCallExpression(node);
      });

      const source = generate(program).code;
      expect(() => parseScript(source)).not.toThrow();
    }

    expect(sawOptionalMember).toBe(true);
    expect(sawOptionalCall).toBe(true);
  });

  test('is deterministic for a fixed seed', () => {
    resetIdCounter();
    const first = generateSource(1729);
    resetIdCounter();
    expect(generateSource(1729)).toBe(first);
  });

  test('parses a nested optional member chain', () => {
    expect(() => parseScript('const a = {}; a?.b?.c;')).not.toThrow();
  });
});
