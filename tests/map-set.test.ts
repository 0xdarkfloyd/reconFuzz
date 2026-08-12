import generate from '@babel/generator';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { resetIdCounter } from '../src/generator/ast';
import { JsGrammar } from '../src/generator/js-grammar';

type CollectionKind = 'map' | 'set' | 'weakref';

function generateSource(seed: number): string {
  resetIdCounter();
  return generate(new JsGrammar({}, seed).generateProgram()).code;
}

describe('Map, Set, and WeakRef generation', () => {
  it('generates valid constructors and method calls deterministically', () => {
    const seen = {
      mapConstructor: false,
      setConstructor: false,
      weakRefConstructor: false,
      mapMethod: false,
      setMethod: false,
      weakRefMethod: false,
    };

    for (let seed = 0; seed < 2000; seed++) {
      const source = generateSource(seed);
      const ast = parse(source, {
        sourceType: 'script',
        plugins: ['v8intrinsic'],
      });
      const collections = new Map<string, CollectionKind>();

      traverse(ast, {
        VariableDeclarator(path) {
          const { id, init } = path.node;
          if (!t.isIdentifier(id) || !t.isNewExpression(init) || !t.isIdentifier(init.callee)) {
            return;
          }
          if (init.callee.name === 'Map') collections.set(id.name, 'map');
          if (init.callee.name === 'Set') collections.set(id.name, 'set');
          if (init.callee.name === 'WeakRef') collections.set(id.name, 'weakref');
        },
      });

      traverse(ast, {
        NewExpression(path) {
          const { callee, arguments: args } = path.node;
          if (!t.isIdentifier(callee)) return;

          if (callee.name === 'Map') {
            seen.mapConstructor = true;
            expect(args).toHaveLength(1);
            expect(t.isArrayExpression(args[0])).toBe(true);
            if (t.isArrayExpression(args[0])) {
              for (const entry of args[0].elements) {
                expect(t.isArrayExpression(entry)).toBe(true);
                if (t.isArrayExpression(entry)) expect(entry.elements).toHaveLength(2);
              }
            }
          }

          if (callee.name === 'Set') {
            seen.setConstructor = true;
            expect(args).toHaveLength(1);
            expect(t.isArrayExpression(args[0])).toBe(true);
          }

          if (callee.name === 'WeakRef') {
            seen.weakRefConstructor = true;
            expect(args).toHaveLength(1);
            expect(t.isObjectExpression(args[0]) || t.isNewExpression(args[0])).toBe(true);
          }
        },
        CallExpression(path) {
          const callee = path.node.callee;
          if (!t.isMemberExpression(callee) || callee.computed) return;
          if (!t.isIdentifier(callee.object) || !t.isIdentifier(callee.property)) return;

          const kind = collections.get(callee.object.name);
          const method = callee.property.name;
          if (kind === 'map' && ['get', 'set', 'has', 'delete'].includes(method)) {
            seen.mapMethod = true;
          }
          if (kind === 'set' && ['add', 'has', 'delete'].includes(method)) {
            seen.setMethod = true;
          }
          if (kind === 'weakref' && method === 'deref') {
            seen.weakRefMethod = true;
            expect(path.node.arguments).toHaveLength(0);
          }
        },
      });
    }

    expect(seen.mapConstructor).toBe(true);
    expect(seen.setConstructor).toBe(true);
    expect(seen.weakRefConstructor).toBe(true);
    expect(seen.mapMethod).toBe(true);
    expect(seen.setMethod).toBe(true);
    expect(seen.weakRefMethod).toBe(true);

    expect(generateSource(2026)).toBe(generateSource(2026));
  });
});
