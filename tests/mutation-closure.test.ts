import { parse, ParserOptions } from '@babel/parser';
import * as t from '@babel/types';
import { Generator } from '../src/generator';
import { ReconfuzzProgram } from '../src/generator/ast';
import { mulberry32 } from '../src/generator/js-grammar';
import { printProgram } from '../src/generator/printer';
import { AST_MUTATORS, AstMutator } from '../src/mutator/ast-mutators';

interface CorpusEntry {
  label: string;
  rngSeed: number;
  program: ReconfuzzProgram;
}

const PARSER_OPTIONS: ParserOptions = {
  sourceType: 'script',
  plugins: ['v8intrinsic', 'optionalChaining'],
};

function cloneAst(ast: t.File): t.File {
  return t.cloneNode(ast, true);
}

function printMutated(program: ReconfuzzProgram, javascript: t.File): string {
  return printProgram({ ...program, javascript });
}

function makeCorpus(): CorpusEntry[] {
  return (['js-only', 'hybrid'] as const).flatMap((mode, modeIndex) =>
    Array.from({ length: 10 }, (_, seed) => ({
      label: `${mode} seed ${seed}`,
      rngSeed: 0x5eed0000 + modeIndex * 0x1000 + seed,
      program: new Generator({ mode, seed }).generate(),
    })),
  );
}

jest.setTimeout(60_000);

describe.each(
  AST_MUTATORS.map((mutator, index) => ({
    index,
    name: mutator.name,
    mutator,
  })),
)('AST mutation closure: $name', ({ index, mutator }: {
  index: number;
  name: string;
  mutator: AstMutator;
}) => {
  const corpus = makeCorpus();

  it.each(corpus)('$label remains parseable, immutable, and deterministic', ({
    program,
    rngSeed,
  }) => {
    const seed = (rngSeed + index * 0x10000) >>> 0;
    const firstInput = cloneAst(program.javascript);
    const secondInput = cloneAst(program.javascript);
    const firstSnapshot = cloneAst(firstInput);
    const secondSnapshot = cloneAst(secondInput);

    const first = mutator(firstInput, mulberry32(seed));
    const second = mutator(secondInput, mulberry32(seed));
    const firstSource = printMutated(program, first);
    const secondSource = printMutated(program, second);

    expect(firstInput).toEqual(firstSnapshot);
    expect(secondInput).toEqual(secondSnapshot);
    expect(secondSource).toBe(firstSource);
    expect(() => parse(firstSource, PARSER_OPTIONS)).not.toThrow();
  });
});
