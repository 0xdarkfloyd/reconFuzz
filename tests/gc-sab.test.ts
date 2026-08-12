import generate from '@babel/generator';
import { GC_TEMPLATES } from '../src/generator/gc-templates';

const sabTemplate = GC_TEMPLATES.find((template) => template.name === 'sharedarraybuffer-gc');

function buildSource(seed: number): string {
  if (!sabTemplate) {
    throw new Error('SharedArrayBuffer GC template is not registered');
  }

  return generate(sabTemplate.build(seed).javascript).code;
}

describe('SharedArrayBuffer GC template', () => {
  test.each([0, 1, 0x5bd1e995])('pairs wait and notify for seed %i', (seed) => {
    const source = buildSource(seed);
    const wait = source.match(
      /Atomics\.waitAsync\(\s*([A-Za-z_$][\w$]*)\s*,\s*0\s*,\s*0\s*,\s*(\d+)\s*\)/,
    );
    const notify = source.match(
      /Atomics\.notify\(\s*([A-Za-z_$][\w$]*)\s*,\s*0\s*,\s*1\s*\)/,
    );

    expect(wait).not.toBeNull();
    expect(notify).not.toBeNull();
    expect(wait?.[1]).toBe(notify?.[1]);
    expect(source.match(/new SharedArrayBuffer\(/g)).toHaveLength(1);
    expect(source).toMatch(/const i32 = new Int32Array\(sab\)/);

    const timeout = Number(wait?.[2]);
    expect(Number.isFinite(timeout)).toBe(true);
    expect(timeout).toBeGreaterThan(0);
    expect(source).toMatch(/__waitResult\.value\.then\(/);
  });

  test('is deterministic for a fixed seed', () => {
    expect(buildSource(12345)).toBe(buildSource(12345));
  });
});
