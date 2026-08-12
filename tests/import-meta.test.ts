import generate from '@babel/generator';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import { DEFAULT_CONFIG, JsGrammar } from '../src/generator/js-grammar';

describe('import.meta / module mode', () => {
  test('enableModule produces module-mode programs with import.meta', () => {
    let sawImportMeta = false;
    for (let seed = 0; seed < 500; seed++) {
      const file = new JsGrammar({ ...DEFAULT_CONFIG, enableModule: true }, seed).generateProgram();
      const source = generate(file).code;
      expect(file.program.sourceType).toBe('module');
      // Module-mode programs must parse as module.
      const parsed = parse(source, { sourceType: 'module', plugins: ['v8intrinsic'] });
      traverse(parsed, {
        MetaProperty(path) {
          if (
            path.node.meta.name === 'import'
            && path.node.property.name === 'meta'
          ) {
            sawImportMeta = true;
          }
        },
      });
    }
    expect(sawImportMeta).toBe(true);
  });

  test('default config stays script mode (no import.meta)', () => {
    const file = new JsGrammar(DEFAULT_CONFIG, 0).generateProgram();
    expect(file.program.sourceType).toBe('script');
    expect(generate(file).code).not.toMatch(/import\.meta/);
  });
});
