/**
 * Emits a reconfuzz program as a runnable d8 testcase.
 */
import generate from '@babel/generator';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { ReconfuzzProgram } from './ast';

export interface PrintOptions {
  includeFlagsHeader?: boolean;
  includeHelpers?: boolean;
}

export function printProgram(
  program: ReconfuzzProgram,
  options: PrintOptions = {},
): string {
  if (program === null || typeof program !== 'object') {
    throw new TypeError(
      'printProgram: program must be a non-null ReconfuzzProgram',
    );
  }

  const { includeFlagsHeader = true, includeHelpers = true } = options;
  const lines: string[] = [];

  const ast = t.cloneNode(program.javascript, true);
  const hashbang = ast.program.interpreter?.value;
  ast.program.interpreter = null;

  if (hashbang !== undefined) {
    lines.push(`#!${hashbang}`);
  }

  const validFlags = program.flags.filter(
    (flag) => flag.length > 0 && !/\s/.test(flag),
  );
  if (validFlags.length !== program.flags.length) {
    console.warn('Dropping empty or whitespace-containing flags from header');
  }

  if (includeFlagsHeader && validFlags.length > 0) {
    lines.push(`// Flags: ${validFlags.join(' ')}`);
  }

  if (includeHelpers && program.includes.length > 0) {
    const includes = program.includes.map((inc) =>
      t.expressionStatement(
        t.callExpression(
          t.memberExpression(
            t.memberExpression(t.identifier('d8'), t.identifier('file')),
            t.identifier('execute'),
          ),
          [t.stringLiteral(inc)],
        ),
      ),
    );
    let directiveEnd = 0;
    while (directiveEnd < ast.program.body.length) {
      const statement = ast.program.body[directiveEnd];
      const directiveStatement = statement as t.Statement & {
        directive?: string;
      };
      if (
        !t.isExpressionStatement(statement) ||
        directiveStatement.directive === undefined
      ) {
        break;
      }
      directiveEnd++;
    }
    ast.program.body.splice(directiveEnd, 0, ...includes);
  }

  const wasmByName = new Map<string, Uint8Array>();
  for (const module of program.wasm) {
    if (wasmByName.has(module.name)) {
      console.warn(`Duplicate Wasm module name: ${module.name}`);
    }
    // Preserve the existing Map constructor behavior: the last duplicate wins.
    wasmByName.set(module.name, module.bytes);
  }
  traverse(ast, {
    CallExpression(path) {
      const { callee, arguments: args } = path.node;
      if (
        callee.type !== 'Identifier' ||
        callee.name !== '__reconfuzz_wasm_bytes' ||
        args.length !== 1 ||
        args[0].type !== 'StringLiteral'
      ) {
        return;
      }
      const bytes = wasmByName.get(args[0].value);
      if (bytes === undefined) {
        path.replaceWith(t.arrayExpression([]));
        return;
      }
      path.replaceWith(
        t.arrayExpression(Array.from(bytes, (byte) => t.numericLiteral(byte))),
      );
    },
  });

  const { code } = generate(ast, {
    compact: false,
    comments: true,
  });

  lines.push(code);
  return lines.join('\n');
}
