/**
 * Mutator entry point.
 */
import { ReconfuzzProgram } from '../generator/ast';
import { AST_MUTATORS, AstMutator } from './ast-mutators';
import { WASM_MUTATORS, WasmMutator } from './wasm-mutators';

export interface MutatorConfig {
  astMutators?: AstMutator[];
  wasmMutators?: WasmMutator[];
  astProbability?: number;
  wasmProbability?: number;
}

export const DEFAULT_MUTATOR_CONFIG: MutatorConfig = {
  astMutators: AST_MUTATORS,
  wasmMutators: WASM_MUTATORS,
  astProbability: 0.8,
  wasmProbability: 0.2,
};

export class Mutator {
  private config: MutatorConfig;

  constructor(config: Partial<MutatorConfig> = {}) {
    this.config = { ...DEFAULT_MUTATOR_CONFIG, ...config };
  }

  mutate(program: ReconfuzzProgram): ReconfuzzProgram {
    let mutated = program;

    if (this.config.astMutators && this.config.astMutators.length > 0 && Math.random() < (this.config.astProbability ?? 0)) {
      const mutator = this.pick(this.config.astMutators);
      mutated = {
        ...mutated,
        javascript: mutator(mutated.javascript),
      };
    }

    if (
      this.config.wasmMutators &&
      this.config.wasmMutators.length > 0 &&
      mutated.wasm.length > 0 &&
      Math.random() < (this.config.wasmProbability ?? 0)
    ) {
      const mutator = this.pick(this.config.wasmMutators);
      mutated = {
        ...mutated,
        wasm: mutated.wasm.map((m) => mutator(m)),
      };
    }

    return mutated;
  }

  private pick<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  }
}

export { AST_MUTATORS, WASM_MUTATORS };
