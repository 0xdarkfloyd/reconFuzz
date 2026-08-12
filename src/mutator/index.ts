/**
 * Mutator entry point.
 */
import { ReconfuzzProgram } from '../generator/ast';
import * as t from '@babel/types';
import { AST_MUTATORS, AstMutator } from './ast-mutators';
import { WASM_MUTATORS, WasmMutator } from './wasm-mutators';

export interface MutatorConfig {
  astMutators?: AstMutator[];
  wasmMutators?: WasmMutator[];
  astProbability?: number;
  wasmProbability?: number;
  rng?: () => number;
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
    this.validateProbability('astProbability', this.config.astProbability);
    this.validateProbability('wasmProbability', this.config.wasmProbability);
  }

  /** Apply selected mutators without letting one failure abort the iteration. */
  mutate(program: ReconfuzzProgram): ReconfuzzProgram {
    if (
      typeof program !== 'object' ||
      program === null ||
      typeof program.javascript !== 'object' ||
      program.javascript === null ||
      !Array.isArray(program.wasm)
    ) {
      throw new TypeError(
        'program must be a ReconfuzzProgram with .javascript (AST object) and .wasm (array)',
      );
    }

    let mutated = program;
    const rng = this.config.rng ?? Math.random;

    if (this.config.astMutators && this.config.astMutators.length > 0 && rng() < (this.config.astProbability ?? 0)) {
      const mutator = this.pick(this.config.astMutators, rng);
      const mutatorIndex = this.config.astMutators.indexOf(mutator);
      const javascript = mutated.javascript;
      try {
        const nextJavascript = mutator(javascript, rng);
        if (!nextJavascript || !t.isFile(nextJavascript)) {
          throw new TypeError('AST mutator returned a non-File value');
        }
        mutated = {
          ...mutated,
          javascript: nextJavascript,
        };
      } catch {
        console.warn(
          `AST mutator ${this.mutatorLabel(mutator, mutatorIndex)} failed; keeping original JavaScript`,
        );
      }
    }

    if (
      this.config.wasmMutators &&
      this.config.wasmMutators.length > 0 &&
      mutated.wasm.length > 0 &&
      rng() < (this.config.wasmProbability ?? 0)
    ) {
      const mutator = this.pick(this.config.wasmMutators, rng);
      const mutatorIndex = this.config.wasmMutators.indexOf(mutator);
      mutated = {
        ...mutated,
        wasm: mutated.wasm.map((module, moduleIndex) => {
          try {
            const nextModule = mutator(module, rng);
            if (
              !nextModule ||
              typeof nextModule.name !== 'string' ||
              !(nextModule.bytes instanceof Uint8Array)
            ) {
              throw new TypeError('Wasm mutator returned an invalid module');
            }
            return nextModule;
          } catch {
            console.warn(
              `WASM mutator ${this.mutatorLabel(mutator, mutatorIndex)} failed for module ${moduleIndex}; keeping original module`,
            );
            return module;
          }
        }),
      };
    }

    return mutated;
  }

  private pick<T>(arr: T[], rng: () => number): T {
    if (arr.length === 0) {
      throw new RangeError('pick() called with an empty array');
    }
    const sample = rng();
    if (!Number.isFinite(sample)) {
      throw new RangeError('rng() must return a finite number');
    }
    const unit = Math.min(1 - Number.EPSILON, Math.max(0, sample));
    return arr[Math.floor(unit * arr.length)];
  }

  private validateProbability(name: string, value: number | undefined): void {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`${name} must be a finite number between 0 and 1`);
    }
  }

  private mutatorLabel(
    mutator: AstMutator | WasmMutator | undefined,
    index: number,
  ): string {
    const name = mutator ? (mutator as { name?: string }).name : undefined;
    return `${name || 'anonymous'} (index ${index})`;
  }
}

export { AST_MUTATORS, WASM_MUTATORS };
