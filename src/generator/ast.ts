/**
 * Internal AST/IR types for reconfuzz programs.
 */
import * as t from '@babel/types';

export interface WasmModule {
  name: string;
  bytes: Uint8Array;
}

export interface ReconfuzzProgram {
  /** JavaScript source AST */
  javascript: t.File;
  /** Embedded Wasm modules */
  wasm: WasmModule[];
  /** Required d8/V8 flags */
  flags: string[];
  /** Helper scripts to include */
  includes: string[];
}

export interface VariableSlot {
  name: string;
  kind: 'var' | 'let' | 'const';
  typeHint: TypeHint;
}

export type TypeHint =
  | 'any'
  | 'number'
  | 'string'
  | 'boolean'
  | 'object'
  | 'array'
  | 'function'
  | 'typedarray'
  | 'promise'
  | 'symbol'
  | 'weakmap'
  | 'weakset'
  | 'finalizationregistry';

export class Scope {
  private variables: Map<string, VariableSlot> = new Map();
  private parent: Scope | null;

  constructor(parent: Scope | null = null) {
    this.parent = parent;
  }

  declare(name: string, kind: VariableSlot['kind'], typeHint: TypeHint = 'any'): VariableSlot {
    const slot: VariableSlot = { name, kind, typeHint };
    this.variables.set(name, slot);
    return slot;
  }

  lookup(name: string): VariableSlot | undefined {
    return this.variables.get(name) ?? this.parent?.lookup(name);
  }

  all(): VariableSlot[] {
    return Array.from(this.variables.values());
  }

  child(): Scope {
    return new Scope(this);
  }
}

let idCounter = 0;

export function freshId(prefix = '__v'): string {
  return `${prefix}_${idCounter++}`;
}

export function resetIdCounter(): void {
  idCounter = 0;
}
