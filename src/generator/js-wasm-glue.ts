/**
 * Combined JavaScript + WebAssembly stressor templates.
 *
 * These templates reproduce the JS↔Wasm wrapper and tiering stress patterns
 * commonly found in the big_sleep corpus.
 */
import * as t from "@babel/types";
import { ReconfuzzProgram, WasmModule } from "./ast";
import {
  WasmModuleBuilder,
  ValType,
  ExportKind,
  ImportKind,
  INSTR,
  BinaryWriter,
} from "./wasm-builder";
import { mulberry32 } from "./js-grammar";

function normalizeSeed(seed: number | undefined): number {
  if (typeof seed !== "number" || !Number.isFinite(seed)) return 0;
  return Math.trunc(seed) >>> 0;
}

function makeRng(seed: number): () => number {
  return mulberry32(normalizeSeed(seed) ^ 0x5bd1e995);
}

function randInt(rng: () => number, lo: number, hi: number): number {
  if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || lo > hi) {
    throw new RangeError(
      "Random integer bounds must be safe integers with lo <= hi",
    );
  }
  return Math.floor(rng() * (hi - lo + 1)) + lo;
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  if (arr.length === 0) throw new RangeError("Cannot pick from an empty array");
  return arr[randInt(rng, 0, arr.length - 1)];
}

export interface GlueTemplate {
  name: string;
  build(seed?: number): ReconfuzzProgram;
}

/**
 * Template: optimize a JS caller that repeatedly invokes a Wasm export.
 * Forces JS-to-Wasm wrapper optimization and tier-up.
 */
export class WasmWrapperOptimizationTemplate implements GlueTemplate {
  readonly name = "wasm-wrapper-optimization";

  build(seed = 0): ReconfuzzProgram {
    const rng = makeRng(seed);
    const callCount = randInt(rng, 10, 200);
    const argValue = randInt(rng, -128, 127);
    const builder = new WasmModuleBuilder();
    const typeIdx = builder.addType([ValType.I32], [ValType.I32]);
    const functionIdx = builder.addFunction(
      typeIdx,
      [],
      [
        [INSTR.LocalGet, 0],
        [INSTR.LocalGet, 0],
        [pick(rng, [INSTR.I32Add, INSTR.I32Sub, INSTR.I32Mul])],
        [INSTR.End],
      ],
    );
    builder.addExport("add", ExportKind.Func, functionIdx);

    const wasmModule: WasmModule = { name: "module", bytes: builder.toBytes() };

    const instantiateStmt = t.variableDeclaration("const", [
      t.variableDeclarator(
        t.identifier("instance"),
        t.newExpression(
          t.memberExpression(
            t.identifier("WebAssembly"),
            t.identifier("Instance"),
          ),
          [
            t.newExpression(
              t.memberExpression(
                t.identifier("WebAssembly"),
                t.identifier("Module"),
              ),
              [
                t.newExpression(t.identifier("Uint8Array"), [
                  wasmBytesPlaceholder(wasmModule.name),
                ]),
              ],
            ),
            t.objectExpression([]),
          ],
        ),
      ),
    ]);

    const fnName = "callWasm";
    const funcDecl = t.functionDeclaration(
      t.identifier(fnName),
      [],
      t.blockStatement([
        t.variableDeclaration("const", [
          t.variableDeclarator(
            t.identifier("fn"),
            t.memberExpression(
              t.memberExpression(
                t.identifier("instance"),
                t.identifier("exports"),
              ),
              t.identifier("add"),
            ),
          ),
        ]),
        t.expressionStatement(
          t.callExpression(
            t.memberExpression(t.identifier("Array"), t.identifier("from")),
            [
              t.objectExpression([
                t.objectProperty(
                  t.identifier("length"),
                  t.numericLiteral(callCount),
                ),
              ]),
              t.arrowFunctionExpression(
                [],
                t.callExpression(t.identifier("fn"), [
                  t.numericLiteral(argValue),
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
        t.callExpression(t.identifier("%PrepareFunctionForOptimization"), [
          t.identifier(fnName),
        ]),
      ),
      funcDecl,
      t.expressionStatement(t.callExpression(t.identifier(fnName), [])),
      t.expressionStatement(
        t.callExpression(t.identifier("%OptimizeFunctionOnNextCall"), [
          t.identifier(fnName),
        ]),
      ),
      t.expressionStatement(t.callExpression(t.identifier(fnName), [])),
    ];

    return {
      javascript: t.file(t.program(body)),
      wasm: [wasmModule],
      flags: ["--allow-natives-syntax"],
      includes: [],
    };
  }
}

/**
 * Template: instantiate Wasm with a throwing import to stress exception
 * handling in the JS-to-Wasm wrapper.
 */
export class WasmThrowingImportTemplate implements GlueTemplate {
  readonly name = "wasm-throwing-import";

  build(seed = 0): ReconfuzzProgram {
    const rng = makeRng(seed);
    const builder = new WasmModuleBuilder();
    const typeIdx = builder.addType([], [ValType.I32]);
    builder.addImport("env", "throwing", ImportKind.Func, typeIdx);
    const wasmBody: number[][] = [];
    const nopCount = randInt(rng, 0, 8);
    for (let i = 0; i < nopCount; i++) wasmBody.push([INSTR.Nop]);
    // Seed-derived const/drop pairs: stack-neutral, but make the emitted bytes
    // vary per seed (this template was previously only ~9 distinct outputs).
    const stressCount = randInt(rng, 1, 6);
    for (let i = 0; i < stressCount; i++) {
      wasmBody.push([INSTR.I32Const, randInt(rng, -1000, 1000)]);
      wasmBody.push([INSTR.Drop]);
    }
    wasmBody.push([INSTR.Call, 0], [INSTR.End]);
    const functionIdx = builder.addFunction(typeIdx, [], wasmBody);
    builder.addExport("main", ExportKind.Func, functionIdx);

    const wasmModule: WasmModule = { name: "module", bytes: builder.toBytes() };
    const instantiateStmt = t.variableDeclaration("const", [
      t.variableDeclarator(
        t.identifier("instance"),
        t.newExpression(
          t.memberExpression(
            t.identifier("WebAssembly"),
            t.identifier("Instance"),
          ),
          [
            t.newExpression(
              t.memberExpression(
                t.identifier("WebAssembly"),
                t.identifier("Module"),
              ),
              [
                t.newExpression(t.identifier("Uint8Array"), [
                  wasmBytesPlaceholder(wasmModule.name),
                ]),
              ],
            ),
            t.objectExpression([
              t.objectProperty(
                t.identifier("env"),
                t.objectExpression([
                  t.objectProperty(
                    t.identifier("throwing"),
                    t.arrowFunctionExpression(
                      [],
                      t.blockStatement([
                        t.throwStatement(
                          t.newExpression(t.identifier("Error"), [
                            t.stringLiteral("import"),
                          ]),
                        ),
                      ]),
                    ),
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
                t.memberExpression(
                  t.identifier("instance"),
                  t.identifier("exports"),
                ),
                t.identifier("main"),
              ),
              [],
            ),
          ),
        ]),
        t.catchClause(t.identifier("e"), t.blockStatement([])),
      ),
    ];

    return {
      javascript: t.file(t.program(body)),
      wasm: [wasmModule],
      flags: ["--allow-natives-syntax"],
      includes: [],
    };
  }
}

/**
 * Template: exercise V8's Wasm code metadata custom-section decoders while
 * keeping the module small enough to execute repeatedly.
 */
export class WasmMetadataStressTemplate implements GlueTemplate {
  readonly name = "wasm-metadata-stress";

  build(seed = 0): ReconfuzzProgram {
    const rng = makeRng(seed);
    const builder = new WasmModuleBuilder();
    const typeIdx = builder.addType([ValType.I32], [ValType.I32]);
    const operator = pick(rng, [INSTR.I32Add, INSTR.I32Sub, INSTR.I32Mul]);
    const targetFunctionIdx = builder.addFunction(
      typeIdx,
      [],
      [[INSTR.LocalGet, 0], [INSTR.LocalGet, 0], [operator], [INSTR.End]],
    );

    const callCount = randInt(rng, 1, 6);
    const metadataBody: number[][] = [[INSTR.LocalGet, 0]];
    for (let i = 0; i < callCount; i++) {
      metadataBody.push([INSTR.Call, targetFunctionIdx]);
    }
    metadataBody.push([INSTR.End]);
    const metadataFunctionIdx = builder.addFunction(typeIdx, [], metadataBody);
    builder.addExport("metadata", ExportKind.Func, metadataFunctionIdx);

    // Offsets point at each call opcode, relative to the local-declaration
    // vector. The vector occupies offset 0 and local.get occupies offsets 1-2.
    const callSiteOffsets = Array.from(
      { length: callCount },
      (_, index) => 3 + index * 2,
    );
    builder.addInstrFreqMetadata([
      { functionIndex: metadataFunctionIdx, callSiteOffsets },
    ]);
    addCallTargetsMetadata(
      builder,
      metadataFunctionIdx,
      targetFunctionIdx,
      callSiteOffsets,
    );
    addCompilationPriorityMetadata(
      builder,
      metadataFunctionIdx,
      randInt(rng, 0, 7),
    );
    builder.addMemory(randInt(rng, 1, 16));

    const wasmModule: WasmModule = { name: "module", bytes: builder.toBytes() };
    const instantiateStmt = t.variableDeclaration("const", [
      t.variableDeclarator(
        t.identifier("instance"),
        t.newExpression(
          t.memberExpression(
            t.identifier("WebAssembly"),
            t.identifier("Instance"),
          ),
          [
            t.newExpression(
              t.memberExpression(
                t.identifier("WebAssembly"),
                t.identifier("Module"),
              ),
              [
                t.newExpression(t.identifier("Uint8Array"), [
                  wasmBytesPlaceholder(wasmModule.name),
                ]),
              ],
            ),
            t.objectExpression([]),
          ],
        ),
      ),
    ]);

    const fnName = "callMetadataWasm";
    const funcDecl = t.functionDeclaration(
      t.identifier(fnName),
      [t.identifier("value")],
      t.blockStatement([
        t.variableDeclaration("const", [
          t.variableDeclarator(
            t.identifier("fn"),
            t.memberExpression(
              t.memberExpression(
                t.identifier("instance"),
                t.identifier("exports"),
              ),
              t.identifier("metadata"),
            ),
          ),
        ]),
        t.returnStatement(
          t.callExpression(t.identifier("fn"), [t.identifier("value")]),
        ),
      ]),
    );

    const body = [
      instantiateStmt,
      funcDecl,
      t.tryStatement(
        t.blockStatement([
          t.expressionStatement(
            t.callExpression(t.identifier(fnName), [
              t.numericLiteral(randInt(rng, 0, 127)),
            ]),
          ),
        ]),
        t.catchClause(t.identifier("error"), t.blockStatement([])),
      ),
    ];

    return {
      javascript: t.file(t.program(body)),
      wasm: [wasmModule],
      flags: ["--allow-natives-syntax", "--wasm-compilation-hints"],
      includes: [],
    };
  }
}

/** Template: combine i64 and f64 arithmetic in one seed-varied module. */
export class WasmWideArithmeticTemplate implements GlueTemplate {
  readonly name = "wasm-wide-arithmetic";

  build(seed = 0): ReconfuzzProgram {
    const normalizedSeed = normalizeSeed(seed);
    const rng = makeRng(seed);
    const builder = new WasmModuleBuilder();

    const i64TypeIdx = builder.addType(
      [ValType.I64, ValType.I64],
      [ValType.I64],
    );
    const i64Operator = pick(rng, [INSTR.I64Add, INSTR.I64Sub]);
    const i64TailOperator = pick(rng, [INSTR.I64Add, INSTR.I64Sub]);
    const i64Constant = (normalizedSeed % 2_049) - 1_024;
    const i64FunctionIdx = builder.addFunction(
      i64TypeIdx,
      [],
      [
        [INSTR.LocalGet, 0],
        [INSTR.LocalGet, 1],
        [i64Operator],
        [INSTR.I64Const, i64Constant],
        [i64TailOperator],
        [INSTR.End],
      ],
    );
    builder.addExport("wideI64", ExportKind.Func, i64FunctionIdx);

    const f64TypeIdx = builder.addType([ValType.F64], [ValType.F64]);
    const f64Constant = randInt(rng, -2_048, 2_048) / 8;
    const f64FunctionIdx = builder.addFunction(
      f64TypeIdx,
      [],
      [
        [INSTR.LocalGet, 0],
        [INSTR.F64Const, f64Constant],
        [INSTR.F64Add],
        [INSTR.End],
      ],
    );
    builder.addExport("wideF64", ExportKind.Func, f64FunctionIdx);
    builder.addExport("metadata", ExportKind.Func, f64FunctionIdx);

    const wasmModule: WasmModule = {
      name: "wide-arithmetic-module",
      bytes: builder.toBytes(),
    };
    const body = [
      instantiateModuleStatement(wasmModule),
      callExportStatement("wideI64", [
        t.bigIntLiteral(String(randInt(rng, -128, 127))),
        t.bigIntLiteral(String(randInt(rng, -128, 127))),
      ]),
      callExportStatement("wideF64", [
        t.numericLiteral(randInt(rng, -128, 127) / 4),
      ]),
    ];

    return {
      javascript: t.file(t.program(body)),
      wasm: [wasmModule],
      flags: [],
      includes: [],
    };
  }
}

/** Template: write several seed-derived values and load one back. */
export class WasmMemoryRoundTripTemplate implements GlueTemplate {
  readonly name = "wasm-memory-round-trip";

  build(seed = 0): ReconfuzzProgram {
    const normalizedSeed = normalizeSeed(seed);
    const builder = new WasmModuleBuilder();
    const typeIdx = builder.addType([], [ValType.I32]);
    const memoryIdx = builder.addMemory(1, 2);
    const storeCount = 2 + (normalizedSeed % 3);
    const offset = ((normalizedSeed >>> 2) % 16) * 4;
    const body: number[][] = [];

    for (let index = 0; index < storeCount; index++) {
      body.push(
        [INSTR.I32Const, index * 4],
        [INSTR.I32Const, (normalizedSeed + index * 257) & 0x7fff_ffff],
        [INSTR.I32Store, 2, offset],
      );
    }

    const selectedStore = normalizedSeed % storeCount;
    body.push(
      [INSTR.I32Const, selectedStore * 4],
      [INSTR.I32Load, 2, offset],
      [INSTR.End],
    );
    const functionIdx = builder.addFunction(typeIdx, [], body);
    builder.addExport("readBack", ExportKind.Func, functionIdx);
    builder.addExport("metadata", ExportKind.Func, functionIdx);
    builder.addExport("memory", ExportKind.Mem, memoryIdx);

    const wasmModule: WasmModule = {
      name: "memory-round-trip-module",
      bytes: builder.toBytes(),
    };

    return {
      javascript: t.file(
        t.program([
          instantiateModuleStatement(wasmModule),
          callExportStatement("readBack"),
        ]),
      ),
      wasm: [wasmModule],
      flags: [],
      includes: [],
    };
  }
}

/** Template: build a seed-sized chain of exported functions and calls. */
export class WasmFunctionChainTemplate implements GlueTemplate {
  readonly name = "wasm-function-chain";

  build(seed = 0): ReconfuzzProgram {
    const normalizedSeed = normalizeSeed(seed);
    const builder = new WasmModuleBuilder();
    const typeIdx = builder.addType([ValType.I32], [ValType.I32]);
    const functionCount = 2 + (normalizedSeed % 2);
    const functionIndices: number[] = [];

    functionIndices.push(
      builder.addFunction(
        typeIdx,
        [],
        [
          [INSTR.LocalGet, 0],
          [INSTR.I32Const, (normalizedSeed % 255) - 127],
          [INSTR.I32Add],
          [INSTR.End],
        ],
      ),
    );

    for (let index = 1; index < functionCount; index++) {
      const operator =
        ((normalizedSeed >>> index) & 1) === 0 ? INSTR.I32Add : INSTR.I32Sub;
      functionIndices.push(
        builder.addFunction(
          typeIdx,
          [],
          [
            [INSTR.LocalGet, 0],
            [INSTR.Call, functionIndices[index - 1]],
            [INSTR.I32Const, index * 11 + (normalizedSeed % 31)],
            [operator],
            [INSTR.End],
          ],
        ),
      );
    }

    for (let index = 0; index < functionIndices.length; index++) {
      builder.addExport(
        `stage${index}`,
        ExportKind.Func,
        functionIndices[index],
      );
    }
    builder.addExport(
      "metadata",
      ExportKind.Func,
      functionIndices[functionIndices.length - 1],
    );

    const wasmModule: WasmModule = {
      name: "function-chain-module",
      bytes: builder.toBytes(),
    };

    return {
      javascript: t.file(
        t.program([
          instantiateModuleStatement(wasmModule),
          callExportStatement(`stage${functionCount - 1}`, [
            t.numericLiteral(normalizedSeed & 0x7fff),
          ]),
        ]),
      ),
      wasm: [wasmModule],
      flags: [],
      includes: [],
    };
  }
}

function instantiateModuleStatement(
  wasmModule: WasmModule,
): t.VariableDeclaration {
  return t.variableDeclaration("const", [
    t.variableDeclarator(
      t.identifier("instance"),
      t.newExpression(
        t.memberExpression(
          t.identifier("WebAssembly"),
          t.identifier("Instance"),
        ),
        [
          t.newExpression(
            t.memberExpression(
              t.identifier("WebAssembly"),
              t.identifier("Module"),
            ),
            [
              t.newExpression(t.identifier("Uint8Array"), [
                wasmBytesPlaceholder(wasmModule.name),
              ]),
            ],
          ),
          t.objectExpression([]),
        ],
      ),
    ),
  ]);
}

function callExportStatement(
  exportName: string,
  args: t.Expression[] = [],
): t.ExpressionStatement {
  return t.expressionStatement(
    t.callExpression(
      t.memberExpression(
        t.memberExpression(t.identifier("instance"), t.identifier("exports")),
        t.identifier(exportName),
      ),
      args,
    ),
  );
}

function addCallTargetsMetadata(
  builder: WasmModuleBuilder,
  functionIndex: number,
  targetFunctionIndex: number,
  callSiteOffsets: number[],
): void {
  const section = new BinaryWriter();
  section.writeU32(1);
  section.writeU32(functionIndex);
  section.writeU32(callSiteOffsets.length);

  for (const offset of callSiteOffsets) {
    const hint = new BinaryWriter();
    hint.writeU32(targetFunctionIndex);
    hint.writeU32(100);
    section.writeU32(offset);
    section.writeU32(hint.length());
    section.writeBytes(hint.bytes());
  }

  builder.addCustomSection("metadata.code.call_targets", section.bytes());
}

function addCompilationPriorityMetadata(
  builder: WasmModuleBuilder,
  functionIndex: number,
  compilationPriority: number,
): void {
  const hint = new BinaryWriter();
  hint.writeU32(compilationPriority);

  const section = new BinaryWriter();
  section.writeU32(1);
  section.writeU32(functionIndex);
  section.writeU32(0);
  section.writeU32(hint.length());
  section.writeBytes(hint.bytes());
  builder.addCustomSection(
    "metadata.code.compilation_priority",
    section.bytes(),
  );
}

/** The printer expands this placeholder from ReconfuzzProgram.wasm. */
function wasmBytesPlaceholder(name: string): t.CallExpression {
  return t.callExpression(t.identifier("__reconfuzz_wasm_bytes"), [
    t.stringLiteral(name),
  ]);
}

export const GLUE_TEMPLATES: GlueTemplate[] = [
  new WasmWrapperOptimizationTemplate(),
  new WasmThrowingImportTemplate(),
  new WasmMetadataStressTemplate(),
  new WasmWideArithmeticTemplate(),
  new WasmMemoryRoundTripTemplate(),
  new WasmFunctionChainTemplate(),
];
