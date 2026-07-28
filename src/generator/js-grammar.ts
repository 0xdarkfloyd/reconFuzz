/**
 * Type-directed JavaScript AST grammar for V8 stress testing.
 *
 * The generator builds Babel ASTs that mirror the compact, dense trigger
 * patterns seen in the lokihardt_jshitter corpus and the JS/Wasm glue
 * patterns seen in big_sleep.
 */
import * as t from '@babel/types';
import { Scope, freshId, TypeHint, VariableSlot } from './ast';

export interface GrammarConfig {
  maxStatements: number;
  maxLoopIterations: number;
  maxExpressionDepth: number;
  mutationProbability: number;
  enableAsync: boolean;
  enableGenerators: boolean;
  enableClasses: boolean;
  enableWasm: boolean;
}

export const DEFAULT_CONFIG: GrammarConfig = {
  maxStatements: 12,
  maxLoopIterations: 100,
  maxExpressionDepth: 6,
  mutationProbability: 0.3,
  enableAsync: true,
  enableGenerators: true,
  enableClasses: true,
  enableWasm: true,
};

const EDGE_NUMBERS = [
  0,
  -0,
  1,
  -1,
  NaN,
  Infinity,
  -Infinity,
  0x7fffffff,
  0x80000000,
  -0x80000000,
  0x100000000,
  2 ** 53,
  -(2 ** 53),
];

const BINARY_OPERATORS: t.BinaryExpression['operator'][] = [
  '+',
  '-',
  '*',
  '/',
  '%',
  '==',
  '===',
  '!=',
  '!==',
  '<',
  '>',
  '<=',
  '>=',
  '|',
  '&',
  '^',
  '<<',
  '>>',
  '>>>',
];

export class JsGrammar {
  private config: GrammarConfig;
  private rng: () => number;

  constructor(config: Partial<GrammarConfig> = {}, seed = 0) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.rng = mulberry32(seed);
  }

  setSeed(seed: number): void {
    this.rng = mulberry32(seed);
  }

  generateProgram(): t.File {
    const scope = new Scope();
    const body: t.Statement[] = [];
    const statementCount = this.randint(1, this.config.maxStatements);

    for (let i = 0; i < statementCount; i++) {
      body.push(this.generateStatement(scope, this.config.maxExpressionDepth));
    }

    return t.file(t.program(body));
  }

  generateStatement(scope: Scope, depth: number): t.Statement {
    if (depth <= 0) {
      return this.generateExpressionStatement(scope, 1);
    }

    const choices: Array<() => t.Statement> = [
      (): t.Statement => this.generateVariableDeclaration(scope, depth - 1),
      (): t.Statement => this.generateExpressionStatement(scope, depth - 1),
      (): t.Statement => this.generateForLoop(scope, depth - 1),
      (): t.Statement => this.generateIfStatement(scope, depth - 1),
      (): t.Statement => this.generateTryCatch(scope, depth - 1),
      (): t.Statement => this.generateFunctionDeclaration(scope, depth - 1),
      (): t.Statement => this.generateGcStatement(scope),
    ];

    if (this.config.enableAsync && this.rand() < 0.15) {
      choices.push((): t.Statement => this.generateAsyncInvocation(scope, depth - 1));
    }
    if (this.config.enableClasses && this.rand() < 0.15) {
      choices.push((): t.Statement => this.generateClassDeclaration(scope, depth - 1));
    }

    return this.pick(choices)();
  }

  generateVariableDeclaration(scope: Scope, depth: number): t.VariableDeclaration {
    const kind = this.pick<VariableSlot['kind']>(['var', 'let', 'const']);
    const name = freshId();
    const typeHint = this.pick<TypeHint>([
      'any',
      'number',
      'string',
      'array',
      'object',
      'function',
      'typedarray',
      'weakmap',
      'weakset',
      'finalizationregistry',
    ]);
    scope.declare(name, kind, typeHint);

    const init = this.generateExpression(scope, typeHint, depth - 1);
    return t.variableDeclaration(kind, [
      t.variableDeclarator(t.identifier(name), init),
    ]);
  }

  generateExpressionStatement(scope: Scope, depth: number): t.ExpressionStatement {
    return t.expressionStatement(this.generateExpression(scope, 'any', depth));
  }

  generateExpression(scope: Scope, hint: TypeHint, depth: number): t.Expression {
    if (depth <= 0) {
      return this.generateTerminalExpression(scope, hint);
    }

    switch (hint) {
      case 'number':
        return this.generateNumberExpression(scope);
      case 'string':
        return this.generateStringExpression(scope);
      case 'array':
        return this.generateArrayExpression(scope, depth - 1);
      case 'object':
        return this.generateObjectExpression(scope, depth - 1);
      case 'function':
        return this.generateFunctionExpression(
          scope,
          false,
          this.config.enableGenerators && this.rand() < 0.3,
          depth - 1,
        );
      case 'typedarray':
        return this.generateTypedArrayExpression(scope, depth - 1);
      case 'promise':
        return this.generatePromiseExpression(scope, depth - 1);      case 'weakmap':
        return this.generateWeakMapExpression(scope, depth);
      case 'weakset':
        return this.generateWeakSetExpression(scope, depth);
      case 'finalizationregistry':
        return this.generateFinalizationRegistryExpression(scope, depth);      default:
        return this.generateAnyExpression(scope, depth - 1);
    }
  }

  generateTerminalExpression(scope: Scope, hint: TypeHint): t.Expression {
    switch (hint) {
      case 'number':
        return this.generateNumberExpression(scope);
      case 'string':
        return this.generateStringExpression(scope);
      case 'array':
        return t.arrayExpression([]);
      case 'object':
        return t.objectExpression([]);
      case 'function':
        return t.arrowFunctionExpression([], t.blockStatement([]));
      case 'typedarray':
        return t.newExpression(t.identifier('Uint8Array'), [t.numericLiteral(0)]);
      case 'weakmap':
        return t.newExpression(t.identifier('WeakMap'), []);
      case 'weakset':
        return t.newExpression(t.identifier('WeakSet'), []);
      case 'finalizationregistry':
        return t.newExpression(t.identifier('FinalizationRegistry'), [
          t.arrowFunctionExpression([t.identifier('value')], t.blockStatement([])),
        ]);
      case 'promise':
        return t.newExpression(
          t.identifier('Promise'),
          [t.arrowFunctionExpression([t.identifier('resolve'), t.identifier('reject')], t.blockStatement([]))],
        );
      default:
        return this.generateNumberExpression(scope);
    }
  }

  generateAnyExpression(scope: Scope, depth: number, inGenerator = false): t.Expression {
    if (depth <= 0) {
      return this.generateTerminalExpression(scope, 'any');
    }

    const choices: Array<() => t.Expression> = [
      (): t.Expression => this.generateNumberExpression(scope),
      (): t.Expression => this.generateStringExpression(scope),
      (): t.Expression => this.generateArrayExpression(scope, depth - 1),
      (): t.Expression => this.generateObjectExpression(scope, depth - 1),
      (): t.Expression => this.generateIdentifier(scope),
      (): t.Expression => this.generateBinaryExpression(scope, depth - 1),
      (): t.Expression => this.generateCallExpression(scope, depth - 1),
    ];

    if (this.config.enableAsync) {
      choices.push((): t.Expression => this.generatePromiseExpression(scope, depth - 1));
    }
    if (this.config.enableGenerators && inGenerator) {
      choices.push((): t.Expression => this.generateYieldExpression(scope, depth - 1));
    }

    return this.pick(choices)();
  }

  generateGeneratorExpression(scope: Scope, depth: number): t.FunctionExpression {
    const inner = scope.child();
    return t.functionExpression(
      null,
      [],
      t.blockStatement([
        this.generateStatement(inner, depth),
        t.returnStatement(this.generateAnyExpression(inner, depth, true)),
      ]),
      true,
      false,
    );
  }

  generateNumberExpression(_scope: Scope): t.Expression {
    if (this.rand() < 0.3) {
      return t.numericLiteral(this.pick(EDGE_NUMBERS));
    }
    return t.numericLiteral(this.randint(-100, 100));
  }

  generateStringExpression(_scope: Scope): t.Expression {
    const strings = ['', 'a', 'abc', '0', '[]', '{}', '\\k<1>', '\u2028'];
    return t.stringLiteral(this.pick(strings));
  }

  generateArrayExpression(scope: Scope, depth: number): t.ArrayExpression {
    const elements: Array<t.Expression | null> = [];
    const len = this.randint(0, 5);
    for (let i = 0; i < len; i++) {
      elements.push(this.rand() < 0.2 ? null : this.generateAnyExpression(scope, depth));
    }
    return t.arrayExpression(elements);
  }

  generateObjectExpression(scope: Scope, depth: number): t.ObjectExpression {
    const properties: Array<t.ObjectProperty | t.ObjectMethod> = [];
    const len = this.randint(0, 4);
    for (let i = 0; i < len; i++) {
      properties.push(
        t.objectProperty(
          this.rand() < 0.3 ? t.stringLiteral(freshId('key')) : t.identifier(freshId('key')),
          this.generateAnyExpression(scope, depth),
        ),
      );
    }

    // Sometimes add a getter to stress object shapes.
    if (this.rand() < 0.25 && depth > 0) {
      properties.push(
        t.objectMethod(
          'get',
          t.identifier('value'),
          [],
          t.blockStatement([this.generateExpressionStatement(scope, depth - 1)]),
        ),
      );
    }

    return t.objectExpression(properties);
  }

  generateIdentifier(scope: Scope): t.Identifier {
    const vars = scope.all();
    if (vars.length > 0 && this.rand() < 0.7) {
      return t.identifier(this.pick(vars).name);
    }
    return t.identifier(freshId());
  }

  generateBinaryExpression(scope: Scope, depth: number): t.BinaryExpression {
    const op = this.pick(BINARY_OPERATORS);
    return t.binaryExpression(
      op,
      this.generateExpression(scope, 'number', depth),
      this.generateExpression(scope, 'number', depth),
    );
  }

  generateCallExpression(scope: Scope, depth: number): t.CallExpression {
    const callee = this.generateIdentifier(scope);
    const args: t.Expression[] = [];
    const argc = this.randint(0, 3);
    for (let i = 0; i < argc; i++) {
      args.push(this.generateAnyExpression(scope, depth));
    }
    return t.callExpression(callee, args);
  }

  generateForLoop(scope: Scope, depth: number): t.ForStatement {
    const inner = scope.child();
    const index = freshId();
    inner.declare(index, 'let', 'number');
    const limit = this.randint(1, this.config.maxLoopIterations);

    return t.forStatement(
      t.variableDeclaration('let', [
        t.variableDeclarator(t.identifier(index), t.numericLiteral(this.randint(-10, 10))),
      ]),
      t.binaryExpression(
        this.pick(['<', '<=', '>', '>=']),
        t.identifier(index),
        t.numericLiteral(limit),
      ),
      t.updateExpression(this.pick(['++', '--']), t.identifier(index), false),
      t.blockStatement([
        this.generateVariableDeclaration(inner, depth),
        this.generateExpressionStatement(inner, depth),
      ]),
    );
  }

  generateIfStatement(scope: Scope, depth: number): t.IfStatement {
    return t.ifStatement(
      this.generateAnyExpression(scope, depth),
      t.blockStatement([this.generateStatement(scope.child(), depth - 1)]),
      this.rand() < 0.3 ? t.blockStatement([this.generateStatement(scope.child(), depth - 1)]) : null,
    );
  }

  generateTryCatch(scope: Scope, depth: number): t.TryStatement {
    return t.tryStatement(
      t.blockStatement([this.generateStatement(scope.child(), depth - 1)]),
      t.catchClause(t.identifier('e'), t.blockStatement([this.generateStatement(scope.child(), depth - 1)])),
    );
  }

  generateFunctionDeclaration(scope: Scope, depth: number): t.FunctionDeclaration {
    const name = freshId('fn');
    const inner = scope.child();
    inner.declare(name, 'var', 'function');

    return t.functionDeclaration(
      t.identifier(name),
      [],
      t.blockStatement([this.generateStatement(inner, depth), this.generateExpressionStatement(inner, depth)]),
    );
  }

  generateAsyncInvocation(scope: Scope, depth: number): t.ExpressionStatement {
    const fn = this.generateFunctionExpression(scope, true, false, depth);
    return t.expressionStatement(t.callExpression(fn, []));
  }

  generateFunctionExpression(
    scope: Scope,
    async = false,
    generator = false,
    depth: number,
  ): t.FunctionExpression {
    if (generator) {
      return this.generateGeneratorExpression(scope, depth);
    }

    const inner = scope.child();
    return t.functionExpression(
      null,
      [],
      t.blockStatement([
        this.generateStatement(inner, depth),
        t.returnStatement(this.generateAnyExpression(inner, depth, false)),
      ]),
      generator,
      async,
    );
  }

  generateClassDeclaration(scope: Scope, depth: number): t.ClassDeclaration {
    const name = freshId('Cls');
    scope.declare(name, 'let', 'function');

    const body = t.classBody([
      t.classMethod(
        'constructor',
        t.identifier('constructor'),
        [],
        t.blockStatement(depth > 0 ? [this.generateStatement(scope.child(), depth - 1)] : []),
      ),
    ]);

    return t.classDeclaration(t.identifier(name), null, body);
  }

  generateTypedArrayExpression(scope: Scope, depth: number): t.NewExpression {
    const constructors = [
      'Int8Array',
      'Uint8Array',
      'Int32Array',
      'Float32Array',
      'BigInt64Array',
    ];
    return t.newExpression(
      t.identifier(this.pick(constructors)),
      [this.generateExpression(scope, 'number', depth)],
    );
  }

  generatePromiseExpression(scope: Scope, depth: number): t.NewExpression {
    const executor = t.arrowFunctionExpression(
      [t.identifier('resolve'), t.identifier('reject')],
      t.blockStatement([this.generateStatement(scope.child(), depth - 1)]),
    );
    return t.newExpression(t.identifier('Promise'), [executor]);
  }

  generateWeakMapExpression(scope: Scope, depth: number): t.NewExpression {
    return t.newExpression(t.identifier('WeakMap'), [
      t.arrayExpression([
        t.arrayExpression([
          this.generateExpression(scope, 'object', depth),
          this.generateAnyExpression(scope, depth),
        ]),
      ]),
    ]);
  }

  generateWeakSetExpression(scope: Scope, depth: number): t.NewExpression {
    return t.newExpression(t.identifier('WeakSet'), [
      t.arrayExpression([this.generateExpression(scope, 'object', depth)]),
    ]);
  }

  generateFinalizationRegistryExpression(scope: Scope, depth: number): t.NewExpression {
    return t.newExpression(t.identifier('FinalizationRegistry'), [
      t.arrowFunctionExpression(
        [t.identifier('heldValue')],
        t.blockStatement([this.generateStatement(scope.child(), depth - 1)]),
      ),
    ]);
  }

  generateYieldExpression(scope: Scope, depth: number): t.YieldExpression {
    return t.yieldExpression(this.generateAnyExpression(scope, depth), this.rand() < 0.3);
  }

  generateGcStatement(_scope: Scope): t.ExpressionStatement {
    return t.expressionStatement(t.callExpression(t.identifier('gc'), []));
  }

  private rand(): number {
    return this.rng();
  }

  private randint(min: number, max: number): number {
    return Math.floor(this.rng() * (max - min + 1)) + min;
  }

  private pick<T>(arr: T[]): T {
    return arr[this.randint(0, arr.length - 1)];
  }
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
