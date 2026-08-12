import * as t from '@babel/types';
import { ReconfuzzProgram } from '../src/generator/ast';
import { printProgram } from '../src/generator/printer';
import { parse } from '@babel/parser';

const EMPTY_WASM_MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]);

function wasmBytesCall(name: string): t.ExpressionStatement {
  return t.expressionStatement(
    t.callExpression(t.identifier('__reconfuzz_wasm_bytes'), [
      t.stringLiteral(name),
    ]),
  );
}

function makeProgram(
  expression: t.ExpressionStatement = wasmBytesCall('x'),
  overrides: Partial<ReconfuzzProgram> = {},
): ReconfuzzProgram {
  return {
    javascript: t.file(t.program([expression])),
    wasm: [],
    flags: [],
    includes: [],
    ...overrides,
  };
}

describe('printProgram', () => {
  it('rejects nullish or primitive program inputs with a clear TypeError', () => {
    const message =
      'printProgram: program must be a non-null ReconfuzzProgram';

    expect(() => printProgram(null as unknown as ReconfuzzProgram)).toThrow(
      new TypeError(message),
    );
    expect(() => printProgram(undefined as unknown as ReconfuzzProgram)).toThrow(
      new TypeError(message),
    );
    expect(() => printProgram('invalid' as unknown as ReconfuzzProgram)).toThrow(
      new TypeError(message),
    );
  });

  it('escapes include paths as valid JSON string literals', () => {
    const include = "a'b.js";
    const source = printProgram(
      makeProgram(wasmBytesCall('missing'), { includes: [include] }),
    );

    expect(source).toContain(`d8.file.execute(${JSON.stringify(include)});`);
    expect(() => parse(source, { sourceType: 'script' })).not.toThrow();
  });

  it('drops whitespace-containing flags and warns once', () => {
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    try {
      const source = printProgram(
        makeProgram(wasmBytesCall('missing'), {
          flags: ['--allow-natives-syntax', 'bad flag', 'ok'],
        }),
      );

      expect(source).toContain('// Flags: --allow-natives-syntax ok');
      expect(source).not.toContain('bad flag');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('replaces dangling Wasm references with an empty array', () => {
    const source = printProgram(makeProgram(wasmBytesCall('missing')));

    expect(source).not.toContain('__reconfuzz_wasm_bytes');
    expect(source).toContain('[]');
  });

  it('prints matching Wasm bytes as a numeric array literal', () => {
    const source = printProgram(
      makeProgram(wasmBytesCall('x'), {
        wasm: [{ name: 'x', bytes: EMPTY_WASM_MODULE }],
      }),
    );

    expect(source).toContain(`[${Array.from(EMPTY_WASM_MODULE).join(', ')}]`);
  });

  it('warns when duplicate Wasm names are encountered', () => {
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    try {
      const source = printProgram(
        makeProgram(wasmBytesCall('x'), {
          wasm: [
            { name: 'x', bytes: new Uint8Array([1]) },
            { name: 'x', bytes: new Uint8Array([2]) },
          ],
        }),
      );

      expect(source).toContain('[2]');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
