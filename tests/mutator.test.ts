import { Generator } from '../src/generator';
import { printProgram } from '../src/generator/printer';
import { Mutator } from '../src/mutator';
import { minimizeProgram } from '../src/mutator/minimizer';
import * as t from '@babel/types';
import { parse } from '@babel/parser';
import generate from '@babel/generator';
import { ReconfuzzProgram, WasmModule } from '../src/generator/ast';
import {
  WasmMutator,
  bitFlip,
  insertNop,
  truncateTail,
} from '../src/mutator/wasm-mutators';
import {
  AST_MUTATORS,
  AstMutator,
  injectEdgeLiteral,
  injectDeadCode,
  mutateArrayElements,
  mutateNumericBoundaries,
  mutateObjectShape,
  mutateStrings,
  negateConditions,
  spliceStatements,
  substituteOperator,
  swapBinaryOperands,
  wrapInAsync,
} from '../src/mutator/ast-mutators';

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

  it('reflects Wasm IR mutations in the emitted Uint8Array', () => {
    const gen = new Generator({ mode: 'wasm-only', seed: 1 });
    const program = gen.generate();
    const original = printProgram(program);
    const mutator = new Mutator({
      astProbability: 0,
      wasmProbability: 1,
      wasmMutators: [
        (module: WasmModule): WasmModule => {
          const bytes = new Uint8Array(module.bytes);
          bytes[bytes.length - 1] ^= 1;
          return { ...module, bytes };
        },
      ],
    });
    const mutated = mutator.mutate(program);
    expect(printProgram(mutated)).not.toBe(original);
  });

  it.each([-0.1, 1.1, NaN, Infinity])(
    'rejects invalid astProbability %p',
    (astProbability) => {
      expect(() => new Mutator({ astProbability })).toThrow(RangeError);
    },
  );

  it.each([-0.1, 1.1, NaN, Infinity])(
    'rejects invalid wasmProbability %p',
    (wasmProbability) => {
      expect(() => new Mutator({ wasmProbability })).toThrow(RangeError);
    },
  );

  it('accepts the default probabilities', () => {
    expect(() => new Mutator()).not.toThrow();
  });

  it.each([
    null,
    undefined,
    1,
    {},
    { javascript: 'not an AST', wasm: [] },
    { javascript: {}, wasm: null },
  ])('rejects malformed program input %#', (program) => {
    const mutator = new Mutator();
    expect(() => mutator.mutate(program as unknown as ReconfuzzProgram)).toThrow(
      new TypeError(
        'program must be a ReconfuzzProgram with .javascript (AST object) and .wasm (array)',
      ),
    );
  });

  it('rejects picking from an empty mutator array', () => {
    const mutator = new Mutator() as unknown as {
      pick: (arr: number[], rng: () => number) => number;
    };

    expect(() => mutator.pick([], (): number => 0)).toThrow(
      new RangeError('pick() called with an empty array'),
    );
  });

  it('isolates failures from AST and per-module Wasm mutators', () => {
    const program = new Generator({ mode: 'wasm-only', seed: 1 }).generate();
    const originalJavascript = program.javascript;
    const originalModules = [...program.wasm];
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const mutator = new Mutator({
      astProbability: 1,
      wasmProbability: 1,
      astMutators: [(): never => {
        throw new Error('AST failure');
      }],
      wasmMutators: [(): never => {
        throw new Error('Wasm failure');
      }],
      rng: (): number => 0,
    });

    let mutated!: ReturnType<Mutator['mutate']>;
    expect((): void => {
      mutated = mutator.mutate(program);
    }).not.toThrow();
    expect(mutated.javascript).toBe(originalJavascript);
    expect(mutated.wasm).toHaveLength(originalModules.length);
    mutated.wasm.forEach((module, index) => {
      expect(module).toBe(originalModules[index]);
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('uses an injected RNG for deterministic mutator selection', () => {
    const program = new Generator({ mode: 'wasm-only', seed: 1 }).generate();
    const first: WasmMutator = (module): WasmModule => ({ ...module, name: `${module.name}-first` });
    const second: WasmMutator = (module): WasmModule => ({ ...module, name: `${module.name}-second` });
    const config = {
      astMutators: [],
      astProbability: 0,
      wasmProbability: 1,
      wasmMutators: [first, second],
    };
    const makeRng = (): (() => number) => {
      const values = [0, 0.99];
      let index = 0;
      return (): number => values[index++];
    };

    const firstResult = new Mutator({ ...config, rng: makeRng() }).mutate(program);
    const secondResult = new Mutator({ ...config, rng: makeRng() }).mutate(program);

    expect(secondResult.wasm.map((module) => module.name)).toEqual(
      firstResult.wasm.map((module) => module.name),
    );
    expect(firstResult.wasm.every((module) => module.name.endsWith('-second'))).toBe(true);
  });

  it('uses an injected RNG for deterministic AST mutation end to end', (): void => {
    const makeRng = (seed: number): (() => number) => {
      let s = seed >>> 0;
      return (): number => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };
    };
    const program = new Generator({ mode: 'js-only', seed: 1 }).generate();
    const a = new Mutator({ astProbability: 1, wasmProbability: 0, rng: makeRng(99) });
    const b = new Mutator({ astProbability: 1, wasmProbability: 0, rng: makeRng(99) });

    expect(printProgram(a.mutate(program))).toBe(printProgram(b.mutate(program)));
  });

  it('uses an injected RNG for deterministic Wasm mutation end to end', (): void => {
    const makeRng = (seed: number): (() => number) => {
      let s = seed >>> 0;
      return (): number => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };
    };
    const program = new Generator({ mode: 'wasm-only', seed: 1 }).generate();
    const a = new Mutator({
      astProbability: 0,
      wasmProbability: 1,
      wasmMutators: [bitFlip],
      rng: makeRng(99),
    });
    const b = new Mutator({
      astProbability: 0,
      wasmProbability: 1,
      wasmMutators: [bitFlip],
      rng: makeRng(99),
    });

    expect(printProgram(a.mutate(program))).toBe(printProgram(b.mutate(program)));
  });

  it('splices only expression statements, preserving declaration order', () => {
    const ast = t.file(t.program([
      t.variableDeclaration('let', [t.variableDeclarator(t.identifier('a'), t.numericLiteral(1))]),
      t.expressionStatement(t.numericLiteral(2)),
      t.variableDeclaration('let', [t.variableDeclarator(t.identifier('b'), t.identifier('a'))]),
      t.expressionStatement(t.numericLiteral(3)),
    ]));
    const mutated = spliceStatements(ast, (): number => 0);
    expect(mutated.program.body[0].type).toBe('VariableDeclaration');
    expect(mutated.program.body[2].type).toBe('VariableDeclaration');
  });

  it('does not mutate loop-control operators or bounds', () => {
    const ast = t.file(t.program([
      t.forStatement(
        t.variableDeclaration('let', [t.variableDeclarator(t.identifier('i'), t.numericLiteral(0))]),
        t.binaryExpression('<', t.identifier('i'), t.numericLiteral(10)),
        t.updateExpression('++', t.identifier('i')),
        t.blockStatement([t.expressionStatement(t.binaryExpression('+', t.identifier('i'), t.numericLiteral(1)))]),
      ),
    ]));
    const mutated = substituteOperator(ast, (): number => 0);
    const loop = mutated.program.body[0] as t.ForStatement;
    expect((loop.test as t.BinaryExpression).operator).toBe('<');
    const loopBody = loop.body as t.BlockStatement;
    expect(((loopBody.body[0] as t.ExpressionStatement).expression as t.BinaryExpression).operator).toBe('-');
  });

  it('does not inject giant edge values into allocation lengths', () => {
    const ast = t.file(t.program([
      t.expressionStatement(t.newExpression(t.identifier('Uint8Array'), [t.numericLiteral(1)])),
      t.expressionStatement(t.numericLiteral(2)),
    ]));
    const mutated = injectEdgeLiteral(ast, (): number => 0);
    const allocation = mutated.program.body[0] as t.ExpressionStatement;
    const expression = allocation.expression as t.NewExpression;
    expect((expression.arguments[0] as t.NumericLiteral).value).toBe(1);
  });

  it('handles rejected async mutation results', () => {
    const ast = t.file(t.program([
      t.throwStatement(t.newExpression(t.identifier('Error'), [])),
    ]));
    const mutated = wrapInAsync(ast, (): number => 0);
    const expression = mutated.program.body[0] as t.ExpressionStatement;
    expect(t.isMemberExpression((expression.expression as t.CallExpression).callee)).toBe(true);
    expect(((expression.expression as t.CallExpression).callee as t.MemberExpression).property)
      .toEqual(expect.objectContaining({ type: 'Identifier', name: 'catch' }));
  });
});

describe('Additional AST mutators', () => {
  const makeSeededRng = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return (): number => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  };

  const printAst = (ast: t.File): string => generate(ast).code;

  const mutateAndVerify = (mutator: AstMutator, source: string): t.File => {
    const ast = parse(source, { sourceType: 'script' });
    const first = mutator(ast, makeSeededRng(0));
    const second = mutator(ast, makeSeededRng(0));
    const originalSource = printAst(ast);
    const firstSource = printAst(first);

    expect(firstSource).not.toBe(originalSource);
    expect(firstSource).toBe(printAst(second));
    expect(() => parse(firstSource, { sourceType: 'script' })).not.toThrow();
    return first;
  };

  it('mutates numeric boundaries outside loop controls and allocation lengths', () => {
    const mutated = mutateAndVerify(
      mutateNumericBoundaries,
      'for (let i = 0; i < 4; i++) { consume(1, 2, 3); } new Uint8Array(8); let value = 9;',
    );
    const loop = mutated.program.body[0] as t.ForStatement;
    const allocation = (mutated.program.body[1] as t.ExpressionStatement)
      .expression as t.NewExpression;

    expect(((loop.init as t.VariableDeclaration).declarations[0].init as t.NumericLiteral).value)
      .toBe(0);
    expect(((loop.test as t.BinaryExpression).right as t.NumericLiteral).value).toBe(4);
    expect((allocation.arguments[0] as t.NumericLiteral).value).toBe(8);
  });

  it('keeps sign-leading numeric boundaries separate from adjacent operators', () => {
    const program: ReconfuzzProgram = {
      javascript: parse('let a = 1; let b = a - 0; let c = (0, 2);', {
        sourceType: 'script',
      }),
      wasm: [],
      flags: [],
      includes: [],
    };
    const mutator = new Mutator({
      astProbability: 1,
      wasmProbability: 0,
      astMutators: [mutateNumericBoundaries],
      wasmMutators: [],
      rng: makeSeededRng(20260807),
    });

    for (let iteration = 0; iteration < 300; iteration++) {
      const source = printProgram(mutator.mutate(program));
      expect(source).not.toContain('--');
      expect(source).not.toContain('++');
      expect(() => parse(source, { sourceType: 'script' })).not.toThrow();
    }
  });

  it('mutates string literal contents', () => {
    const mutated = mutateAndVerify(
      mutateStrings,
      'const labels = ["alpha", "beta", "gamma", "delta"];',
    );
    const declaration = mutated.program.body[0] as t.VariableDeclaration;
    const array = declaration.declarations[0].init as t.ArrayExpression;

    expect((array.elements[0] as t.StringLiteral).value).not.toBe('alpha');
  });

  it('mutates array element layouts without exceeding the size cap', () => {
    const mutated = mutateAndVerify(
      mutateArrayElements,
      'const first = [1, 2, 3]; const second = [4, 5];',
    );
    const declaration = mutated.program.body[0] as t.VariableDeclaration;
    const array = declaration.declarations[0].init as t.ArrayExpression;

    expect(array.elements).toHaveLength(4);
    expect(array.elements).toContain(null);
    expect(array.elements.length).toBeLessThanOrEqual(16);
  });

  it('mutates object property shapes', () => {
    const mutated = mutateAndVerify(
      mutateObjectShape,
      'const first = { a: 1, b: 2 }; const second = { c: 3 };',
    );
    const declaration = mutated.program.body[0] as t.VariableDeclaration;
    const object = declaration.declarations[0].init as t.ObjectExpression;

    expect(object.properties).toHaveLength(3);
  });

  it('negates multiple condition forms', () => {
    const mutated = mutateAndVerify(
      negateConditions,
      'if (a) { use(a); } while (b) { break; } do { use(c); } while (c); for (; d; ) { break; }',
    );
    const statement = mutated.program.body[0] as t.IfStatement;

    expect(t.isUnaryExpression(statement.test, { operator: '!' })).toBe(true);
  });

  it('swaps only commutative binary and logical operands', () => {
    const mutated = mutateAndVerify(
      swapBinaryOperands,
      'const sum = left + right; const choice = first && second; const difference = high - low;',
    );
    const sum = ((mutated.program.body[0] as t.VariableDeclaration)
      .declarations[0].init as t.BinaryExpression);
    const difference = ((mutated.program.body[2] as t.VariableDeclaration)
      .declarations[0].init as t.BinaryExpression);

    expect((sum.left as t.Identifier).name).toBe('right');
    expect((sum.right as t.Identifier).name).toBe('left');
    expect((difference.left as t.Identifier).name).toBe('high');
    expect((difference.right as t.Identifier).name).toBe('low');
  });

  it('injects two collision-free no-op declarations', () => {
    const source = 'let __dc = 1; work(); finish();';
    const original = parse(source, { sourceType: 'script' });
    const mutated = mutateAndVerify(injectDeadCode, source);
    const names = mutated.program.body.flatMap((statement) => (
      t.isVariableDeclaration(statement)
        ? statement.declarations.flatMap((declaration) => (
          t.isIdentifier(declaration.id) ? [declaration.id.name] : []
        ))
        : []
    ));

    expect(mutated.program.body).toHaveLength(original.program.body.length + 2);
    expect(new Set(names).size).toBe(names.length);
  });

  it('reaches diverse added mutators across repeated catalogue selection', () => {
    const addedMutators: AstMutator[] = [
      mutateNumericBoundaries,
      mutateStrings,
      mutateArrayElements,
      mutateObjectShape,
      negateConditions,
      swapBinaryOperands,
      injectDeadCode,
    ];
    const changedMutators = new Set<number>();
    const trackedMutators = addedMutators.map<AstMutator>((mutator, index) => (
      ast,
      rng,
    ): t.File => {
      const mutated = mutator(ast, rng);
      if (printAst(mutated) !== printAst(ast)) changedMutators.add(index);
      return mutated;
    });
    const program: ReconfuzzProgram = {
      javascript: parse(
        'let total = 1 + 2; const labels = ["alpha", "beta"]; const options = { a: 1, b: 2 }; if (total && labels.length) { total = total + 3; }',
        { sourceType: 'script' },
      ),
      wasm: [],
      flags: [],
      includes: [],
    };
    const mutator = new Mutator({
      astProbability: 1,
      wasmProbability: 0,
      astMutators: trackedMutators,
      rng: makeSeededRng(1234),
    });

    addedMutators.forEach((added) => expect(AST_MUTATORS).toContain(added));
    for (let iteration = 0; iteration < 50; iteration++) {
      const result = mutator.mutate(program);
      expect(() => parse(printAst(result.javascript), { sourceType: 'script' })).not.toThrow();
    }

    expect(changedMutators.size).toBeGreaterThanOrEqual(3);
  });
});

describe('Program minimizer', () => {
  const makeProgram = (
    values: number[],
    directives: t.Directive[] = [],
    comments: t.Comment[] = [],
  ): ReconfuzzProgram => ({
    javascript: t.file(
      t.program(
        values.map((value) => t.expressionStatement(t.numericLiteral(value))),
        directives,
      ),
      comments,
    ),
    wasm: [],
    flags: [],
    includes: [],
  });

  const statementValues = (program: ReconfuzzProgram): number[] => (
    program.javascript.program.body.flatMap((statement) => (
      t.isExpressionStatement(statement) && t.isNumericLiteral(statement.expression)
        ? [statement.expression.value]
        : []
    ))
  );

  it('preserves directives and comments while minimizing', async () => {
    const comments: t.Comment[] = [{ type: 'CommentLine', value: ' preserved' }];
    const program = makeProgram(
      [1, 2, 3],
      [t.directive(t.directiveLiteral('use strict'))],
      comments,
    );

    const result = await minimizeProgram(
      program,
      (candidate) => candidate.javascript.program.body.length > 0,
    );

    expect(result.javascript.program.body).toHaveLength(1);
    expect(result.javascript.program.directives).toHaveLength(1);
    expect(result.javascript.program.directives[0].value.value).toBe('use strict');
    expect(result.javascript.comments).toEqual(comments);
  });

  it('removes only statements allowed by the predicate', async () => {
    const program = makeProgram([1, 2, 3]);

    const result = await minimizeProgram(program, (candidate) => {
      const values = statementValues(candidate);
      return values.includes(1) && values.includes(3) && !values.includes(2);
    });

    expect(statementValues(result)).toEqual([1, 3]);
  });

  it('keeps the full body when no removal preserves the predicate', async () => {
    const program = makeProgram([1, 2, 3]);

    const result = await minimizeProgram(
      program,
      (candidate) => candidate.javascript.program.body.length === 3,
    );

    expect(statementValues(result)).toEqual([1, 2, 3]);
  });

  it('handles an empty body', async () => {
    const result = await minimizeProgram(makeProgram([]), () => true);

    expect(result.javascript.program.body).toHaveLength(0);
  });

  it('limits minimization to the requested number of passes', async () => {
    const predicate = (candidate: ReconfuzzProgram): boolean => {
      const values = statementValues(candidate);
      return (
        (values.length === 2 && values[0] === 2 && values[1] === 3)
        || (values.length === 1 && values[0] === 2)
      );
    };

    const onePass = await minimizeProgram(makeProgram([1, 2, 3]), predicate, { maxPasses: 1 });
    const unlimited = await minimizeProgram(makeProgram([1, 2, 3]), predicate);

    expect(statementValues(onePass)).toEqual([2, 3]);
    expect(statementValues(onePass).length).toBeGreaterThan(statementValues(unlimited).length);
    expect(statementValues(unlimited)).toEqual([2]);
  });
});

describe('Wasm mutators', () => {
  const module: WasmModule = {
    name: 'fixture',
    bytes: new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x10, 0x20, 0x30, 0x40,
    ]),
  };

  it('bitFlip flips exactly one bit in the non-header region', () => {
    const result = bitFlip(module, (): number => 0);
    const differingIndexes = result.bytes.reduce<number[]>((indexes, byte, index) => {
      if (byte !== module.bytes[index]) indexes.push(index);
      return indexes;
    }, []);

    expect(result.bytes).toHaveLength(module.bytes.length);
    expect(differingIndexes).toHaveLength(1);
    expect(differingIndexes[0]).toBeGreaterThanOrEqual(8);
    const changedBits = result.bytes[differingIndexes[0]] ^ module.bytes[differingIndexes[0]];
    expect(changedBits & (changedBits - 1)).toBe(0);
  });

  it('bitFlip is deterministic for the same RNG sequence', () => {
    const makeRng = (): (() => number) => {
      const values = [0.5, 0.75];
      let index = 0;
      return (): number => values[index++];
    };

    expect(bitFlip(module, makeRng()).bytes).toEqual(bitFlip(module, makeRng()).bytes);
  });

  it('clamps boundary RNG values to valid mutation indexes', () => {
    const flipped = bitFlip(module, (): number => 1);
    const lastByte = flipped.bytes[flipped.bytes.length - 1];
    expect(lastByte).not.toBe(module.bytes[module.bytes.length - 1]);
    expect(truncateTail(module, (): number => 1).bytes.length).toBe(module.bytes.length - 1);
  });

  it('truncateTail uses the injected RNG and preserves the header', () => {
    const result = truncateTail(module, (): number => 0.5);

    expect(result.bytes).toHaveLength(10);
    expect(result.bytes.slice(0, 8)).toEqual(module.bytes.slice(0, 8));
    expect(result.bytes.length).toBeLessThan(module.bytes.length);
    expect(result.bytes.length).toBeGreaterThanOrEqual(8);
  });

  it('copies bytes on the short-module early return paths', () => {
    const input: WasmModule = {
      name: 'short',
      bytes: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
    };

    const flipped = bitFlip(input, (): number => 0);
    const truncated = truncateTail(input, (): number => 0);

    expect(flipped.bytes).not.toBe(input.bytes);
    expect(flipped.bytes).toEqual(input.bytes);
    expect(truncated.bytes).not.toBe(input.bytes);
    expect(truncated.bytes).toEqual(input.bytes);
  });

  it('insertNop appends a wasm nop', () => {
    const result = insertNop(module);

    expect(result.bytes).toHaveLength(module.bytes.length + 1);
    expect(result.bytes[result.bytes.length - 1]).toBe(0x01);
    expect(result.bytes.slice(0, module.bytes.length)).toEqual(module.bytes);
    expect(result.name).toBe(module.name);
    expect(result.bytes).not.toBe(module.bytes);
  });

  it('insertNop appends a nop to an empty module', () => {
    const input: WasmModule = { name: 'empty', bytes: new Uint8Array() };

    const result = insertNop(input);

    expect(result.bytes).toEqual(new Uint8Array([0x01]));
    expect(result.bytes).not.toBe(input.bytes);
    expect(result.name).toBe(input.name);
  });
});
