/**
 * Generator entry point.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as t from '@babel/types';
import { ReconfuzzProgram, resetIdCounter } from './ast';
import { GC_TEMPLATES } from './gc-templates';
import { GrammarConfig, JsGrammar, mulberry32 } from './js-grammar';
import { GLUE_TEMPLATES } from './js-wasm-glue';
import { printProgram } from './printer';

export interface GeneratorConfig {
  seed?: number;
  mode: 'js-only' | 'wasm-only' | 'hybrid' | 'gc-only';
  js?: Partial<GrammarConfig>;
}

const GENERATOR_MODES: readonly GeneratorConfig['mode'][] = [
  'js-only',
  'wasm-only',
  'hybrid',
  'gc-only',
];

const USAGE =
  'Usage: reconfuzz [--output PATH] [--mode js-only|wasm-only|hybrid|gc-only] [--seed INTEGER]';

class CliArgumentError extends Error {}

function isGeneratorMode(value: string): value is GeneratorConfig['mode'] {
  return GENERATOR_MODES.includes(value as GeneratorConfig['mode']);
}

function validateSeed(seed: number): void {
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError(`Invalid seed: ${seed}`);
  }
}

export class Generator {
  private config: GeneratorConfig;
  private jsGrammar: JsGrammar;
  private templateRng: () => number;

  constructor(config: GeneratorConfig) {
    if (!isGeneratorMode(config.mode)) {
      throw new RangeError(`Unknown mode: ${String(config.mode)}`);
    }
    const seed = config.seed ?? 0;
    validateSeed(seed);

    this.config = { ...config };
    this.jsGrammar = new JsGrammar(config.js ?? {}, seed);
    this.templateRng = mulberry32(seed ^ 0x9e3779b9);
  }

  setSeed(seed: number): void {
    validateSeed(seed);
    this.config.seed = seed;
    this.jsGrammar.setSeed(seed);
    this.templateRng = mulberry32(seed ^ 0x9e3779b9);
  }

  /**
   * Seed-driven template pick. Math.random() here previously made --seed
   * non-reproducible: a crash found at iteration N could not be regenerated
   * from seed N.
   */
  private pickTemplate<T>(templates: readonly T[]): T | undefined {
    if (templates.length === 0) return undefined;
    return templates[Math.floor(this.templateRng() * templates.length)];
  }

  private mergeWasmModules(
    ...groups: ReconfuzzProgram['wasm'][]
  ): ReconfuzzProgram['wasm'] {
    const modules = new Map<string, ReconfuzzProgram['wasm'][number]>();
    for (const group of groups) {
      for (const module of group) {
        const existing = modules.get(module.name);
        if (!existing) {
          modules.set(module.name, module);
          continue;
        }
        const sameBytes =
          existing.bytes.length === module.bytes.length &&
          existing.bytes.every((byte, index) => byte === module.bytes[index]);
        if (!sameBytes) {
          throw new Error(`Conflicting Wasm module name: ${module.name}`);
        }
      }
    }
    return Array.from(modules.values());
  }

  generate(): ReconfuzzProgram {
    resetIdCounter();

    switch (this.config.mode) {
      case 'wasm-only':
        return this.generateWasmProgram();
      case 'gc-only':
        return this.generateGcProgram();
      case 'hybrid':
        return this.generateHybridProgram();
      case 'js-only':
        return this.generateJsProgram();
      default:
        throw new Error(`Unknown mode: ${String(this.config.mode)}`);
    }
  }

  private generateJsProgram(): ReconfuzzProgram {
    const ast = this.jsGrammar.generateProgram();
    return {
      javascript: ast,
      wasm: [],
      flags: [...this.jsGrammar.requiredFlags],
      includes: [],
    };
  }

  private generateWasmProgram(): ReconfuzzProgram {
    const template = this.pickTemplate(GLUE_TEMPLATES);
    if (!template) {
      throw new Error('No Wasm templates available');
    }
    return template.build(this.config.seed ?? 0);
  }

  private generateGcProgram(): ReconfuzzProgram {
    const template = this.pickTemplate(GC_TEMPLATES);
    if (!template) {
      throw new Error('No GC templates available');
    }
    return template.build(this.config.seed ?? 0);
  }

  private generateHybridProgram(): ReconfuzzProgram {
    // Start with a Wasm template and append JS grammar statements.
    const template = this.pickTemplate(GLUE_TEMPLATES);
    if (!template) {
      throw new Error('No Wasm templates available');
    }
    const program = template.build(this.config.seed ?? 0);

    const extra = this.jsGrammar.generateProgram();
    // Keep Wasm as the hybrid base, and occasionally append a GC stressor so
    // hybrid campaigns exercise both subsystems instead of only the two Wasm
    // wrappers.
    const gcTemplate = this.templateRng() < 0.35 ? this.pickTemplate(GC_TEMPLATES) : undefined;
    const gcProgram = gcTemplate?.build(this.config.seed ?? 0);
    const constituentPrograms = [
      program.javascript.program,
      gcProgram?.javascript.program,
      extra.program,
    ].filter((candidate): candidate is t.Program => candidate !== undefined);
    const seenDirectives = new Set<string>();
    const directives: t.Directive[] = [];
    for (const constituent of constituentPrograms) {
      for (const directive of constituent.directives) {
        if (seenDirectives.has(directive.value.value)) continue;
        seenDirectives.add(directive.value.value);
        directives.push(directive);
      }
    }
    const mergedProgram = t.program([
      ...program.javascript.program.body,
      ...(gcProgram?.javascript.program.body ?? []),
      ...extra.program.body,
    ]);
    mergedProgram.directives = directives;
    mergedProgram.interpreter =
      constituentPrograms.find((constituent) => constituent.interpreter)
        ?.interpreter ?? null;
    mergedProgram.sourceType = program.javascript.program.sourceType;
    const merged = t.file(mergedProgram);

    return {
      javascript: merged,
      wasm: this.mergeWasmModules(program.wasm, gcProgram?.wasm ?? []),
      flags: Array.from(
        new Set([
          ...program.flags,
          ...(gcProgram?.flags ?? []),
          ...this.jsGrammar.requiredFlags,
        ]),
      ),
      includes: Array.from(
        new Set([...program.includes, ...(gcProgram?.includes ?? [])]),
      ),
    };
  }
}

export { ReconfuzzProgram, GrammarConfig, printProgram };

function readOptionValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith('--')) {
    throw new CliArgumentError(`Missing value for ${args[index]}`);
  }
  return value;
}

function parseCliArgs(args: string[]): {
  outputPath: string | null;
  mode: GeneratorConfig['mode'];
  seed: number;
} {
  let outputPath: string | null = null;
  let mode: GeneratorConfig['mode'] = 'hybrid';
  let seed = 0;

  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === '--output') {
      outputPath = readOptionValue(args, i);
      i++;
    } else if (argument === '--mode') {
      const value = readOptionValue(args, i);
      if (!isGeneratorMode(value)) {
        throw new CliArgumentError(`Unknown mode: ${value}`);
      }
      mode = value;
      i++;
    } else if (argument === '--seed') {
      const value = readOptionValue(args, i);
      if (!/^[+-]?\d+$/.test(value)) {
        throw new CliArgumentError(`Invalid seed: ${value}`);
      }
      seed = Number(value);
      if (!Number.isSafeInteger(seed)) {
        throw new CliArgumentError(`Invalid seed: ${value}`);
      }
      i++;
    } else {
      throw new CliArgumentError(`Unknown argument: ${argument}`);
    }
  }

  return { outputPath, mode, seed };
}

function main(): void {
  const { outputPath, mode, seed } = parseCliArgs(process.argv.slice(2));

  const generator = new Generator({ mode, seed });
  const program = generator.generate();
  const source = printProgram(program);

  if (outputPath) {
    const dir = path.dirname(outputPath);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(outputPath, source, 'utf8');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to write testcase to ${outputPath}: ${reason}`);
    }
    console.log(`Wrote testcase to ${outputPath}`);
  } else {
    console.log(source);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof CliArgumentError) {
      console.error(USAGE);
    }
    process.exitCode = 1;
  }
}
