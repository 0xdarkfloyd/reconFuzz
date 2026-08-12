import generate from '@babel/generator';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { DEFAULT_CONFIG, JsGrammar } from '../src/generator/js-grammar';

describe('destructuring and call argument spread generation', () => {
  test('emits parseable destructuring patterns and array spreads', () => {
    let sawArrayPattern = false;
    let sawObjectPattern = false;
    let sawArrayRest = false;
    let sawCallSpread = false;
    let sawLaterReference = false;

    for (let seed = 0; seed < 2000; seed++) {
      const source = generate(new JsGrammar(DEFAULT_CONFIG, seed).generateProgram()).code;
      const ast = parse(source, {
        sourceType: 'script',
        plugins: ['v8intrinsic'],
      });
      const bindings: Array<{ name: string; declarationEnd: number }> = [];
      const references: Array<{ name: string; start: number }> = [];

      traverse(ast, {
        VariableDeclaration(path) {
          const declarator = path.node.declarations[0];
          if (!declarator) return;

          if (t.isArrayPattern(declarator.id)) {
            sawArrayPattern = true;
            sawArrayRest ||= declarator.id.elements.some((element) => t.isRestElement(element));
            expect(t.isArrayExpression(declarator.init)).toBe(true);
          } else if (t.isObjectPattern(declarator.id)) {
            sawObjectPattern = true;
            expect(t.isObjectExpression(declarator.init)).toBe(true);
          } else {
            return;
          }

          const declarationEnd = path.node.end ?? -1;
          for (const name of Object.keys(t.getBindingIdentifiers(declarator.id))) {
            bindings.push({ name, declarationEnd });
          }
        },
        CallExpression(path) {
          sawCallSpread ||= path.node.arguments.some((argument) => t.isSpreadElement(argument));
        },
        ReferencedIdentifier(path) {
          references.push({ name: path.node.name, start: path.node.start ?? -1 });
        },
      });

      sawLaterReference ||= bindings.some((binding) =>
        references.some((reference) =>
          reference.name === binding.name && reference.start > binding.declarationEnd,
        ),
      );
    }

    expect(sawArrayPattern).toBe(true);
    expect(sawObjectPattern).toBe(true);
    expect(sawArrayRest).toBe(true);
    expect(sawCallSpread).toBe(true);
    expect(sawLaterReference).toBe(true);
  });

  test('is deterministic for the same seed and config', () => {
    const generateInIsolatedModule = (seed: number): string => {
      let source = '';
      jest.isolateModules(() => {
        const grammarModule = require('../src/generator/js-grammar') as typeof import('../src/generator/js-grammar');
        const grammar = new grammarModule.JsGrammar(grammarModule.DEFAULT_CONFIG, seed);
        source = generate(grammar.generateProgram()).code;
      });
      return source;
    };

    expect(generateInIsolatedModule(1729)).toBe(generateInIsolatedModule(1729));
  });
});
