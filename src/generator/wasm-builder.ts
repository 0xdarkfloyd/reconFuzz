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
}

export interface CustomSection {
  name: string;
  bytes: Uint8Array;
}

export const INSTR = {
  End: 0x0b,
  Call: 0x10,
  LocalGet: 0x20,
  LocalSet: 0x21,
  LocalTee: 0x22,
  I32Const: 0x41,
  I32Add: 0x6a,
  I32Sub: 0x6b,
  I32Mul: 0x6c,
  I32DivS: 0x6d,
  Return: 0x0f,
  Drop: 0x1a,
  Nop: 0x01,
} as const;

export class WasmModuleBuilder {
  private types: FunctionType[] = [];
  private functions: FunctionDef[] = [];
  private exports: ExportDef[] = [];
  private imports: ImportDef[] = [];
  private memories: Array<{ min: number; max?: number }> = [];
  private customSections: CustomSection[] = [];

  addType(params: ValType[], results: ValType[]): number {
    const index = this.types.length;
    this.types.push({ params, results });
    return index;
  }

  addImport(module: string, name: string, kind: ImportKind.Func, typeIndex: number): number;
  addImport(module: string, name: string, kind: ImportKind, typeIndex?: number): number {
    const index = this.imports.length;
    this.imports.push({ module, name, kind, typeIndex });
    return index;
  }

  addFunction(typeIndex: number, locals: ValType[] = [], body: Instruction[]): number {
    const index = this.functions.length;
    this.functions.push({ typeIndex, locals, body });
    return index;
  }

  addExport(name: string, kind: ExportKind, index: number): void {
    this.exports.push({ name, kind, index });
  }

  addMemory(min: number, max?: number): void {
    this.memories.push({ min, max });
  }

  addCustomSection(name: string, bytes: Uint8Array): void {
    this.customSections.push({ name, bytes });
  }

  /**
   * Add the V8-specific metadata.code.instr_freq custom section.
   */
  addInstrFreqMetadata(entries: { functionIndex: number; callSiteOffsets: number[] }[]): void {
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
    this.addCustomSection('metadata.code.instr_freq', binary.bytes());
  }

  /**
   * Add the V8-specific metadata.code.call_targets custom section.
   */
  addCallTargetsMetadata(entries: { functionIndex: number; callSiteOffsets: number[] }[]): void {
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
    this.addCustomSection('metadata.code.call_targets', binary.bytes());
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
    this.addCustomSection('metadata.code.compilation_hints', binary.bytes());
  }

  toBytes(): Uint8Array {
    const binary = new BinaryWriter();

    // Magic + version
    binary.writeBytes(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));

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

    return binary.bytes();
  }

  private writeCustomSection(binary: BinaryWriter, section: CustomSection): void {
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
        if (imp.typeIndex === undefined) {
          throw new Error('Function import requires typeIndex');
        }
        section.writeU32(imp.typeIndex);
      } else {
        throw new Error('Only function imports are implemented');
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
      section.writeU8(mem.max === undefined ? 0x00 : 0x01);
      section.writeU32(mem.min);
      if (mem.max !== undefined) section.writeU32(mem.max);
    }
    binary.writeSection(5, section);
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
        for (const byte of instr) funcBody.writeU8(byte);
      }
      section.writeU32(funcBody.length());
      section.writeBytes(funcBody.bytes());
    }
    binary.writeSection(10, section);
  }

  private groupLocals(locals: ValType[]): Array<{ count: number; type: ValType }> {
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
    this.buf.push(v & 0xff);
  }

  writeU32(v: number): void {
    let value = v >>> 0;
    do {
      let byte = value & 0x7f;
      value >>>= 7;
      if (value !== 0) byte |= 0x80;
      this.buf.push(byte);
    } while (value !== 0);
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
