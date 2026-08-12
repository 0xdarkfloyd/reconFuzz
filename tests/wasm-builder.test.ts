import {
  BinaryWriter,
  ExportKind,
  ImportKind,
  INSTR,
  WasmModuleBuilder,
} from "../src/generator/wasm-builder";

function readU32(bytes: Uint8Array, start: number): [number, number] {
  let value = 0;
  let shift = 0;
  let offset = start;
  for (;;) {
    const byte = bytes[offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [value, offset];
    shift += 7;
  }
}

function getSection(bytes: Uint8Array, sectionId: number): Uint8Array {
  let offset = 8;
  while (offset < bytes.length) {
    const id = bytes[offset++];
    const [length, payloadStart] = readU32(bytes, offset);
    if (id === sectionId)
      return bytes.slice(payloadStart, payloadStart + length);
    offset = payloadStart + length;
  }
  throw new Error(`Section ${sectionId} not found`);
}

describe("WasmModuleBuilder", () => {
  test("appends End to a function body that omits it", () => {
    const builder = new WasmModuleBuilder();
    const typeIndex = builder.addType([], []);
    builder.addFunction(typeIndex, [], [[INSTR.Nop]]);

    const bytes = builder.toBytes();

    expect(bytes[bytes.length - 1]).toBe(INSTR.End);
  });

  test.each([INSTR.Call, INSTR.LocalGet])(
    "rejects opcode 0x%s when its required immediate is missing",
    (opcode) => {
      const builder = new WasmModuleBuilder();
      const typeIndex = builder.addType([], []);
      builder.addFunction(typeIndex, [], [[opcode]]);

      expect(() => builder.toBytes()).toThrow(
        /requires exactly one unsigned immediate/,
      );
    },
  );

  test("uses the combined imported and local memory index space", () => {
    const builder = new WasmModuleBuilder();
    expect(
      builder.addImport("neutral", "imported", ImportKind.Mem, { min: 1 }),
    ).toBe(0);
    const localMemoryIndex = builder.addMemory(1, 2);
    expect(localMemoryIndex).toBe(1);
    builder.addExport("local", ExportKind.Mem, localMemoryIndex);
    builder.addData(0, new Uint8Array([0xaa]), localMemoryIndex);

    const bytes = builder.toBytes();
    const exportSection = getSection(bytes, 7);
    const dataSection = getSection(bytes, 11);

    expect(Array.from(exportSection.slice(-2))).toEqual([ExportKind.Mem, 1]);
    expect(Array.from(dataSection.slice(0, 3))).toEqual([1, 2, 1]);
  });

  test.each([-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])(
    "rejects invalid unsigned writer input %s",
    (value) => {
      const writer = new BinaryWriter();
      expect(() => writer.writeU32(value)).toThrow(/u32 value/);
    },
  );

  test("preserves the encoding of a valid module", () => {
    const builder = new WasmModuleBuilder();
    const typeIndex = builder.addType([], []);
    const functionIndex = builder.addFunction(
      typeIndex,
      [],
      [[INSTR.I32Const, 7], [INSTR.Drop], [INSTR.End]],
    );
    builder.addExport("f", ExportKind.Func, functionIndex);

    const bytes = builder.toBytes();

    expect(Array.from(bytes)).toEqual([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60,
      0x00, 0x00, 0x03, 0x02, 0x01, 0x00, 0x07, 0x05, 0x01, 0x01, 0x66, 0x00,
      0x00, 0x0a, 0x07, 0x01, 0x05, 0x00, 0x41, 0x07, 0x1a, 0x0b,
    ]);
  });
});
