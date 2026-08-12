import generate from '@babel/generator';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { DEFAULT_CONFIG, JsGrammar } from '../src/generator/js-grammar';

describe('class generation', () => {
  test('covers class members and valid heritage across many seeds', () => {
    let sawMethod = false;
    let sawField = false;
    let sawGetter = false;
    let sawHeritage = false;

    // Wide range: heritage (extends a visible class) is the rarest class feature,
    // so the window must be large enough to hit it regardless of RNG shifts from
    // upstream production changes (per the test-suite review's fragility note).
    for (let seed = 500; seed < 2500; seed++) {
      const file = new JsGrammar(DEFAULT_CONFIG, seed).generateProgram();
      const source = generate(file).code;
      const parsed = parse(source, {
        sourceType: 'script',
        plugins: ['v8intrinsic'],
      });

      traverse(parsed, {
        Class(path) {
          const members = path.node.body.body;
          sawMethod ||= members.some(
            (member) => t.isClassMethod(member) && member.kind === 'method',
          );
          sawField ||= members.some((member) => t.isClassProperty(member));
          sawGetter ||= members.some(
            (member) => t.isClassMethod(member) && member.kind === 'get',
          );

          if (path.node.superClass !== null) {
            sawHeritage = true;
            const constructor = members.find(
              (member): member is t.ClassMethod =>
                t.isClassMethod(member) && member.kind === 'constructor',
            );
            expect(constructor).toBeDefined();
            const firstStatement = constructor?.body.body[0];
            expect(
              t.isExpressionStatement(firstStatement)
              && t.isCallExpression(firstStatement.expression)
              && t.isSuper(firstStatement.expression.callee),
            ).toBe(true);
          }
        },
      });
    }

    expect(sawMethod).toBe(true);
    expect(sawField).toBe(true);
    expect(sawGetter).toBe(true);
    expect(sawHeritage).toBe(true);
  });

  test('is deterministic for the same seed', () => {
    const generateInIsolation = (seed: number): string => {
      let source = '';
      jest.isolateModules(() => {
        const grammarModule = require('../src/generator/js-grammar') as
          typeof import('../src/generator/js-grammar');
        const isolatedGenerate = require('@babel/generator').default as typeof generate;
        const file = new grammarModule.JsGrammar(grammarModule.DEFAULT_CONFIG, seed).generateProgram();
        source = isolatedGenerate(file).code;
      });
      return source;
    };

    expect(generateInIsolation(173)).toBe(generateInIsolation(173));
  });
});
