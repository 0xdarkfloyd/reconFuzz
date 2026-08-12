import {
  ensureIdCounterAbove,
  freshId,
  getIdCounter,
  resetIdCounter,
  Scope,
} from '../src/generator/ast';

describe('AST scope and identifier helpers', () => {
  beforeEach(() => {
    resetIdCounter();
  });

  afterEach(() => {
    resetIdCounter();
  });

  it('ignores invalid values passed to ensureIdCounterAbove', () => {
    freshId();
    const initial = getIdCounter();

    for (const value of [NaN, Infinity, -Infinity, 1.5, -1]) {
      ensureIdCounterAbove(value);
      expect(getIdCounter()).toBe(initial);
    }

    ensureIdCounterAbove(7);
    expect(getIdCounter()).toBe(8);
  });

  it('reports redeclarations on request and preserves identical slots', () => {
    const scope = new Scope();
    const first = scope.declare('value', 'let', 'number');

    expect(scope.has('value')).toBe(true);
    expect(scope.declare('value', 'let', 'number')).toBe(first);
    expect(() =>
      scope.declare('value', 'let', 'number', { throwOnRedeclare: true }),
    ).toThrow('Variable already declared in this scope: value');

    const replacement = scope.declare('value', 'const', 'string');
    expect(replacement).not.toBe(first);
    expect(scope.lookup('value')).toBe(replacement);
  });

  it('walks visible scopes without recursing through parent cycles', () => {
    const parent = new Scope();
    const child = parent.child();
    parent.declare('parentValue', 'var', 'number');
    child.declare('childValue', 'let', 'string');

    (parent as unknown as { parent: Scope | null }).parent = child;

    expect(child.allVisible()).toEqual([
      { name: 'childValue', kind: 'let', typeHint: 'string' },
      { name: 'parentValue', kind: 'var', typeHint: 'number' },
    ]);
  });

  it('walks deeply nested scopes without overflowing the call stack', () => {
    const root = new Scope();
    root.declare('rootValue', 'var', 'number');
    let current = root;
    for (let index = 0; index < 10000; index += 1) {
      current = current.child();
    }

    expect(current.allVisible()).toEqual([
      { name: 'rootValue', kind: 'var', typeHint: 'number' },
    ]);
  });

  it('allows tests to observe the counter round-trip', () => {
    ensureIdCounterAbove(10);
    expect(getIdCounter()).toBe(11);
    expect(freshId('tmp')).toBe('tmp_11');
    expect(getIdCounter()).toBe(12);

    resetIdCounter();
    expect(getIdCounter()).toBe(0);
    expect(freshId('tmp')).toBe('tmp_0');
  });
});
