import { Generator } from '../src/generator';
import { printProgram } from '../src/generator/printer';
import { Mutator } from '../src/mutator';
import { parse } from '@babel/parser';

describe('Mutator', () => {
  it('mutates JS programs while preserving syntactic validity', () => {
    const gen = new Generator({ mode: 'js-only', seed: 1 });
    const program = gen.generate();
    const mutator = new Mutator();

    for (let i = 0; i < 10; i++) {
      const mutated = mutator.mutate(program);
      const source = printProgram(mutated);
      expect(() => parse(source, { sourceType: 'script' })).not.toThrow();
    }
  });
});
