/**
 * Generator entry point.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as t from '@babel/types';
import { ReconfuzzProgram, resetIdCounter } from './ast';
import { GC_TEMPLATES } from './gc-templates';
import { GrammarConfig, JsGrammar } from './js-grammar';
import { GLUE_TEMPLATES } from './js-wasm-glue';
import { printProgram } from './printer';

export interface GeneratorConfig {
  seed?: number;
  mode: 'js-only' | 'wasm-only' | 'hybrid' | 'gc-only';
  js?: Partial<GrammarConfig>;
}

export class Generator {
  private config: GeneratorConfig;
  private jsGrammar: JsGrammar;

  constructor(config: GeneratorConfig) {
    this.config = config;
    this.jsGrammar = new JsGrammar(config.js ?? {}, config.seed ?? 0);
  }

  setSeed(seed: number): void {
    this.config.seed = seed;
    this.jsGrammar.setSeed(seed);
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
      default:
        return this.generateJsProgram();
    }
  }

  private generateJsProgram(): ReconfuzzProgram {
    const ast = this.jsGrammar.generateProgram();
    return {
      javascript: ast,
      wasm: [],
      flags: [],
      includes: [],
    };
  }

  private generateWasmProgram(): ReconfuzzProgram {
    const template = GLUE_TEMPLATES[Math.floor(Math.random() * GLUE_TEMPLATES.length)];
    if (!template) {
      throw new Error('No Wasm templates available');
    }
    return template.build();
  }

  private generateGcProgram(): ReconfuzzProgram {
    const template = GC_TEMPLATES[Math.floor(Math.random() * GC_TEMPLATES.length)];
    if (!template) {
      throw new Error('No GC templates available');
    }
    return template.build();
  }

  private generateHybridProgram(): ReconfuzzProgram {
    // Start with a Wasm template and append JS grammar statements.
    const template = GLUE_TEMPLATES[Math.floor(Math.random() * GLUE_TEMPLATES.length)];
    if (!template) {
      return this.generateJsProgram();
    }
    const program = template.build();

    const extra = this.jsGrammar.generateProgram();
    const merged = t.file(
      t.program([...program.javascript.program.body, ...extra.program.body]),
    );

    return {
      javascript: merged,
      wasm: program.wasm,
      flags: Array.from(new Set([...program.flags, ...extra.program.body.length ? [] : []])),
      includes: program.includes,
    };
  }
}

export { ReconfuzzProgram, GrammarConfig, printProgram };

function main(): void {
  const args = process.argv.slice(2);
  let outputPath: string | null = null;
  let mode: GeneratorConfig['mode'] = 'hybrid';
  let seed = 0;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && i + 1 < args.length) {
      outputPath = args[i + 1];
      i++;
    } else if (args[i] === '--mode' && i + 1 < args.length) {
      mode = args[i + 1] as GeneratorConfig['mode'];
      if (!['js-only', 'wasm-only', 'hybrid', 'gc-only'].includes(mode)) {
        console.error(`Unknown mode: ${mode}`);
        process.exit(1);
      }
      i++;
    } else if (args[i] === '--seed' && i + 1 < args.length) {
      seed = parseInt(args[i + 1], 10);
      i++;
    }
  }

  const generator = new Generator({ mode, seed });
  const program = generator.generate();
  const source = printProgram(program);

  if (outputPath) {
    const dir = path.dirname(outputPath);
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(outputPath, source, 'utf8');
    console.log(`Wrote testcase to ${outputPath}`);
  } else {
    console.log(source);
  }
}

if (require.main === module) {
  main();
}
