import generate from '@babel/generator';
import traverse from '@babel/traverse';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { Generator } from '../src/generator';
import { printProgram } from '../src/generator/printer';
import { mutateSource } from '../src/generator/server';
import { ReconfuzzProgram, WasmModule } from '../src/generator/ast';
import { Mutator } from '../src/mutator';
import {
  EDGE_LITERALS,
  injectEdgeLiteral,
  repeatInLoop,
  substituteLogicalOperator,
} from '../src/mutator/ast-mutators';

const PARSER_OPTIONS = {
  sourceType: 'script' as const,
  plugins: ['v8intrinsic' as const],
};

describe('generator diversity', () => {
  it('emits every targeted expression family across a bounded seed corpus', () => {
    const seen = new Set<string>();
    const targeted = new Set([
      'BigIntLiteral',
      'ConditionalExpression',
      'LogicalExpression',
      'SequenceExpression',
      'SpreadElement',
      'SwitchStatement',
      'TemplateLiteral',
      'UnaryExpression',
      'WhileStatement',
    ]);

    for (let seed = 0; seed < 256 && seen.size < targeted.size; seed++) {
      const program = new Generator({ mode: 'js-only', seed }).generate();
      traverse(program.javascript, {
        enter(path) {
          if (targeted.has(path.node.type)) seen.add(path.node.type);
        },
      });
      expect(() => parse(printProgram(program), PARSER_OPTIONS)).not.toThrow();
    }

    expect(seen).toEqual(targeted);
  });

  it('keeps a large generated corpus syntactically valid and seed-diverse', () => {
    const sources = new Set<string>();
    for (let seed = 0; seed < 512; seed++) {
      const source = printProgram(new Generator({ mode: 'js-only', seed }).generate());
      expect(() => parse(source, PARSER_OPTIONS)).not.toThrow();
      sources.add(source);
    }
    expect(sources.size).toBe(512);
  });

  it('keeps template interpolation implicitly string-coercible', () => {
    for (let seed = 0; seed < 256; seed++) {
      const source = printProgram(new Generator({ mode: 'js-only', seed }).generate());
      expect(source).not.toMatch(/`[^`]*\$\{\s*Symbol\s*\(/);
    }
  });
});

describe('mutation diversity and containment', () => {
  it('replays source mutation from an explicit seed', () => {
    const source = 'let x = 1; x += 2; x *= 3; x = x > 2 ? x : 0;';
    expect(mutateSource(source, 12345)).toBe(mutateSource(source, 12345));
    expect(mutateSource(source, 12345)).not.toBe(source);
  });

  it('emits special numeric edges without shadowable global identifiers', () => {
    const ast = parse('let value = 7;', PARSER_OPTIONS) as unknown as t.File;
    const samples = [0, (2.1 / EDGE_LITERALS.length)];
    let index = 0;
    const mutated = injectEdgeLiteral(ast, () => samples[index++]);
    const source = generate(mutated).code;

    expect(source).toContain('0 / 0');
    expect(source).not.toMatch(/\b(?:NaN|Infinity)\b/);
  });

  it('substitutes logical operators while preserving valid syntax', () => {
    const ast = parse('let result = left && right;', PARSER_OPTIONS) as unknown as t.File;
    const mutated = substituteLogicalOperator(ast, () => 0);
    const source = generate(mutated).code;

    expect(source).toContain('left || right');
    expect(() => parse(source, PARSER_OPTIONS)).not.toThrow();
  });

  it('repeats a testcase in a bounded loop without colliding with its counter', () => {
    const ast = parse('let __mut_i = 1; __mut_i++;', PARSER_OPTIONS) as unknown as t.File;
    const source = generate(repeatInLoop(ast, () => 0)).code;

    expect(source).toContain('let __mut_i_1 = 0');
    expect(source).toContain('__mut_i_1 < 2');
    expect(() => parse(source, PARSER_OPTIONS)).not.toThrow();
  });

  it('contains malformed AST and Wasm mutator results', () => {
    const program: ReconfuzzProgram = {
      javascript: parse('let value = 1;', PARSER_OPTIONS) as unknown as t.File,
      wasm: [{ name: 'module', bytes: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]) }],
      flags: [],
      includes: [],
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const mutated = new Mutator({
        astProbability: 1,
        wasmProbability: 1,
        astMutators: [(() => undefined) as unknown as (ast: t.File, rng: () => number) => t.File],
        wasmMutators: [(() => ({ name: 'bad', bytes: [] })) as unknown as (
          module: WasmModule,
          rng: () => number,
        ) => WasmModule],
        rng: (): number => 0,
      }).mutate(program);

      expect(mutated.javascript).toBe(program.javascript);
      expect(mutated.wasm[0]).toBe(program.wasm[0]);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});
