/**
 * Combined JavaScript + WebAssembly stressor templates.
 *
 * These templates reproduce the JS↔Wasm wrapper and tiering stress patterns
 * commonly found in the big_sleep corpus.
 */
import * as t from '@babel/types';
import { ReconfuzzProgram, WasmModule } from './ast';
import {
  WasmModuleBuilder,
  ValType,
  ExportKind,
  ImportKind,
  INSTR,
} from './wasm-builder';

export interface GlueTemplate {
  name: string;
  build(): ReconfuzzProgram;
}

/**
 * Template: optimize a JS caller that repeatedly invokes a Wasm export.
 * Forces JS-to-Wasm wrapper optimization and tier-up.
 */
export class WasmWrapperOptimizationTemplate implements GlueTemplate {
  readonly name = 'wasm-wrapper-optimization';

  build(): ReconfuzzProgram {
    const builder = new WasmModuleBuilder();
    const typeIdx = builder.addType([ValType.I32], [ValType.I32]);
    builder.addFunction(
      typeIdx,
      [ValType.I32],
      [
        [INSTR.LocalGet, 0],
        [INSTR.LocalGet, 0],
        [INSTR.I32Add],
        [INSTR.End],
      ],
    );
    builder.addExport('add', ExportKind.Func, 0);

    const wasmModule: WasmModule = { name: 'module', bytes: builder.toBytes() };

    const bytesArray = Array.from(wasmModule.bytes)
      .map((b) => t.numericLiteral(b));

    const instantiateStmt = t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('instance'),
        t.callExpression(
          t.memberExpression(t.identifier('WebAssembly'), t.identifier('Instance')),
          [
            t.newExpression(
              t.memberExpression(t.identifier('WebAssembly'), t.identifier('Module')),
              [t.newExpression(t.identifier('Uint8Array'), [t.arrayExpression(bytesArray)])],
            ),
            t.objectExpression([]),
          ],
        ),
      ),
    ]);

    const fnName = 'callWasm';
    const funcDecl = t.functionDeclaration(
      t.identifier(fnName),
      [],
      t.blockStatement([
        t.variableDeclaration('const', [
          t.variableDeclarator(
            t.identifier('fn'),
            t.memberExpression(
              t.memberExpression(t.identifier('instance'), t.identifier('exports')),
              t.identifier('add'),
            ),
          ),
        ]),
        t.expressionStatement(
          t.callExpression(
            t.memberExpression(t.identifier('Array'), t.identifier('from')),
            [
              t.objectExpression([
                t.objectProperty(t.identifier('length'), t.numericLiteral(100)),
              ]),
              t.arrowFunctionExpression(
                [],
                t.callExpression(t.identifier('fn'), [
                  t.numericLiteral(1),
                ]),
              ),
            ],
          ),
        ),
      ]),
    );

    const body = [
      instantiateStmt,
      t.expressionStatement(
        t.callExpression(t.identifier('%PrepareFunctionForOptimization'), [
          t.identifier(fnName),
        ]),
      ),
      funcDecl,
      t.expressionStatement(t.callExpression(t.identifier(fnName), [])),
      t.expressionStatement(
        t.callExpression(t.identifier('%OptimizeFunctionOnNextCall'), [
          t.identifier(fnName),
        ]),
      ),
      t.expressionStatement(t.callExpression(t.identifier(fnName), [])),
    ];

    return {
      javascript: t.file(t.program(body)),
      wasm: [wasmModule],
      flags: ['--allow-natives-syntax', '--experimental-wasm-compilation-hints'],
      includes: [],
    };
  }
}

/**
 * Template: instantiate Wasm with a throwing import to stress exception
 * handling in the JS-to-Wasm wrapper.
 */
export class WasmThrowingImportTemplate implements GlueTemplate {
  readonly name = 'wasm-throwing-import';

  build(): ReconfuzzProgram {
    const builder = new WasmModuleBuilder();
    const typeIdx = builder.addType([], [ValType.I32]);
    builder.addImport('env', 'throwing', ImportKind.Func, typeIdx);
    builder.addFunction(typeIdx, [], [
      [INSTR.Call, 0],
      [INSTR.End],
    ]);
    builder.addExport('main', ExportKind.Func, 0);

    const wasmModule: WasmModule = { name: 'module', bytes: builder.toBytes() };
    const bytesArray = Array.from(wasmModule.bytes).map((b) => t.numericLiteral(b));

    const instantiateStmt = t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('instance'),
        t.callExpression(
          t.memberExpression(t.identifier('WebAssembly'), t.identifier('Instance')),
          [
            t.newExpression(
              t.memberExpression(t.identifier('WebAssembly'), t.identifier('Module')),
              [t.newExpression(t.identifier('Uint8Array'), [t.arrayExpression(bytesArray)])],
            ),
            t.objectExpression([
              t.objectProperty(
                t.identifier('env'),
                t.objectExpression([
                  t.objectProperty(
                    t.identifier('throwing'),
                    t.arrowFunctionExpression([], t.blockStatement([
                      t.throwStatement(t.newExpression(t.identifier('Error'), [t.stringLiteral('import')])),
                    ])),
                  ),
                ]),
              ),
            ]),
          ],
        ),
      ),
    ]);

    const body = [
      instantiateStmt,
      t.tryStatement(
        t.blockStatement([
          t.expressionStatement(
            t.callExpression(
              t.memberExpression(
                t.memberExpression(t.identifier('instance'), t.identifier('exports')),
                t.identifier('main'),
              ),
              [],
            ),
          ),
        ]),
        t.catchClause(t.identifier('e'), t.blockStatement([])),
      ),
    ];

    return {
      javascript: t.file(t.program(body)),
      wasm: [wasmModule],
      flags: ['--allow-natives-syntax'],
      includes: [],
    };
  }
}

export const GLUE_TEMPLATES: GlueTemplate[] = [
  new WasmWrapperOptimizationTemplate(),
  new WasmThrowingImportTemplate(),
];
