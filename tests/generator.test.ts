import { Generator } from '../src/generator';
import { printProgram } from '../src/generator/printer';
import { parse } from '@babel/parser';

describe('Generator', () => {
  it('generates syntactically valid JS-only programs', () => {
    const gen = new Generator({ mode: 'js-only', seed: 42 });
    const program = gen.generate();
    const source = printProgram(program);
    expect(source.length).toBeGreaterThan(0);
    expect(() => parse(source, { sourceType: 'script' })).not.toThrow();
  });

  it('generates Wasm programs with embedded modules and d8 natives', () => {
    const gen = new Generator({ mode: 'wasm-only', seed: 42 });
    const program = gen.generate();
    const source = printProgram(program);
    expect(program.wasm.length).toBeGreaterThan(0);
    expect(source).toContain('WebAssembly.Module');
    // Wasm templates may use d8 natives; Babel cannot parse those, so we only
    // validate the high-level structure here.
  });

  it('includes required flags in the header', () => {
    const gen = new Generator({ mode: 'wasm-only', seed: 42 });
    const program = gen.generate();
    const source = printProgram(program);
    for (const flag of program.flags) {
      expect(source).toContain(flag);
    }
  });

  it('generates GC-only programs with weak collections or gc() calls', () => {
    const gen = new Generator({ mode: 'gc-only', seed: 42 });
    const program = gen.generate();
    const source = printProgram(program);
    expect(source.length).toBeGreaterThan(0);
    expect(program.flags).toContain('--expose-gc');
    expect(
      source.includes('gc()') ||
        source.includes('WeakMap') ||
        source.includes('WeakSet') ||
        source.includes('FinalizationRegistry') ||
        source.includes('%ArrayBufferDetach'),
    ).toBe(true);
  });
});
