/**
 * WebAssembly module builder for V8 stress testing.
 *
 * Encodes standard sections and V8-specific custom sections observed in the
 * big_sleep corpus, such as metadata.code.* sections and compilation hints.
 *
 * This is a self-contained encoder (no external wasm-encoder dependency) so
 * that every byte is under our control, matching the hand-rolled builders in
 * the historical POCs.
 */

export enum ValType {
  I32 = 0x7f,
  I64 = 0x7e,
  F32 = 0x7d,
  F64 = 0x7c,
  V128 = 0x7b,
  FuncRef = 0x70,
  ExternRef = 0x6f,
}

export enum ExportKind {
  Func = 0x00,
  Table = 0x01,
  Mem = 0x02,
  Global = 0x03,
}

export enum ImportKind {
  Func = 0x00,
  Table = 0x01,
  Mem = 0x02,
  Global = 0x03,
}

export type Instruction = number[];

export interface FunctionType {
  params: ValType[];
  results: ValType[];
}

export interface FunctionDef {
  typeIndex: number;
  locals: ValType[];
  body: Instruction[];
}

export interface MemoryType {
  min: number;
  max?: number;
}

export interface TableType {
  elementType: ValType.FuncRef | ValType.ExternRef;
  min: number;
  max?: number;
}

export interface GlobalType {
  valueType: ValType;
  mutable?: boolean;
}

export interface ExportDef {
  name: string;
  kind: ExportKind;
  index: number;
}

export interface ImportDef {
  module: string;
  name: string;
  kind: ImportKind;
  typeIndex?: number;
  memory?: MemoryType;
  table?: TableType;
  global?: GlobalType;
}

export interface DataSegment {
  memoryIndex: number;
  offset: number;
  bytes: Uint8Array;
}

export interface CustomSection {
  name: string;
  bytes: Uint8Array;
}

export const INSTR = {
  End: 0x0b,
  Call: 0x10,
  CallIndirect: 0x11,
  GlobalGet: 0x23,
  GlobalSet: 0x24,
  LocalGet: 0x20,
  LocalSet: 0x21,
  LocalTee: 0x22,
  I32Const: 0x41,
  I64Const: 0x42,
  F64Const: 0x44,
  I32Add: 0x6a,
  I32Sub: 0x6b,
  I32Mul: 0x6c,
  I32DivS: 0x6d,
  I64Add: 0x7c,
  I64Sub: 0x7d,
  F64Add: 0xa0,
  I32Load: 0x28,
  I32Load8S: 0x2c,
  I32Load8U: 0x2d,
  I32Load16S: 0x2e,
  I32Load16U: 0x2f,
  I32Store: 0x36,
  I32Store8: 0x3a,
  I32Store16: 0x3b,
  MemorySize: 0x3f,
  MemoryGrow: 0x40,
  Return: 0x0f,
  Drop: 0x1a,
  Nop: 0x01,
} as const;

const MEMARG_OPS = new Set<number>([
  INSTR.I32Load,
  INSTR.I32Load8S,
  INSTR.I32Load8U,
  INSTR.I32Load16S,
  INSTR.I32Load16U,
  INSTR.I32Store,
  INSTR.I32Store8,
  INSTR.I32Store16,
]);

const U32_MAX = 0xffff_ffff;
const I32_MIN = -0x8000_0000;
const I32_MAX = 0x7fff_ffff;
const MEMORY32_MAX_PAGES = 65_536;
const VALID_VAL_TYPES = new Set<number>(
  Object.values(ValType).filter((value) => typeof value === "number"),
);

function assertIntegerInRange(
  value: number,
  min: number,
  max: number,
  label: string,
): void {
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
}

function assertU32(value: number, label: string): void {
  assertIntegerInRange(value, 0, U32_MAX, label);
}

function assertI32(value: number, label: string): void {
  assertIntegerInRange(value, I32_MIN, I32_MAX, label);
}

export class WasmModuleBuilder {
  private types: FunctionType[] = [];
  private functions: FunctionDef[] = [];
  private exports: ExportDef[] = [];
  private imports: ImportDef[] = [];
  private memories: MemoryType[] = [];
  private dataSegments: DataSegment[] = [];
  private customSections: CustomSection[] = [];

  addType(params: ValType[], results: ValType[]): number {
    const index = this.types.length;
    this.types.push({ params, results });
    return index;
  }

  addImport(
    module: string,
    name: string,
    kind: ImportKind.Func,
    typeIndex: number,
  ): number;
  addImport(
    module: string,
    name: string,
    kind: ImportKind,
    descriptor?: number | MemoryType | TableType | GlobalType,
  ): number;
  addImport(
    module: string,
    name: string,
    kind: ImportKind,
    descriptor?: number | MemoryType | TableType | GlobalType,
  ): number {
    if (kind === ImportKind.Func && this.functions.length > 0) {
      throw new Error(
        "Function imports must be declared before local functions",
      );
    }
    if (kind === ImportKind.Mem && this.memories.length > 0) {
      throw new Error("Memory imports must be declared before local memories");
    }
    const index = this.imports.filter((imp) => imp.kind === kind).length;
    const imp: ImportDef = { module, name, kind };
    if (kind === ImportKind.Func) {
      if (typeof descriptor !== "number") {
        throw new Error("Function import requires typeIndex");
      }
      assertU32(descriptor, "Function import type index");
      imp.typeIndex = descriptor;
    } else if (kind === ImportKind.Mem) {
      const memory =
        typeof descriptor === "object" && descriptor !== null
          ? (descriptor as MemoryType)
          : { min: typeof descriptor === "number" ? descriptor : 0 };
      this.validateLimits(memory.min, memory.max, "Memory", MEMORY32_MAX_PAGES);
      imp.memory = { ...memory };
    } else if (kind === ImportKind.Table) {
      const table: TableType =
        typeof descriptor === "object" && descriptor !== null
          ? (descriptor as TableType)
          : {
              elementType: ValType.FuncRef,
              min: typeof descriptor === "number" ? descriptor : 0,
            };
      if (
        table.elementType !== ValType.FuncRef &&
        table.elementType !== ValType.ExternRef
      ) {
        throw new Error("Table element type must be FuncRef or ExternRef");
      }
      this.validateLimits(table.min, table.max, "Table");
      imp.table = { ...table };
    } else if (kind === ImportKind.Global) {
      const global =
        typeof descriptor === "object" && descriptor !== null
          ? (descriptor as GlobalType)
          : { valueType: ValType.I32, mutable: false };
      if (!VALID_VAL_TYPES.has(global.valueType)) {
        throw new Error("Global value type is invalid");
      }
      if (global.mutable !== undefined && typeof global.mutable !== "boolean") {
        throw new Error("Global mutable flag must be boolean");
      }
      imp.global = { ...global };
    } else {
      throw new Error(`Unsupported import kind: ${String(kind)}`);
    }
    this.imports.push(imp);
    return index;
  }

  addFunction(
    typeIndex: number,
    locals: ValType[] = [],
    body: Instruction[],
  ): number {
    // Wasm function indices include imported functions. Callers commonly use
    // the returned index directly as a call/export immediate, so account for
    // imports that were declared before this function.
    assertU32(typeIndex, "Function type index");
    const index = this.importedFunctionCount() + this.functions.length;
    this.functions.push({ typeIndex, locals, body });
    return index;
  }

  addExport(name: string, kind: ExportKind, index: number): void {
    if (this.exports.some((exp) => exp.name === name)) {
      throw new Error(`Duplicate export name: ${name}`);
    }
    if (!Object.values(ExportKind).includes(kind)) {
      throw new Error(`Unsupported export kind: ${String(kind)}`);
    }
    assertU32(index, "Export index");
    this.exports.push({ name, kind, index });
  }

  addMemory(min: number, max?: number): number {
    this.validateLimits(min, max, "Memory", MEMORY32_MAX_PAGES);
    const index = this.importedMemoryCount() + this.memories.length;
    this.memories.push({ min, max });
    return index;
  }

  /** Add an active data segment initialized at an i32 byte offset. */
  addData(offset: number, bytes: Uint8Array, memoryIndex = 0): void {
    assertI32(offset, "Data segment offset");
    assertU32(memoryIndex, "Data segment memory index");
    if (!(bytes instanceof Uint8Array)) {
      throw new Error("Data segment bytes must be a Uint8Array");
    }
    this.dataSegments.push({
      memoryIndex,
      offset,
      bytes: new Uint8Array(bytes),
    });
  }

  addCustomSection(name: string, bytes: Uint8Array): void {
    this.customSections.push({ name, bytes });
  }

  /**
   * Add the V8-specific metadata.code.instr_freq custom section.
   */
  addInstrFreqMetadata(
    entries: { functionIndex: number; callSiteOffsets: number[] }[],
  ): void {
    const binary = new BinaryWriter();
    binary.writeU32(entries.length);
    for (const entry of entries) {
      binary.writeU32(entry.functionIndex);
      binary.writeU32(entry.callSiteOffsets.length);
      for (const offset of entry.callSiteOffsets) {
        binary.writeU32(offset);
        binary.writeU32(1); // frequency
        binary.writeU8(32); // bits
      }
    }
    this.addCustomSection("metadata.code.instr_freq", binary.bytes());
  }

  /**
   * Add the V8-specific metadata.code.call_targets custom section.
   */
  addCallTargetsMetadata(
    entries: { functionIndex: number; callSiteOffsets: number[] }[],
  ): void {
    const binary = new BinaryWriter();
    binary.writeU32(entries.length);
    for (const entry of entries) {
      binary.writeU32(entry.functionIndex);
      binary.writeU32(entry.callSiteOffsets.length);
      for (const offset of entry.callSiteOffsets) {
        binary.writeU32(offset);
        binary.writeU32(0); // empty target payload
      }
    }
    this.addCustomSection("metadata.code.call_targets", binary.bytes());
  }

  /**
   * Add the V8-specific metadata.code.compilation_hints custom section.
   */
  addCompilationHintsMetadata(hints: number[]): void {
    const binary = new BinaryWriter();
    binary.writeU32(hints.length);
    for (const hint of hints) {
      binary.writeU8(hint);
    }
    this.addCustomSection("metadata.code.compilation_hints", binary.bytes());
  }

  toBytes(): Uint8Array {
    this.validateModuleIndices();
    const binary = new BinaryWriter();

    // Magic + version
    binary.writeBytes(
      new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    );

    // Custom sections can appear anywhere; emit early ones first.
    for (const section of this.customSections) {
      this.writeCustomSection(binary, section);
    }

    this.writeTypeSection(binary);
    this.writeImportSection(binary);
    this.writeFunctionSection(binary);
    this.writeMemorySection(binary);
    this.writeExportSection(binary);
    this.writeCodeSection(binary);
    this.writeDataSection(binary);

    return binary.bytes();
  }

  private importedFunctionCount(): number {
    return this.imports.filter((imp) => imp.kind === ImportKind.Func).length;
  }

  private importedMemoryCount(): number {
    return this.imports.filter((imp) => imp.kind === ImportKind.Mem).length;
  }

  private importedTableCount(): number {
    return this.imports.filter((imp) => imp.kind === ImportKind.Table).length;
  }

  private importedGlobalCount(): number {
    return this.imports.filter((imp) => imp.kind === ImportKind.Global).length;
  }

  private validateLimits(
    min: number,
    max: number | undefined,
    label: string,
    upperBound = U32_MAX,
  ): void {
    assertIntegerInRange(min, 0, upperBound, `${label} minimum`);
    if (max !== undefined) {
      assertIntegerInRange(max, 0, upperBound, `${label} maximum`);
      if (max < min) {
        throw new Error(
          `${label} maximum must be greater than or equal to its minimum`,
        );
      }
    }
  }

  private validateModuleIndices(): void {
    for (const imp of this.imports) {
      if (
        imp.kind === ImportKind.Func &&
        (imp.typeIndex === undefined || imp.typeIndex >= this.types.length)
      ) {
        throw new Error(
          `Function import type index ${String(imp.typeIndex)} is out of range`,
        );
      }
    }

    for (const fn of this.functions) {
      if (fn.typeIndex >= this.types.length) {
        throw new Error(`Function type index ${fn.typeIndex} is out of range`);
      }
    }

    const indexSpaceSizes: Record<ExportKind, number> = {
      [ExportKind.Func]: this.importedFunctionCount() + this.functions.length,
      [ExportKind.Table]: this.importedTableCount(),
      [ExportKind.Mem]: this.importedMemoryCount() + this.memories.length,
      [ExportKind.Global]: this.importedGlobalCount(),
    };
    for (const exp of this.exports) {
      if (exp.index >= indexSpaceSizes[exp.kind]) {
        throw new Error(
          `Export ${exp.name} index ${exp.index} is out of range`,
        );
      }
    }

    const memoryCount = this.importedMemoryCount() + this.memories.length;
    for (const segment of this.dataSegments) {
      if (segment.memoryIndex >= memoryCount) {
        throw new Error(
          `Data segment memory index ${segment.memoryIndex} is out of range`,
        );
      }
    }
  }

  private writeCustomSection(
    binary: BinaryWriter,
    section: CustomSection,
  ): void {
    const payload = new BinaryWriter();
    payload.writeString(section.name);
    payload.writeBytes(section.bytes);
    binary.writeSection(0, payload);
  }

  private writeTypeSection(binary: BinaryWriter): void {
    if (this.types.length === 0) return;
    const section = new BinaryWriter();
    section.writeU32(this.types.length);
    for (const type of this.types) {
      section.writeU8(0x60); // func type
      section.writeU32(type.params.length);
      for (const p of type.params) section.writeU8(p);
      section.writeU32(type.results.length);
      for (const r of type.results) section.writeU8(r);
    }
    binary.writeSection(1, section);
  }

  private writeImportSection(binary: BinaryWriter): void {
    if (this.imports.length === 0) return;
    const section = new BinaryWriter();
    section.writeU32(this.imports.length);
    for (const imp of this.imports) {
      section.writeString(imp.module);
      section.writeString(imp.name);
      section.writeU8(imp.kind);
      if (imp.kind === ImportKind.Func) {
        if (imp.typeIndex === undefined)
          throw new Error("Function import requires typeIndex");
        section.writeU32(imp.typeIndex);
      } else if (imp.kind === ImportKind.Table) {
        const table = imp.table ?? { elementType: ValType.FuncRef, min: 0 };
        section.writeU8(table.elementType);
        this.writeLimits(section, table.min, table.max);
      } else if (imp.kind === ImportKind.Mem) {
        const memory = imp.memory ?? { min: 0 };
        this.writeLimits(section, memory.min, memory.max);
      } else if (imp.kind === ImportKind.Global) {
        const global = imp.global ?? { valueType: ValType.I32, mutable: false };
        section.writeU8(global.valueType);
        section.writeU8(global.mutable ? 1 : 0);
      } else {
        throw new Error(`Unsupported import kind: ${String(imp.kind)}`);
      }
    }
    binary.writeSection(2, section);
  }

  private writeFunctionSection(binary: BinaryWriter): void {
    if (this.functions.length === 0) return;
    const section = new BinaryWriter();
    section.writeU32(this.functions.length);
    for (const fn of this.functions) {
      section.writeU32(fn.typeIndex);
    }
    binary.writeSection(3, section);
  }

  private writeMemorySection(binary: BinaryWriter): void {
    if (this.memories.length === 0) return;
    const section = new BinaryWriter();
    section.writeU32(this.memories.length);
    for (const mem of this.memories) {
      this.writeLimits(section, mem.min, mem.max);
    }
    binary.writeSection(5, section);
  }

  private writeLimits(section: BinaryWriter, min: number, max?: number): void {
    section.writeU8(max === undefined ? 0x00 : 0x01);
    section.writeU32(min);
    if (max !== undefined) section.writeU32(max);
  }

  private writeExportSection(binary: BinaryWriter): void {
    if (this.exports.length === 0) return;
    const section = new BinaryWriter();
    section.writeU32(this.exports.length);
    for (const exp of this.exports) {
      section.writeString(exp.name);
      section.writeU8(exp.kind);
      section.writeU32(exp.index);
    }
    binary.writeSection(7, section);
  }

  private writeCodeSection(binary: BinaryWriter): void {
    if (this.functions.length === 0) return;
    const section = new BinaryWriter();
    section.writeU32(this.functions.length);
    for (const fn of this.functions) {
      const funcBody = new BinaryWriter();
      // locals: group consecutive same-type locals
      const localGroups = this.groupLocals(fn.locals);
      funcBody.writeU32(localGroups.length);
      for (const group of localGroups) {
        funcBody.writeU32(group.count);
        funcBody.writeU8(group.type);
      }
      for (const instr of fn.body) {
        this.writeInstruction(funcBody, instr);
      }
      if (
        fn.body.length === 0 ||
        fn.body[fn.body.length - 1][0] !== INSTR.End
      ) {
        this.writeInstruction(funcBody, [INSTR.End]);
      }
      section.writeU32(funcBody.length());
      section.writeBytes(funcBody.bytes());
    }
    binary.writeSection(10, section);
  }

  private writeInstruction(binary: BinaryWriter, instr: Instruction): void {
    const [op, ...immediates] = instr;
    binary.writeU8(op);

    // Immediates are LEB128, not raw bytes. Memory operations carry a pair of
    // u32 memarg fields (alignment exponent, then byte offset); the remaining
    // supported instructions use either a signed i32 or a single u32.
    if (op === INSTR.I32Const) {
      if (immediates.length !== 1) {
        throw new Error("I32Const requires exactly one signed immediate");
      }
      binary.writeI32(immediates[0]);
      return;
    }

    if (op === INSTR.I64Const) {
      if (immediates.length !== 1) {
        throw new Error("I64Const requires exactly one signed immediate");
      }
      binary.writeI64(immediates[0]);
      return;
    }

    if (op === INSTR.F64Const) {
      if (immediates.length !== 1) {
        throw new Error("F64Const requires exactly one numeric immediate");
      }
      binary.writeF64(immediates[0]);
      return;
    }

    if (MEMARG_OPS.has(op)) {
      if (immediates.length !== 2) {
        throw new Error(
          "Memory instructions require alignment and offset immediates",
        );
      }
      for (const imm of immediates) binary.writeU32(imm);
      return;
    }

    if (
      op === INSTR.Call ||
      op === INSTR.LocalGet ||
      op === INSTR.LocalSet ||
      op === INSTR.LocalTee ||
      op === INSTR.GlobalGet ||
      op === INSTR.GlobalSet
    ) {
      if (immediates.length !== 1) {
        throw new Error(
          `Instruction 0x${op.toString(16)} requires exactly one unsigned immediate`,
        );
      }
      binary.writeU32(immediates[0]);
      return;
    }

    if (op === INSTR.CallIndirect) {
      if (immediates.length !== 2 || immediates[1] !== 0) {
        throw new Error(
          "CallIndirect requires a type index followed by the 0x00 table byte",
        );
      }
      binary.writeU32(immediates[0]);
      binary.writeU8(immediates[1]);
      return;
    }

    if (op === INSTR.MemorySize || op === INSTR.MemoryGrow) {
      if (immediates.length !== 0) {
        throw new Error(
          `Instruction 0x${op.toString(16)} does not accept immediates`,
        );
      }
      binary.writeU8(0);
      return;
    }

    if (
      op === INSTR.End ||
      op === INSTR.I32Add ||
      op === INSTR.I32Sub ||
      op === INSTR.I32Mul ||
      op === INSTR.I32DivS ||
      op === INSTR.I64Add ||
      op === INSTR.I64Sub ||
      op === INSTR.F64Add ||
      op === INSTR.Return ||
      op === INSTR.Drop ||
      op === INSTR.Nop
    ) {
      if (immediates.length !== 0) {
        throw new Error(
          `Instruction 0x${op.toString(16)} does not accept immediates`,
        );
      }
      return;
    }

    throw new Error(`Unsupported instruction opcode: 0x${op.toString(16)}`);
  }

  private writeDataSection(binary: BinaryWriter): void {
    if (this.dataSegments.length === 0) return;
    const section = new BinaryWriter();
    section.writeU32(this.dataSegments.length);
    for (const segment of this.dataSegments) {
      // Flag 0 is the compact form for memory 0. Flag 2 carries an explicit
      // memory index and is required for multi-memory data segments.
      if (segment.memoryIndex === 0) {
        section.writeU32(0);
      } else {
        section.writeU32(2);
        section.writeU32(segment.memoryIndex);
      }
      section.writeU8(INSTR.I32Const);
      section.writeI32(segment.offset);
      section.writeU8(INSTR.End);
      section.writeU32(segment.bytes.length);
      section.writeBytes(segment.bytes);
    }
    binary.writeSection(11, section);
  }

  private groupLocals(
    locals: ValType[],
  ): Array<{ count: number; type: ValType }> {
    const groups: Array<{ count: number; type: ValType }> = [];
    for (const local of locals) {
      const last = groups[groups.length - 1];
      if (last && last.type === local) {
        last.count++;
      } else {
        groups.push({ count: 1, type: local });
      }
    }
    return groups;
  }
}

/**
 * Minimal LEB128 / u32 / string writer for Wasm and custom section payloads.
 */
export class BinaryWriter {
  private buf: number[] = [];

  writeU8(v: number): void {
    assertIntegerInRange(v, 0, 0xff, "u8 value");
    this.buf.push(v);
  }

  writeU32(v: number): void {
    assertU32(v, "u32 value");
    let value = v;
    do {
      let byte = value & 0x7f;
      value >>>= 7;
      if (value !== 0) byte |= 0x80;
      this.buf.push(byte);
    } while (value !== 0);
  }

  /** Signed LEB128, for i32.const and other signed immediates. */
  writeI32(v: number): void {
    assertI32(v, "i32 value");
    let value = v;
    for (;;) {
      let byte = value & 0x7f;
      value >>= 7;
      const done =
        (value === 0 && (byte & 0x40) === 0) ||
        (value === -1 && (byte & 0x40) !== 0);
      if (!done) byte |= 0x80;
      this.buf.push(byte);
      if (done) break;
    }
  }

  /** Signed LEB128 for exactly representable JavaScript integer values. */
  writeI64(v: number): void {
    if (!Number.isSafeInteger(v)) {
      throw new Error("i64 value must be a safe integer");
    }
    let value = BigInt(v);
    for (;;) {
      let byte = Number(value & 0x7fn);
      value >>= 7n;
      const done =
        (value === 0n && (byte & 0x40) === 0) ||
        (value === -1n && (byte & 0x40) !== 0);
      if (!done) byte |= 0x80;
      this.buf.push(byte);
      if (done) break;
    }
  }

  /** IEEE-754 little-endian encoding used by f64.const. */
  writeF64(v: number): void {
    if (typeof v !== "number") {
      throw new Error("f64 value must be a number");
    }
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, v, true);
    this.writeBytes(bytes);
  }

  writeString(s: string): void {
    const bytes = new TextEncoder().encode(s);
    this.writeU32(bytes.length);
    for (const b of bytes) this.buf.push(b);
  }

  writeBytes(bytes: Uint8Array): void {
    for (const b of bytes) this.buf.push(b);
  }

  writeSection(id: number, content: BinaryWriter): void {
    this.writeU8(id);
    this.writeU32(content.length());
    this.writeBytes(content.bytes());
  }

  length(): number {
    return this.buf.length;
  }

  bytes(): Uint8Array {
    return new Uint8Array(this.buf);
  }
}
