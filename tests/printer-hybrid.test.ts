import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { Generator, printProgram } from '../src/generator';
import type { ReconfuzzProgram } from '../src/generator';

function parsePrinted(source: string) {
  return parse(source, {
    sourceType: 'script',
    plugins: ['v8intrinsic'],
  });
}

function makeProgram(javascript: t.File): ReconfuzzProgram {
  return {
    javascript,
    wasm: [],
    flags: [],
    includes: [],
  };
}

describe('program printer metadata ordering', () => {
  test('keeps directives before injected includes', () => {
    const javascript = t.file(
      t.program(
        [t.expressionStatement(t.numericLiteral(1))],
        [t.directive(t.directiveLiteral('use strict'))],
        'script',
      ),
    );
    const program = makeProgram(javascript);
    program.includes.push('helpers/neutral.js');

    const source = printProgram(program);
    const parsed = parsePrinted(source);

    expect(parsed.program.directives[0]?.value.value).toBe('use strict');
    expect(parsed.program.body[0]).toMatchObject({
      type: 'ExpressionStatement',
      expression: {
        type: 'CallExpression',
        callee: {
          type: 'MemberExpression',
          object: {
            type: 'MemberExpression',
            object: { type: 'Identifier', name: 'd8' },
            property: { type: 'Identifier', name: 'file' },
          },
          property: { type: 'Identifier', name: 'execute' },
        },
      },
    });
    expect(source.indexOf('"use strict"')).toBeLessThan(
      source.indexOf('d8.file.execute'),
    );
  });

  test('prints a hashbang at byte zero before the flags header', () => {
    const javascript = t.file(
      t.program([t.expressionStatement(t.numericLiteral(1))]),
    );
    javascript.program.interpreter = t.interpreterDirective('reconfuzz');
    const program = makeProgram(javascript);
    program.flags.push('--neutral-flag');

    const source = printProgram(program);

    expect(source.startsWith('#!reconfuzz\n// Flags: --neutral-flag\n')).toBe(
      true,
    );
    expect(parsePrinted(source).program.interpreter?.value).toBe('reconfuzz');
  });
});

describe('hybrid program metadata', () => {
  test('preserves generated directives and interpreter and prints deterministically', () => {
    const generator = new Generator({ mode: 'hybrid', seed: 17 });
    const grammar = (
      generator as unknown as {
        jsGrammar: { generateProgram: () => t.File };
      }
    ).jsGrammar;
    grammar.generateProgram = () => {
      const extra = t.program(
        [
          t.variableDeclaration('const', [
            t.variableDeclarator(
              t.identifier('neutralValue'),
              t.numericLiteral(1),
            ),
          ]),
        ],
        [t.directive(t.directiveLiteral('use strict'))],
        'script',
      );
      extra.interpreter = t.interpreterDirective('hybrid-neutral');
      return t.file(extra);
    };

    const hybrid = generator.generate();
    const firstPrint = printProgram(hybrid);
    const secondPrint = printProgram(hybrid);
    const parsed = parsePrinted(firstPrint);

    expect(hybrid.javascript.program.directives).toHaveLength(1);
    expect(hybrid.javascript.program.directives[0].value.value).toBe(
      'use strict',
    );
    expect(hybrid.javascript.program.interpreter?.value).toBe('hybrid-neutral');
    expect(parsed.program.directives[0]?.value.value).toBe('use strict');
    expect(firstPrint.startsWith('#!hybrid-neutral')).toBe(true);
    expect(secondPrint).toBe(firstPrint);
  });
});
