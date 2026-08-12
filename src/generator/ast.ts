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
  | 'bigint'
  | 'string'
  | 'boolean'
  | 'object'
  | 'array'
  | 'function'
  | 'class'
  | 'typedarray'
  | 'promise'
  | 'symbol'
  | 'map'
  | 'set'
  | 'weakref'
  | 'weakmap'
  | 'weakset'
  | 'finalizationregistry'
  | 'proxy';

export interface ScopeDeclareOptions {
  /** Throw when the name is already declared in this scope. */
  throwOnRedeclare?: boolean;
}

export class Scope {
  private variables: Map<string, VariableSlot> = new Map();
  private parent: Scope | null;

  /** Create a scope with an optional enclosing scope. */
  constructor(parent: Scope | null = null) {
    this.parent = parent;
  }

  /**
   * Declare a variable in this scope.
   *
   * Identical redeclarations return the existing slot. Other redeclarations
   * preserve the historical overwrite behavior unless explicitly rejected.
   */
  declare(
    name: string,
    kind: VariableSlot['kind'],
    typeHint: TypeHint = 'any',
    options: ScopeDeclareOptions = {},
  ): VariableSlot {
    const existing = this.variables.get(name);
    if (existing) {
      if (options.throwOnRedeclare) {
        throw new Error(`Variable already declared in this scope: ${name}`);
      }
      if (existing.kind === kind && existing.typeHint === typeHint) {
        return existing;
      }
    }

    const slot: VariableSlot = { name, kind, typeHint };
    this.variables.set(name, slot);
    return slot;
  }

  /** Return whether a variable is declared directly in this scope. */
  has(name: string): boolean {
    return this.variables.has(name);
  }

  /** Look up a variable in this scope or the nearest enclosing scope. */
  lookup(name: string): VariableSlot | undefined {
    return this.variables.get(name) ?? this.parent?.lookup(name);
  }

  /** Return the variables declared directly in this scope. */
  all(): VariableSlot[] {
    return Array.from(this.variables.values());
  }

  /** All variables visible from this scope, including ancestors. */
  allVisible(): VariableSlot[] {
    const vars = Array.from(this.variables.values());
    const visited = new Set<Scope>([this]);
    let scope = this.parent;

    while (scope && !visited.has(scope)) {
      visited.add(scope);
      vars.push(...scope.variables.values());
      scope = scope.parent;
    }

    return vars;
  }

  /** Create a child scope whose parent is this scope. */
  child(): Scope {
    return new Scope(this);
  }
}

let idCounter = 0;

/**
 * Return a fresh identifier using the process/module-global counter.
 */
export function freshId(prefix = '__v'): string {
  return `${prefix}_${idCounter++}`;
}

/** Reset the process/module-global identifier counter to zero. */
export function resetIdCounter(): void {
  idCounter = 0;
}

/** Return the current value of the process/module-global identifier counter. */
export function getIdCounter(): number {
  return idCounter;
}

/**
 * Advance the counter past a nonnegative safe integer if needed. Invalid
 * values are ignored. Used by crossover: corpus seeds
 * (lokihardt style) already contain __v_N names, and a collision with a
 * fresh generated let/const of the same name is a SyntaxError.
 */
export function ensureIdCounterAbove(n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) return;
  if (idCounter <= n) idCounter = n + 1;
}
