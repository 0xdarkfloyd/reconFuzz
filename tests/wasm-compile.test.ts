import { parse } from "@babel/parser";
import { GC_TEMPLATES } from "../src/generator/gc-templates";
import { GLUE_TEMPLATES } from "../src/generator/js-wasm-glue";
import { printProgram } from "../src/generator/printer";
import {
  ExportKind,
  INSTR,
  ValType,
  WasmModuleBuilder,
} from "../src/generator/wasm-builder";

declare const WebAssembly: {
  Module: new (bytes: Uint8Array) => unknown;
};

const SEEDS = Array.from({ length: 8 }, (_, seed) => seed);
const ALL_TEMPLATES = [...GLUE_TEMPLATES, ...GC_TEMPLATES];

function wasmSnapshot(
  program: ReturnType<(typeof ALL_TEMPLATES)[number]["build"]>,
): Array<{ name: string; bytes: number[] }> {
  return program.wasm.map((module) => ({
    name: module.name,
    bytes: Array.from(module.bytes),
  }));
}

function buildHandBuiltModules(seed: number): Uint8Array[] {
  const scalar = new WasmModuleBuilder();
  const scalarType = scalar.addType([], [ValType.I32]);
  const scalarFunction = scalar.addFunction(
    scalarType,
    [],
    [[INSTR.I32Const, seed * 17 - 31], [INSTR.End]],
  );
  scalar.addExport("scalar", ExportKind.Func, scalarFunction);

  const memory = new WasmModuleBuilder();
  const memoryType = memory.addType([], [ValType.I32]);
  memory.addMemory(1, 1);
  const memoryFunction = memory.addFunction(
    memoryType,
    [],
    [
      [INSTR.I32Const, seed * 4],
      [INSTR.I32Const, seed + 1],
      [INSTR.I32Store, 2, 16],
      [INSTR.I32Const, seed * 4],
      [INSTR.I32Load, 2, 16],
      [INSTR.End],
    ],
  );
  memory.addExport("load", ExportKind.Func, memoryFunction);

  const wide = new WasmModuleBuilder();
  const i64Type = wide.addType([], [ValType.I64]);
  const i64Function = wide.addFunction(
    i64Type,
    [],
    [
      [INSTR.I64Const, seed - 4],
      [INSTR.I64Const, seed + 9],
      [INSTR.I64Add],
      [INSTR.End],
    ],
  );
  wide.addExport("i64", ExportKind.Func, i64Function);
  const f64Type = wide.addType([], [ValType.F64]);
  const f64Function = wide.addFunction(
    f64Type,
    [],
    [
      [INSTR.F64Const, seed / 2],
      [INSTR.F64Const, 0.5],
      [INSTR.F64Add],
      [INSTR.End],
    ],
  );
  wide.addExport("f64", ExportKind.Func, f64Function);

  return [scalar.toBytes(), memory.toBytes(), wide.toBytes()];
}

describe("Wasm compile validity", () => {
  test("template names are unique", () => {
    const names = ALL_TEMPLATES.map((template) => template.name);
    expect(new Set(names).size).toBe(names.length);
  });

  describe.each(ALL_TEMPLATES)("$name", (template) => {
    test.each(SEEDS)(
      "seed %i is deterministic, parseable, and compilable",
      (seed) => {
        const first = template.build(seed);
        const second = template.build(seed);

        expect(wasmSnapshot(second)).toEqual(wasmSnapshot(first));
        expect(() =>
          parse(printProgram(first), {
            sourceType: "script",
            plugins: ["v8intrinsic"],
          }),
        ).not.toThrow();

        for (const module of first.wasm) {
          expect(
            () => new WebAssembly.Module(new Uint8Array(module.bytes)),
          ).not.toThrow();
        }
      },
    );
  });

  test.each(GLUE_TEMPLATES)(
    "$name emits seed-varied Wasm bytes",
    (template) => {
      const variants = SEEDS.map((seed) =>
        JSON.stringify(wasmSnapshot(template.build(seed))),
      );
      expect(new Set(variants).size).toBeGreaterThan(1);
    },
  );

  test.each(SEEDS)("hand-built modules compile for seed %i", (seed) => {
    for (const bytes of buildHandBuiltModules(seed)) {
      expect(() => new WebAssembly.Module(new Uint8Array(bytes))).not.toThrow();
    }
  });
});
