/**
 * Emits a reconfuzz program as a runnable d8 testcase.
 */
import generate from '@babel/generator';
import { ReconfuzzProgram } from './ast';

export interface PrintOptions {
  includeFlagsHeader?: boolean;
  includeHelpers?: boolean;
}

export function printProgram(
  program: ReconfuzzProgram,
  options: PrintOptions = {},
): string {
  const { includeFlagsHeader = true, includeHelpers = true } = options;
  const lines: string[] = [];

  if (includeFlagsHeader && program.flags.length > 0) {
    lines.push(`// Flags: ${program.flags.join(' ')}`);
  }

  if (includeHelpers && program.includes.length > 0) {
    for (const inc of program.includes) {
      lines.push(`d8.file.execute('${inc}');`);
    }
  }

  const { code } = generate(program.javascript, {
    compact: false,
    comments: true,
  });

  lines.push(code);
  return lines.join('\n');
}
