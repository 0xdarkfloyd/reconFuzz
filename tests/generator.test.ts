import { Generator, GeneratorConfig } from '../src/generator';
import { printProgram } from '../src/generator/printer';
import {
  GLUE_TEMPLATES,
  WasmMetadataStressTemplate,
} from '../src/generator/js-wasm-glue';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { JsGrammar } from '../src/generator/js-grammar';
import { Scope } from '../src/generator/ast';

interface RuntimeWasmModule {}

interface RuntimeWasmInstance {
  exports: Record<string, unknown>;
}

interface RuntimeWasmApi {
  Module: {
    new (bytes: Uint8Array): RuntimeWasmModule;
    customSections(module: RuntimeWasmModule, sectionName: string): ArrayBuffer[];
  };
  Instance: new (
    module: RuntimeWasmModule,
    imports?: Record<string, object>,
  ) => RuntimeWasmInstance;
}

const runtimeWasm = (globalThis as unknown as { WebAssembly: RuntimeWasmApi })
  .WebAssembly;

function containsBinary(node: t.Node, operator?: t.BinaryExpression['operator']): boolean {
  if (t.isBinaryExpression(node) && (operator === undefined || node.operator === operator)) {
    return true;
  }
  const keys = t.VISITOR_KEYS[node.type] ?? [];
  return keys.some((key) => {
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      return value.some((child) => t.isNode(child) && containsBinary(child, operator));
    }
    return t.isNode(value) && containsBinary(value, operator);
  });
}

function isIterableExpression(node: t.Node | null | undefined): boolean {
  if (t.isArrayExpression(node) || t.isStringLiteral(node)) return true;
  return t.isBinaryExpression(node) &&
    node.operator === '+' &&
    isIterableExpression(node.left) &&
    isIterableExpression(node.right);
}

describe('Generator', () => {
  it.each(['js-only', 'wasm-only', 'gc-only', 'hybrid'] as const)(
    'replays %s programs from the same seed',
    (mode) => {
      const first = printProgram(new Generator({ mode, seed: 123 }).generate());
      const second = printProgram(new Generator({ mode, seed: 123 }).generate());
      expect(second).toBe(first);
    },
  );

  it('restores the complete random stream when the seed is reset', () => {
    const generator = new Generator({ mode: 'hybrid', seed: 123 });
    const expected = printProgram(generator.generate());
    generator.generate();
    generator.setSeed(123);
    expect(printProgram(generator.generate())).toBe(expected);
  });

  it('rejects invalid runtime modes and seeds', () => {
    expect(
      () =>
        new Generator({
          mode: 'invalid' as GeneratorConfig['mode'],
          seed: 1,
        }),
    ).toThrow('Unknown mode: invalid');
    expect(() => new Generator({ mode: 'js-only', seed: NaN })).toThrow(
      'Invalid seed: NaN',
    );

    const generator = new Generator({ mode: 'js-only', seed: 1 });
    expect(() => generator.setSeed(1.5)).toThrow('Invalid seed: 1.5');
  });

  it('does not silently downgrade hybrid mode without Wasm templates', () => {
    const templates = GLUE_TEMPLATES.splice(0);
    try {
      expect(() => new Generator({ mode: 'hybrid', seed: 1 }).generate()).toThrow(
        'No Wasm templates available',
      );
    } finally {
      GLUE_TEMPLATES.push(...templates);
    }
  });

  it('generates syntactically valid JS-only programs', () => {
    const gen = new Generator({ mode: 'js-only', seed: 42 });
    const program = gen.generate();
    const source = printProgram(program);
    expect(source.length).toBeGreaterThan(0);
    expect(() => parse(source, { sourceType: 'script' })).not.toThrow();
  });

  it('js-only programs include a JIT tier-up harness with natives intrinsics', () => {
    const sources = Array.from({ length: 40 }, (_, seed) =>
      printProgram(new Generator({ mode: 'js-only', seed }).generate()),
    );
    const tierSources = sources.filter((source) =>
      source.includes('%PrepareFunctionForOptimization'),
    );

    expect(tierSources.length).toBeGreaterThan(0);
    for (const source of tierSources) {
      expect(source).toContain('%OptimizeFunctionOnNextCall');
      expect(source).toMatch(/\/\/ Flags:[^\n]*--allow-natives-syntax/);
      expect(() => parse(source, { sourceType: 'script' })).not.toThrow();
    }
  });

  it('js-only tier-up can be disabled', () => {
    const source = printProgram(
      new Generator({ mode: 'js-only', seed: 1, js: { enableTierUp: false } }).generate(),
    );
    expect(source).not.toContain('%PrepareFunctionForOptimization');
    expect(source).not.toContain('%OptimizeFunctionOnNextCall');
  });

  it('tier-up harness calls the target after OptimizeFunctionOnNextCall', () => {
    let matchingSource = '';
    for (let seed = 0; seed <= 20; seed++) {
      const source = printProgram(new Generator({ mode: 'js-only', seed }).generate());
      const prepareMatches = source.matchAll(
        /%PrepareFunctionForOptimization\(([^)]+)\)/g,
      );
      for (const match of prepareMatches) {
        const target = match[1];
        const optimizeAt = source.indexOf(`%OptimizeFunctionOnNextCall(${target})`, match.index);
        // The triggering call may carry arguments (synthesized targets take
        // one param), so match the callee + open-paren, not a no-arg call.
        if (optimizeAt >= 0 && source.slice(optimizeAt).includes(`${target}(`)) {
          matchingSource = source;
          break;
        }
      }
      if (matchingSource.length > 0) break;
    }

    expect(matchingSource.length).toBeGreaterThan(0);
    expect(matchingSource).toContain('%OptimizeFunctionOnNextCall(');
    expect(matchingSource).toMatch(
      /%OptimizeFunctionOnNextCall\([^\n]+\);[\s\S]*\n\s*[A-Za-z_$][\w$]*\([^)]*\);/,
    );
  });

  it('js-only determinism is preserved with tier-up', () => {
    const first = printProgram(new Generator({ mode: 'js-only', seed: 7 }).generate());
    const second = printProgram(new Generator({ mode: 'js-only', seed: 7 }).generate());
    expect(second).toBe(first);
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

  it('prints syntactically valid, seed-varying Wasm metadata stress programs', () => {
    const template = new WasmMetadataStressTemplate();
    const cases = [0, 1, 7].map((seed) => {
      const program = template.build(seed);
      const source = printProgram(program);
      expect(() => parse(source, { sourceType: 'script' })).not.toThrow();
      expect(() => new runtimeWasm.Module(program.wasm[0].bytes)).not.toThrow();
      return Array.from(program.wasm[0].bytes).join(',');
    });

    expect(new Set(cases).size).toBeGreaterThanOrEqual(2);

    const module = new runtimeWasm.Module(template.build(7).wasm[0].bytes);
    const callTargets = runtimeWasm.Module.customSections(module, 'metadata.code.call_targets');
    const compilationPriority = runtimeWasm.Module.customSections(module, 'metadata.code.compilation_priority');
    expect(callTargets.length).toBe(1);
    expect(compilationPriority.length).toBe(1);
    expect(callTargets[0].byteLength).toBeGreaterThan(0);
    expect(compilationPriority[0].byteLength).toBeGreaterThan(0);
  });

  it('builds executable WebAssembly modules for every glue template', () => {
    for (const template of GLUE_TEMPLATES) {
      const program = template.build(7);
      const module = new runtimeWasm.Module(program.wasm[0].bytes);
      const imports: Record<string, object> =
        template.name === 'wasm-throwing-import'
          ? {
              env: {
                throwing: (): never => {
                  throw new Error('import');
                },
              },
            }
          : {};
      const instance = new runtimeWasm.Instance(module, imports);

      if (template.name === 'wasm-wrapper-optimization') {
        const add = instance.exports.add as (value: number) => number;
        expect(Number.isFinite(add(3))).toBe(true);
      } else if (template.name === 'wasm-throwing-import') {
        const main = instance.exports.main as () => number;
        expect(() => main()).toThrow('import');
      } else {
        const metadata = instance.exports.metadata as (value: number) => number;
        expect(Number.isFinite(metadata(3))).toBe(true);
      }
    }
  });

  it('produces at least three distinct Wasm-only sources across seeds', () => {
    const sources = Array.from({ length: 32 }, (_, seed) =>
      printProgram(new Generator({ mode: 'wasm-only', seed }).generate()),
    );

    expect(new Set(sources).size).toBeGreaterThanOrEqual(20);
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

  it('gc-only produces many distinct sources across seeds', () => {
    const sources = Array.from({ length: 64 }, (_, seed) =>
      printProgram(new Generator({ mode: 'gc-only', seed }).generate()),
    );

    expect(new Set(sources).size).toBeGreaterThanOrEqual(24);
  });

  it.each(['js-only', 'wasm-only', 'gc-only', 'hybrid'] as const)(
    'stress corpus for %s stays parseable and diverse',
    (mode) => {
      const sources = new Set<string>();
      for (let seed = 0; seed < 300; seed++) {
        const source = printProgram(new Generator({ mode, seed }).generate());
        expect(() => parse(source, { sourceType: 'script', plugins: ['v8intrinsic'] })).not.toThrow();
        sources.add(source);
      }
      expect(sources.size).toBeGreaterThan(150);
    },
  );

  it('keeps recursive typed expressions and delegated yields well-formed', () => {
    let numericBinary = 0;
    let stringConcat = 0;
    for (let seed = 0; seed < 200; seed++) {
      const grammar = new JsGrammar({ enableTierUp: false }, seed);
      const scope = new Scope();
      numericBinary += containsBinary(grammar.generateExpression(scope, 'number', 6)) ? 1 : 0;
      stringConcat += containsBinary(grammar.generateExpression(scope, 'string', 6), '+') ? 1 : 0;
      const yieldExpression = grammar.generateYieldExpression(scope, 5);
      if (yieldExpression.delegate) {
        expect(isIterableExpression(yieldExpression.argument)).toBe(true);
      }
    }
    expect(numericBinary).toBeGreaterThan(20);
    expect(stringConcat).toBeGreaterThan(20);
  });

  it('exposes boolean, promise, and symbol type-directed productions', () => {
    const grammar = new JsGrammar({ enableTierUp: false }, 17);
    const scope = new Scope();
    expect(t.isBooleanLiteral(grammar.generateExpression(scope, 'boolean', 0))).toBe(true);
    expect(t.isNewExpression(grammar.generateExpression(scope, 'promise', 0))).toBe(true);
    expect(t.isCallExpression(grammar.generateExpression(scope, 'symbol', 0))).toBe(true);
  });
});
