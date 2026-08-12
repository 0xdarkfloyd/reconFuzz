/**
 * Type-directed JavaScript AST grammar for V8 stress testing.
 *
 * The generator builds Babel ASTs that mirror the compact, dense trigger
 * patterns seen in the lokihardt_jshitter corpus and the JS/Wasm glue
 * patterns seen in big_sleep.
 */
import * as t from '@babel/types';
import { Scope, freshId, TypeHint, VariableSlot } from './ast';
import { buildTierUpHarness } from './tierup';

export type ProductionKey =
  | 'number' | 'bigint' | 'string' | 'boolean' | 'array' | 'object'
  | 'identifier' | 'binary' | 'conditional' | 'logical' | 'unary'
  | 'sequence' | 'template' | 'call' | 'memberRead' | 'optionalChaining' | 'regExp'
  | 'symbol' | 'methodCall' | 'promise' | 'yield' | 'generatorInvocation'
  | 'taggedTemplate' | 'reflectCall' | 'dynamicImport' | 'builtinCall'
  | 'importMeta';

export interface GrammarConfig {
  maxStatements: number;
  maxLoopIterations: number;
  maxExpressionDepth: number;
  mutationProbability: number;
  enableAsync: boolean;
  enableGenerators: boolean;
  enableClasses: boolean;
  enableWasm: boolean;
  enableTierUp: boolean;
  tierUpProbability: number;
  allowUndeclaredIdentifiers?: boolean;
  productionWeights?: Partial<Record<ProductionKey, number>>;
  enableModule?: boolean;
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
  enableTierUp: true,
  tierUpProbability: 0.6,
  allowUndeclaredIdentifiers: false,
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
  2 ** 53 - 1,
  -(2 ** 53 - 1),
  2 ** 32 - 1,
  0.1,
  -0.1,
  1.7976931348623157e+308,
  5e-324,
  2.220446049250313e-16,
];

const ARITHMETIC_OPERATORS: t.BinaryExpression['operator'][] = [
  '+',
  '-',
  '*',
  '/',
  '%',
  '**',
  '|',
  '&',
  '^',
  '<<',
  '>>',
  '>>>',
];

const COMPARISON_OPERATORS: t.BinaryExpression['operator'][] = [
  '==',
  '===',
  '!=',
  '!==',
  '<',
  '>',
  '<=',
  '>=',
];

const LOGICAL_OPERATORS: t.LogicalExpression['operator'][] = ['&&', '||', '??'];

const LOGICAL_ASSIGNMENT_OPERATORS: t.AssignmentExpression['operator'][] = [
  '&&=',
  '||=',
  '??=',
];

function edgeNumberExpression(value: number): t.Expression {
  let inner: t.Expression;
  if (Object.is(value, -0)) inner = t.unaryExpression('-', t.numericLiteral(0));
  else if (Number.isNaN(value)) inner = t.binaryExpression('/', t.numericLiteral(0), t.numericLiteral(0));
  else if (value === Infinity) inner = t.binaryExpression('/', t.numericLiteral(1), t.numericLiteral(0));
  else if (value === -Infinity) inner = t.binaryExpression('/', t.numericLiteral(-1), t.numericLiteral(0));
  else {
    const node = t.numericLiteral(value);
    // Numeric separators (e.g. 2_147_483_647) for large positive integers —
    // @babel/generator prints extra.raw when present.
    if (Number.isInteger(value) && value >= 1000) {
      node.extra = {
        raw: Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '_'),
        rawValue: value,
      };
    }
    inner = node;
  }

  const signLeading = value < 0 || Object.is(value, -0) || value === -Infinity;
  // sign-safe: wrap so a leading '-' can't merge with an adjacent +/- / ++ / --
  return signLeading ? t.parenthesizedExpression(inner) : inner;
}

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

  generateProgram(baseScope?: Scope): t.File {
    const scope = baseScope ?? new Scope();
    const body: t.Statement[] = [];
    const statementCount = this.randint(1, this.config.maxStatements);
    this.requiredFlags.clear();

    // Seed the top-level scope with a couple of safely-initialized variables
    // (depth 1 ⇒ literal-only initializers) so later statements always have
    // something declared to reference. Without this, the first statements
    // have an empty visible scope and every identifier they emit is an
    // undeclared reference.
    for (let i = 0; i < 2; i++) {
      body.push(this.generateVariableDeclaration(scope, 1));
    }

    for (let i = 0; i < statementCount; i++) {
      const stmt = this.generateStatement(scope, this.config.maxExpressionDepth, true);
      body.push(this.maybeWrapTopLevel(stmt));
    }

    if (this.config.enableTierUp && this.rng() < this.config.tierUpProbability) {
      const tier = buildTierUpHarness(scope, this.rng, {
        maxLoopIterations: this.config.maxLoopIterations,
      });
      body.push(...tier.statements);
      for (const flag of tier.flags) this.requiredFlags.add(flag);
    }

    const programBody = t.program(body);
    if (this.config.enableModule) {
      // ES module mode: enables import.meta / static imports. d8 must run with
      // --module (added to requiredFlags; honored by the process-mode runner).
      programBody.sourceType = 'module';
      this.requiredFlags.add('--module');
    }
    return t.file(programBody);
  }

  /**
   * Usually wrap top-level non-declaration statements in try/catch so one
   * throwing statement doesn't abort the rest of the program (jsfunfuzz
   * style). Declarations must stay unwrapped: a let/const inside a try block
   * is scoped to that block and would be invisible to later statements.
   */
  private maybeWrapTopLevel(stmt: t.Statement): t.Statement {
    const wrappable =
      stmt.type === 'ExpressionStatement' ||
      stmt.type === 'IfStatement' ||
      stmt.type === 'ForStatement' ||
      stmt.type === 'ForOfStatement' ||
      stmt.type === 'ForInStatement' ||
      stmt.type === 'WhileStatement' ||
      stmt.type === 'ThrowStatement' ||
      stmt.type === 'TryStatement';
    if (wrappable && this.rand() < 0.8) {
      return this.generateTryCatchWrapped(stmt);
    }
    return stmt;
  }

  /** d8 flags the generated program needs (e.g. --expose-gc for gc()). */
  readonly requiredFlags: Set<string> = new Set();

  /** A labeled loop: `labelN: for/while/for-of (...) { ... }`. Labels are valid
   *  on any statement but most useful (and always safe) on loops. */
  generateLabeledStatement(scope: Scope, depth: number): t.LabeledStatement {
    const inner = this.pick<() => t.Statement>([
      (): t.Statement => this.generateForLoop(scope, depth - 1),
      (): t.Statement => this.generateWhileLoop(scope, depth - 1),
      (): t.Statement => this.generateForOfStatement(scope, depth - 1),
    ])();
    return t.labeledStatement(t.identifier(freshId('L')), inner);
  }

  /** Generated function bodies don't reference params, so params are usually
   *  empty; occasionally emit a rest parameter to cover that signature shape. */
  private functionParams(): Array<t.Identifier | t.RestElement> {
    if (this.rand() < 0.25) {
      return [t.restElement(t.identifier(freshId('rest')))];
    }
    return [];
  }

  /** Self-contained async iteration: `(async () => { for await (let x of ag()) {} })().catch(()=>{})`
   *  where `ag` is an async generator. Covers for-await-of / async iteration. */
  generateForAwaitStatement(scope: Scope, depth: number): t.ExpressionStatement {
    const asyncGen = t.functionExpression(
      null,
      [],
      t.blockStatement([t.expressionStatement(t.yieldExpression(t.numericLiteral(0)))]),
      true,
      true,
    );
    const forAwait = t.forOfStatement(
      t.variableDeclaration('let', [t.variableDeclarator(t.identifier(freshId('x')))]),
      t.callExpression(asyncGen, []),
      t.blockStatement([this.generateExpressionStatement(scope.child(), Math.max(0, depth - 1))]),
    );
    forAwait.await = true;
    const iife = t.callExpression(
      t.arrowFunctionExpression(
        [],
        t.blockStatement([
          t.tryStatement(t.blockStatement([forAwait]), t.catchClause(t.identifier('e'), t.blockStatement([]))),
        ]),
        true,
      ),
      [],
    );
    return t.expressionStatement(
      t.callExpression(t.memberExpression(iife, t.identifier('catch')), [
        t.arrowFunctionExpression([], t.blockStatement([])),
      ]),
    );
  }

  generateStatement(scope: Scope, depth: number, allowDestructuring = false): t.Statement {
    if (depth <= 0) {
      return this.generateTryCatchWrapped(this.generateExpressionStatement(scope, 1));
    }

    const choices: Array<() => t.Statement> = [
      (): t.Statement => this.generateVariableDeclaration(scope, depth - 1, allowDestructuring),
      (): t.Statement => this.generateTryCatchWrapped(this.generateExpressionStatement(scope, depth - 1)),
      (): t.Statement => this.generateForLoop(scope, depth - 1),
      (): t.Statement => this.generateForOfStatement(scope, depth - 1),
      (): t.Statement => this.generateForInStatement(scope, depth - 1),
      (): t.Statement => this.generateWhileLoop(scope, depth - 1),
      (): t.Statement => this.generateDoWhileStatement(scope, depth - 1),
      (): t.Statement => this.generateIfStatement(scope, depth - 1),
      (): t.Statement => this.generateSwitchStatement(scope, depth - 1),
      (): t.Statement => this.generateTryCatch(scope, depth - 1),
      (): t.Statement => this.generateFunctionDeclaration(scope, depth - 1),
      (): t.Statement => this.generateGcStatement(scope),
      (): t.Statement => this.generateAssignmentStatement(scope, depth - 1),
      (): t.Statement => this.generateAssignmentStatement(scope, depth - 1),
      (): t.Statement => this.generateLabeledStatement(scope, depth - 1),
    ];

    if (this.config.enableAsync && this.rand() < 0.15) {
      choices.push((): t.Statement => this.generateAsyncInvocation(scope, depth - 1));
    }
    if (this.config.enableAsync && this.declaredOnlyIdents === 0 && this.rand() < 0.1) {
      choices.push((): t.Statement => this.generateForAwaitStatement(scope, depth - 1));
    }
    if (this.config.enableClasses && this.rand() < 0.15) {
      choices.push((): t.Statement => this.generateClassDeclaration(scope, depth - 1));
    }
    if (this.declaredOnlyIdents === 0) {
      choices.push((): t.Statement => this.generateThrowStatement(scope, depth - 1));
    }

    return this.pick(choices)();
  }

  private generateTryCatchWrapped(stmt: t.Statement): t.TryStatement {
    return t.tryStatement(
      t.blockStatement([stmt]),
      t.catchClause(t.identifier('e'), t.blockStatement([]))
    );
  }

  generateVariableDeclaration(
    scope: Scope,
    depth: number,
    allowDestructuring = false,
  ): t.VariableDeclaration {
    const kind = this.pick<VariableSlot['kind']>(['var', 'let', 'const']);
    if (allowDestructuring && this.declaredOnlyIdents === 0 && this.rand() < 0.25) {
      return t.variableDeclaration(kind, [
        this.generateDestructuringDeclarator(scope, kind, depth),
      ]);
    }

    const name = freshId();
    const typeHint = this.pick<TypeHint>([
      'any',
      'number',
      'bigint',
      'string',
      'boolean',
      'array',
      'object',
      'function',
      'typedarray',
      'promise',
      'symbol',
      'weakmap',
      'weakset',
      'finalizationregistry',
      'proxy',
      'map',
      'set',
      'weakref',
    ]);
    // Declare after generating the initializer: for let/const the variable
    // is in the temporal dead zone inside its own initializer, so a
    // self-reference there would throw "Cannot access before initialization".
    this.declaredOnlyIdents++;
    let init: t.Expression;
    try {
      init = this.generateExpression(scope, typeHint, depth - 1);
    } finally {
      this.declaredOnlyIdents--;
    }
    scope.declare(name, kind, typeHint);

    return t.variableDeclaration(kind, [
      t.variableDeclarator(t.identifier(name), init),
    ]);
  }

  private generateDestructuringDeclarator(
    scope: Scope,
    kind: VariableSlot['kind'],
    depth: number,
  ): t.VariableDeclarator {
    const boundNames: string[] = [];
    const useArrayPattern = this.rand() < 0.5;
    let id: t.ArrayPattern | t.ObjectPattern;

    if (useArrayPattern) {
      const elements: Array<t.Identifier | t.RestElement> = [];
      const elementCount = this.randint(2, 3);
      for (let i = 0; i < elementCount; i++) {
        const name = freshId();
        boundNames.push(name);
        elements.push(t.identifier(name));
      }
      if (this.rand() < 0.25) {
        const restName = freshId('rest');
        boundNames.push(restName);
        elements.push(t.restElement(t.identifier(restName)));
      }
      id = t.arrayPattern(elements);
    } else {
      const valueName = freshId();
      const xName = freshId();
      boundNames.push(valueName, xName);
      id = t.objectPattern([
        t.objectProperty(t.identifier('value'), t.identifier(valueName)),
        t.objectProperty(t.identifier('x'), t.identifier(xName)),
      ]);
    }

    this.declaredOnlyIdents++;
    let init: t.Expression;
    try {
      init = this.generateExpression(
        scope,
        useArrayPattern ? 'array' : 'object',
        depth - 1,
      );
    } finally {
      this.declaredOnlyIdents--;
    }
    for (const name of boundNames) scope.declare(name, kind, 'any');

    return t.variableDeclarator(id, init);
  }

  generateExpressionStatement(scope: Scope, depth: number): t.ExpressionStatement {
    return t.expressionStatement(this.generateExpression(scope, 'any', depth));
  }

  /**
   * Assignment to a visible variable, member, or element. Property stores
   * and reassignments drive map transitions and JIT type feedback — the
   * grammar previously never mutated anything after initialization.
   */
  generateAssignmentStatement(scope: Scope, depth: number): t.Statement {
    const writable = scope.allVisible().filter((v) => v.kind !== 'const' && v.typeHint !== 'class');
    const objecty = scope.allVisible().filter(
      (v) => v.typeHint === 'object' || v.typeHint === 'array' || v.typeHint === 'typedarray',
    );

    const choices: Array<() => t.Statement> = [];
    if (writable.length > 0) {
      choices.push((): t.Statement => {
        const target = this.pick(writable);
        const hint = target.typeHint === 'any' ? 'any' : target.typeHint;
        const operators: t.AssignmentExpression['operator'][] =
          target.typeHint === 'number'
            ? ['=', '+=', '-=', '*=', '/=', '%=', '**=', '|=', '&=', '^=', '<<=', '>>=', '>>>=',
                ...LOGICAL_ASSIGNMENT_OPERATORS]
            : target.typeHint === 'string'
              ? ['=', '+=', ...LOGICAL_ASSIGNMENT_OPERATORS]
              : ['=', ...LOGICAL_ASSIGNMENT_OPERATORS];
        const operator = this.pick(operators);
        const rhsHint = LOGICAL_ASSIGNMENT_OPERATORS.includes(operator) ? 'any' : hint;
        return t.expressionStatement(
          t.assignmentExpression(
            operator,
            t.identifier(target.name),
            this.generateExpression(scope, rhsHint, 1),
          ),
        );
      });
    }
    if (objecty.length > 0) {
      choices.push((): t.Statement => {
        const target = this.pick(objecty);
        const member = target.typeHint === 'object'
          ? t.memberExpression(t.identifier(target.name), t.identifier(this.pick(['value', 'child', 'x', 'length'])))
          : t.memberExpression(t.identifier(target.name), t.numericLiteral(this.randint(0, 16)), true);
        const operator = this.pick<t.AssignmentExpression['operator']>([
          '=',
          ...LOGICAL_ASSIGNMENT_OPERATORS,
        ]);
        const value = operator === '=' && target.typeHint === 'typedarray'
          ? t.stringLiteral('0')
          : this.generateExpression(scope, 'any', 1);
        return t.expressionStatement(
          t.assignmentExpression(operator, member, value),
        );
      });
    }
    if (choices.length === 0) {
      return this.generateExpressionStatement(scope, depth);
    }
    return this.pick(choices)();
  }

  /** Property/element read on a visible object, array, or typed array. */
  generateMemberReadExpression(scope: Scope, _depth: number): t.Expression {
    const objecty = scope.allVisible().filter(
      (v) => v.typeHint === 'object' || v.typeHint === 'array' || v.typeHint === 'typedarray',
    );
    if (objecty.length === 0) {
      return this.generateNumberExpression(scope);
    }
    const target = this.pick(objecty);
    if (target.typeHint === 'object') {
      return t.memberExpression(
        t.identifier(target.name),
        t.identifier(this.pick(['value', 'child', 'x', 'key_0', freshId('key')])),
      );
    }
    const index = this.rand() < 0.7
      ? t.numericLiteral(this.randint(0, 16))
      : this.generateExpression(scope, 'number', 1);
    return t.memberExpression(t.identifier(target.name), index, true);
  }

  /** Bounded optional member/call chain rooted in an object-like value. */
  generateOptionalChaining(scope: Scope, depth: number): t.Expression {
    if (depth <= 0) {
      return t.numericLiteral(0);
    }

    const objecty = scope.allVisible().filter(
      (v) => v.typeHint === 'object' || v.typeHint === 'array' || v.typeHint === 'typedarray',
    );
    const target = objecty.length > 0 ? this.pick(objecty) : null;
    let chain: t.Expression = target
      ? t.identifier(target.name)
      : t.objectExpression([
          t.objectProperty(t.identifier('v'), t.numericLiteral(0)),
        ]);
    const useIndices = target?.typeHint === 'array' || target?.typeHint === 'typedarray';
    const linkCount = this.randint(1, Math.min(3, depth));
    const callLink = linkCount > 1 && this.rand() < 0.35 ? linkCount - 1 : -1;

    for (let i = 0; i < linkCount; i++) {
      if (i === callLink) {
        chain = t.optionalCallExpression(chain, [], true);
      } else {
        const property = useIndices
          ? t.numericLiteral(this.randint(0, 3))
          : t.identifier(this.pick(['v', 'x', 'value', 'child']));
        chain = t.optionalMemberExpression(chain, property, useIndices, true);
      }
    }
    return chain;
  }

  /** Method call on a visible builtin-typed variable (array, weakmap, ...). */
  generateMethodCallExpression(scope: Scope, depth: number): t.Expression {
    const candidates = scope.allVisible().filter((v) =>
      [
        'array',
        'typedarray',
        'map',
        'set',
        'weakref',
        'weakmap',
        'weakset',
        'promise',
        'string',
      ].includes(v.typeHint),
    );
    if (candidates.length === 0) {
      return this.generateMemberReadExpression(scope, depth);
    }
    const target = this.pick(candidates);
    const obj = t.identifier(target.name);
    const call = (method: string, args: t.Expression[]): t.CallExpression =>
      t.callExpression(t.memberExpression(obj, t.identifier(method)), args);

    switch (target.typeHint) {
      case 'array': {
        const method = this.pick(['push', 'pop', 'shift', 'unshift', 'fill', 'reverse', 'indexOf', 'concat']);
        const args: t.Expression[] = ['push', 'unshift', 'fill', 'indexOf', 'concat'].includes(method)
          ? [this.generateAnyExpression(scope, 1)]
          : [];
        return call(method, args);
      }
      case 'typedarray': {
        // Avoid full-buffer scans/copies here. A generated typed array can be
        // tens of thousands of elements and this expression may sit in a
        // loop; sort/reverse/fill would turn a valid testcase into a timeout.
        const method = this.pick(['subarray', 'set']);
        return method === 'set'
          ? call('set', [t.arrayExpression([])])
          : call('subarray', [t.numericLiteral(0), t.numericLiteral(0)]);
      }
      case 'map': {
        const method = this.pick(['get', 'set', 'has', 'delete']);
        const key = this.generateAnyExpression(scope, 1);
        return call(method, method === 'set' ? [key, this.generateAnyExpression(scope, 1)] : [key]);
      }
      case 'set': {
        const method = this.pick(['add', 'has', 'delete']);
        return call(method, [this.generateAnyExpression(scope, 1)]);
      }
      case 'weakref':
        return call('deref', []);
      case 'weakmap': {
        const method = this.pick(['get', 'set', 'has', 'delete']);
        const key = this.generateExpression(scope, 'object', 1);
        return call(method, method === 'set' ? [key, this.generateAnyExpression(scope, 1)] : [key]);
      }
      case 'weakset': {
        const method = this.pick(['add', 'has', 'delete']);
        return call(method, [this.generateExpression(scope, 'object', 1)]);
      }
      case 'promise': {
        const method = this.pick(['then', 'catch', 'finally']);
        const result = call(method, [t.arrowFunctionExpression([t.identifier('v')], t.blockStatement([]))]);
        // Every generated promise chain gets a terminal rejection handler.
        // Otherwise `finally()` or a rejected input promise creates an
        // unhandled rejection even when the surrounding statement is caught.
        return t.callExpression(
          t.memberExpression(result, t.identifier('catch')),
          [t.arrowFunctionExpression([], t.blockStatement([]))],
        );
      }
      default: {
        // string — repeat gets a bounded count: an edge-number count builds
        // a multi-GiB string, the same hang class as giant typed arrays.
        const method = this.pick(['charAt', 'indexOf', 'slice', 'repeat', 'split']);
        const arg = method === 'repeat'
          ? t.numericLiteral(this.randint(0, 1000))
          : this.generateExpression(scope, 'number', 1);
        return call(method, [arg]);
      }
    }
  }

  generateExpression(scope: Scope, hint: TypeHint, depth: number): t.Expression {
    if (depth <= 0) {
      return this.generateTerminalExpression(scope, hint);
    }

    switch (hint) {
      case 'number':
        return this.generateNumberExpression(scope, depth);
      case 'bigint':
        return this.generateBigIntExpression(scope, depth);
      case 'string':
        return this.generateStringExpression(scope, depth);
      case 'boolean':
        return this.generateBooleanExpression(scope, depth);
      case 'array':
        return this.generateArrayExpression(scope, depth - 1);
      case 'object': {
        // Sometimes instantiate a visible class instead of an object
        // literal — classes were previously declared but never constructed.
        // Skipped in uncatchable contexts: constructor bodies can throw.
        const classes = scope.allVisible().filter(
          (v) => v.typeHint === 'class' && !this.activeClassNames.has(v.name),
        );
        if (classes.length > 0 && this.declaredOnlyIdents === 0 && this.rand() < 0.4) {
          return t.newExpression(t.identifier(this.pick(classes).name), []);
        }
        return this.generateObjectExpression(scope, depth - 1);
      }
      case 'function': {
        // Vary the function flavor: plain / async / generator / async-generator.
        const roll = this.rand();
        const async = this.config.enableAsync && roll < 0.25;
        const generator = this.config.enableGenerators && roll >= 0.25 && roll < 0.5;
        const asyncGen =
          this.config.enableAsync && this.config.enableGenerators && roll >= 0.5 && roll < 0.6;
        return this.generateFunctionExpression(
          scope,
          async || asyncGen,
          generator || asyncGen,
          depth - 1,
        );
      }
      case 'typedarray':
        return this.generateTypedArrayExpression(scope, depth - 1);
      case 'promise':
        return this.generatePromiseExpression(scope, depth - 1);
      case 'symbol':
        return this.generateSymbolExpression(scope, depth);
      case 'map':
        return this.generateMapExpression(scope, depth);
      case 'set':
        return this.generateSetExpression(scope, depth);
      case 'weakref':
        return this.generateWeakRefExpression(scope, depth);
      case 'weakmap':
        return this.generateWeakMapExpression(scope, depth);
      case 'weakset':
        return this.generateWeakSetExpression(scope, depth);
      case 'finalizationregistry':
        return this.generateFinalizationRegistryExpression(scope, depth);
      case 'proxy':
        return this.generateProxyExpression(scope, depth);
      case 'class':
        return this.generateClassExpression(scope, depth - 1);
      default:
        return this.generateAnyExpression(scope, depth - 1);
    }
  }

  /** `new Proxy(target, handler)` with a simple, non-throwing `get` trap so the
   *  proxy never throws on property access. Exercises Proxy/meta-object behavior. */
  generateProxyExpression(scope: Scope, depth: number): t.NewExpression {
    const target = this.generateExpression(scope, 'object', depth - 1);
    const handler = t.objectExpression([
      t.objectMethod(
        'method',
        t.identifier('get'),
        [t.identifier('t'), t.identifier('p')],
        t.blockStatement([t.returnStatement(t.numericLiteral(0))]),
      ),
    ]);
    return t.newExpression(t.identifier('Proxy'), [target, handler]);
  }

  /** `Reflect.get/has/ownKeys/getPrototypeOf(target[, key])` — real meta-object
   *  operations on an object-typed target (always an object, so no throw). */
  generateReflectCall(scope: Scope, depth: number): t.CallExpression {
    const objecty = scope.allVisible().filter(
      (v) => v.typeHint === 'object' || v.typeHint === 'array' || v.typeHint === 'typedarray'
        || v.typeHint === 'function' || v.typeHint === 'map' || v.typeHint === 'set',
    );
    const target = objecty.length > 0
      ? t.identifier(this.pick(objecty).name)
      : this.generateExpression(scope, 'object', Math.max(0, depth - 1));
    const op = this.pick(['get', 'has', 'ownKeys', 'getPrototypeOf']);
    const args: t.Expression[] = [target];
    if (op === 'get' || op === 'has') {
      args.push(this.generateExpression(scope, this.pick<TypeHint>(['string', 'number']), Math.max(0, depth - 1)));
    }
    return t.callExpression(t.memberExpression(t.identifier('Reflect'), t.identifier(op)), args);
  }

  generateTerminalExpression(scope: Scope, hint: TypeHint): t.Expression {
    switch (hint) {
      case 'number':
        return this.generateNumberExpression(scope);
      case 'bigint':
        return this.generateBigIntExpression(scope);
      case 'string':
        return this.generateStringExpression(scope);
      case 'boolean':
        return t.booleanLiteral(this.rand() < 0.5);
      case 'array':
        return t.arrayExpression([]);
      case 'object':
        return t.objectExpression([]);
      case 'function':
        return t.arrowFunctionExpression([], t.blockStatement([]));
      case 'typedarray':
        return t.newExpression(t.identifier('Uint8Array'), [t.numericLiteral(0)]);
      case 'map':
        return t.newExpression(t.identifier('Map'), [t.arrayExpression([])]);
      case 'set':
        return t.newExpression(t.identifier('Set'), [t.arrayExpression([])]);
      case 'weakref':
        return t.newExpression(t.identifier('WeakRef'), [t.objectExpression([])]);
      case 'weakmap':
        return t.newExpression(t.identifier('WeakMap'), []);
      case 'weakset':
        return t.newExpression(t.identifier('WeakSet'), []);
      case 'finalizationregistry':
        return t.newExpression(t.identifier('FinalizationRegistry'), [
          t.arrowFunctionExpression([t.identifier('value')], t.blockStatement([])),
        ]);
      case 'proxy':
        return t.newExpression(t.identifier('Proxy'), [
          t.objectExpression([]),
          t.objectExpression([
            t.objectMethod(
              'method',
              t.identifier('get'),
              [t.identifier('t'), t.identifier('p')],
              t.blockStatement([t.returnStatement(t.numericLiteral(0))]),
            ),
          ]),
        ]);
      case 'promise':
        return t.newExpression(
          t.identifier('Promise'),
          [t.arrowFunctionExpression([t.identifier('resolve'), t.identifier('reject')], t.blockStatement([]))],
        );
      case 'symbol':
        return t.callExpression(t.identifier('Symbol'), []);
      case 'class':
        return t.classExpression(null, null, t.classBody([]));
      default:
        return this.generateNumberExpression(scope);
    }
  }

  /** Dynamic `import(specifier).catch(()=>{})` — bare specifiers reject fast
   *  (no module resolves); the catch absorbs the rejection so it never leaks as
   *  an unhandled top-level failure. Exercises dynamic-import / module loading. */
  generateDynamicImport(_scope: Scope, _depth: number): t.Expression {
    const specifier = this.pick(['x', 'm', 'fs']);
    return t.callExpression(
      t.memberExpression(t.importExpression(t.stringLiteral(specifier)), t.identifier('catch')),
      [t.arrowFunctionExpression([], t.blockStatement([]))],
    );
  }

  /** Common builtin calls: new Error/TypeError/RangeError, Array.from/of/isArray,
   *  Object.keys/values/entries/freeze, Date.now. Args use type-matched hints so
   *  they don't throw (Array.from needs iterable, Object.* needs object). */
  generateBuiltinCall(scope: Scope, depth: number): t.Expression {
    const roll = this.rand();
    if (roll < 0.3) {
      return t.newExpression(
        t.identifier(this.pick(['Error', 'TypeError', 'RangeError', 'SyntaxError'])),
        [this.generateStringExpression(scope, 0)],
      );
    }
    if (roll < 0.6) {
      return t.callExpression(
        t.memberExpression(t.identifier('Array'), t.identifier(this.pick(['from', 'of', 'isArray']))),
        [this.generateExpression(scope, 'array', Math.max(0, depth - 1))],
      );
    }
    if (roll < 0.85) {
      return t.callExpression(
        t.memberExpression(t.identifier('Object'), t.identifier(this.pick(['keys', 'values', 'entries', 'freeze']))),
        [this.generateExpression(scope, 'object', Math.max(0, depth - 1))],
      );
    }
    return t.callExpression(t.memberExpression(t.identifier('Date'), t.identifier('now')), []);
  }

  /** `import.meta.url` — only valid in ES module mode (enableModule). */
  generateImportMeta(): t.Expression {
    return t.memberExpression(
      t.metaProperty(t.identifier('import'), t.identifier('meta')),
      t.identifier('url'),
    );
  }

  generateAnyExpression(scope: Scope, depth: number, inGenerator = false): t.Expression {
    if (depth <= 0) {
      return this.generateTerminalExpression(scope, 'any');
    }

    const entries: Array<{ key: ProductionKey; make: () => t.Expression }> = [
      { key: 'number', make: (): t.Expression => this.generateNumberExpression(scope, depth - 1) },
      { key: 'bigint', make: (): t.Expression => this.generateBigIntExpression(scope, depth - 1) },
      { key: 'string', make: (): t.Expression => this.generateStringExpression(scope, depth - 1) },
      { key: 'boolean', make: (): t.Expression => this.generateBooleanExpression(scope, depth - 1) },
      { key: 'array', make: (): t.Expression => this.generateArrayExpression(scope, depth - 1) },
      { key: 'object', make: (): t.Expression => this.generateObjectExpression(scope, depth - 1) },
      // In uncatchable contexts (declaration initializers) with an empty
      // visible scope there is no declared name to reference — emit a
      // literal instead of a guaranteed-undeclared identifier.
      {
        key: 'identifier',
        make: (): t.Expression =>
          this.declaredOnlyIdents > 0 && scope.allVisible().length === 0
            ? this.generateNumberExpression(scope)
            : this.generateIdentifier(scope),
      },
      { key: 'binary', make: (): t.Expression => this.generateBinaryExpression(scope, depth - 1) },
      { key: 'conditional', make: (): t.Expression => this.generateConditionalExpression(scope, depth - 1) },
      { key: 'logical', make: (): t.Expression => this.generateLogicalExpression(scope, depth - 1) },
      { key: 'unary', make: (): t.Expression => this.generateUnaryExpression(scope, depth - 1) },
      { key: 'sequence', make: (): t.Expression => this.generateSequenceExpression(scope, depth - 1) },
      { key: 'template', make: (): t.Expression => this.generateTemplateLiteral(scope, depth - 1) },
      { key: 'taggedTemplate', make: (): t.Expression => this.generateTaggedTemplate(scope, depth - 1) },
      { key: 'call', make: (): t.Expression => this.generateCallExpression(scope, depth - 1) },
      { key: 'memberRead', make: (): t.Expression => this.generateMemberReadExpression(scope, depth - 1) },
      { key: 'optionalChaining', make: (): t.Expression => this.generateOptionalChaining(scope, depth - 1) },
      { key: 'regExp', make: (): t.Expression => this.generateRegExpExpression() },
      { key: 'symbol', make: (): t.Expression => this.generateSymbolExpression(scope, depth - 1) },
      // Method calls can throw (wrong receiver, huge repeat count, ...), so
      // in uncatchable contexts fall back to a plain member read.
      {
        key: 'methodCall',
        make: (): t.Expression =>
          this.declaredOnlyIdents > 0
            ? this.generateMemberReadExpression(scope, depth - 1)
            : this.generateMethodCallExpression(scope, depth - 1),
      },
      {
        key: 'reflectCall',
        make: (): t.Expression =>
          this.declaredOnlyIdents > 0
            ? this.generateMemberReadExpression(scope, depth - 1)
            : this.generateReflectCall(scope, depth - 1),
      },
      {
        key: 'builtinCall',
        make: (): t.Expression =>
          this.declaredOnlyIdents > 0
            ? this.generateMemberReadExpression(scope, depth - 1)
            : this.generateBuiltinCall(scope, depth - 1),
      },
    ];

    if (this.config.enableAsync) {
      entries.push({ key: 'promise', make: (): t.Expression => this.generatePromiseExpression(scope, depth - 1) });
      entries.push({ key: 'dynamicImport', make: (): t.Expression => this.generateDynamicImport(scope, depth - 1) });
    }
    if (this.config.enableGenerators && inGenerator) {
      entries.push({ key: 'yield', make: (): t.Expression => this.generateYieldExpression(scope, depth - 1) });
    }
    // A generator function only runs when next() is called. Generate a
    // complete invocation so generator bodies (including yield lowering and
    // finally paths) contribute runtime coverage instead of being dead AST.
    if (this.config.enableGenerators && this.declaredOnlyIdents === 0) {
      entries.push({ key: 'generatorInvocation', make: (): t.Expression => this.generateGeneratorInvocation(scope, depth - 1) });
    }
    if (this.config.enableModule) {
      entries.push({ key: 'importMeta', make: (): t.Expression => this.generateImportMeta() });
    }

    const weights = entries.map((entry) => this.config.productionWeights?.[entry.key] ?? 1);
    // Single rng draw — with default (equal) weights, weightedIndex reduces
    // to floor(r * N), byte-identical to the prior pick(randint) path, so a
    // given seed yields the same program.
    const r = this.rng();
    const i = this.weightedIndex(weights, r);
    const chosen = entries[i];
    this.productionCounts[chosen.key] = (this.productionCounts[chosen.key] ?? 0) + 1;
    return chosen.make();
  }

  generateGeneratorExpression(scope: Scope, depth: number, async = false): t.FunctionExpression {
    const inner = scope.child();
    return t.functionExpression(
      null,
      this.functionParams(),
      t.blockStatement([
        this.generateStatement(inner, depth),
        t.returnStatement(this.generateAnyExpression(inner, depth, true)),
      ]),
      true,
      async,
    );
  }

  generateNumberExpression(scope: Scope, depth = 0): t.Expression {
    if (depth > 0) {
      const numeric = scope.allVisible().filter((v) => v.typeHint === 'number');
      const choices: Array<() => t.Expression> = [
        (): t.Expression => this.generateNumberExpression(scope, 0),
        (): t.Expression => this.generateBinaryExpression(scope, depth - 1),
        (): t.Expression => t.unaryExpression(
          this.pick(['+', '-']),
          t.parenthesizedExpression(this.generateNumberExpression(scope, depth - 1)),
        ),
      ];
      if (numeric.length > 0) {
        choices.push((): t.Expression => t.identifier(this.pick(numeric).name));
      }
      return this.pick(choices)();
    }
    if (this.rand() < 0.3) {
      const value = this.pick(EDGE_NUMBERS);
      // Babel's NumericLiteral printer normalizes -0 to 0. Preserve the
      // signed-zero edge explicitly because it drives distinct V8 feedback.
      if (Object.is(value, -0)) {
        return t.unaryExpression('-', t.numericLiteral(0));
      }
      return edgeNumberExpression(value);
    }
    return t.numericLiteral(this.randint(-100, 100));
  }

  generateBigIntExpression(scope: Scope, depth = 0): t.Expression {
    const values = [
      '0',
      '1',
      '-1',
      '7',
      '9223372036854775807',
      '-9223372036854775808',
      '18446744073709551615',
      '18446744073709551616',
    ];
    if (depth > 0 && this.rand() < 0.35) {
      return t.binaryExpression(
        this.pick(['+', '-', '*'] as t.BinaryExpression['operator'][]),
        this.generateBigIntExpression(scope, depth - 1),
        this.generateBigIntExpression(scope, depth - 1),
      );
    }
    const value = this.pick(values);
    return value.startsWith('-')
      ? t.unaryExpression('-', t.bigIntLiteral(value.slice(1)))
      : t.bigIntLiteral(value);
  }

  generateStringExpression(scope: Scope, depth = 0): t.Expression {
    if (depth > 0) {
      const strings = scope.allVisible().filter((v) => v.typeHint === 'string');
      const choices: Array<() => t.Expression> = [
        (): t.Expression => this.generateStringExpression(scope, 0),
        (): t.Expression => t.binaryExpression(
          '+',
          this.generateStringExpression(scope, depth - 1),
          this.generateStringExpression(scope, depth - 1),
        ),
      ];
      if (strings.length > 0) {
        choices.push((): t.Expression => t.identifier(this.pick(strings).name));
      }
      return this.pick(choices)();
    }
    const strings = [
      '',
      'a',
      'abc',
      '0',
      '[]',
      '{}',
      '\\k<1>',
      '\u2028',
      '\u{1F600}',
      '\0',
      '\t\r\n',
      'NaN',
      'undefined',
      'abcdefghij',
    ];
    return t.stringLiteral(this.pick(strings));
  }

  generateConditionalExpression(scope: Scope, depth: number): t.ConditionalExpression {
    return t.conditionalExpression(
      this.generateBooleanExpression(scope, Math.max(0, depth)),
      this.generateAnyExpression(scope, Math.max(0, depth)),
      this.generateAnyExpression(scope, Math.max(0, depth)),
    );
  }

  generateLogicalExpression(scope: Scope, depth: number): t.LogicalExpression {
    return t.logicalExpression(
      this.pick(LOGICAL_OPERATORS),
      this.generateAnyExpression(scope, Math.max(0, depth)),
      this.generateAnyExpression(scope, Math.max(0, depth)),
    );
  }

  generateUnaryExpression(scope: Scope, depth: number): t.UnaryExpression {
    if (this.rand() < 0.2) {
      const obj = scope.allVisible().filter(
        (v) => v.typeHint === 'object' || v.typeHint === 'array' || v.typeHint === 'typedarray',
      );
      if (obj.length > 0) {
        const target = this.pick(obj);
        // `delete obj.prop` is always valid (returns true). Deleting a bare
        // non-reference is invalid in strict mode, so only delete members.
        return t.unaryExpression(
          'delete',
          t.memberExpression(
            t.identifier(target.name),
            t.identifier(this.pick(['x', 'value', 'child'])),
          ),
        );
      }
    }
    return t.unaryExpression(
      this.pick(['!', '~', 'typeof', 'void'] as t.UnaryExpression['operator'][]),
      this.generateAnyExpression(scope, Math.max(0, depth)),
    );
  }

  generateSequenceExpression(scope: Scope, depth: number): t.SequenceExpression {
    const count = this.randint(2, 3);
    return t.sequenceExpression(
      Array.from({ length: count }, () => this.generateAnyExpression(scope, Math.max(0, depth))),
    );
  }

  generateTemplateLiteral(scope: Scope, depth: number): t.TemplateLiteral {
    const expressions = this.rand() < 0.65
      ? [this.generateTemplateInterpolation(scope, Math.max(0, depth))]
      : [];
    const quasis = expressions.length === 0
      ? [t.templateElement({ raw: 'stress', cooked: 'stress' }, true)]
      : [
          t.templateElement({ raw: 'stress-', cooked: 'stress-' }, false),
          t.templateElement({ raw: '-value', cooked: '-value' }, true),
        ];
    return t.templateLiteral(quasis, expressions);
  }

  /** Tagged template literal: `` tag`text ${x}` `` — the tag is a visible
   *  function (or a safe builtin like String/Array/Object) and the template is
   *  a normal TemplateLiteral. */
  generateTaggedTemplate(scope: Scope, depth: number): t.TaggedTemplateExpression {
    const fns = scope.allVisible().filter(
      (v) => v.typeHint === 'function' && !this.activeFunctionNames.has(v.name),
    );
    const tag = fns.length > 0
      ? t.identifier(this.pick(fns).name)
      : t.identifier(this.pick(['String', 'Array', 'Object']));
    return t.taggedTemplateExpression(tag, this.generateTemplateLiteral(scope, Math.max(0, depth)));
  }

  /** Template interpolation must be string-coercible: Symbol values throw
   * during implicit conversion and would abort otherwise useful testcases. */
  private generateTemplateInterpolation(scope: Scope, depth: number): t.Expression {
    // Interpolations must be string-COERCIBLE primitives: a Symbol value throws
    // during implicit conversion. Use a bare boolean literal (NOT the full
    // boolean producer, which can reach Symbol via relational/any expressions).
    const choices: Array<() => t.Expression> = [
      (): t.Expression => this.generateNumberExpression(scope, depth),
      (): t.Expression => this.generateStringExpression(scope, depth),
      (): t.Expression => t.booleanLiteral(this.rand() < 0.5),
      (): t.Expression => t.nullLiteral(),
    ];
    return this.pick(choices)();
  }

  generateBooleanExpression(scope: Scope, depth = 0): t.Expression {
    const booleans = scope.allVisible().filter((v) => v.typeHint === 'boolean');
    if (depth > 0 && booleans.length > 0 && this.rand() < 0.35) {
      return t.identifier(this.pick(booleans).name);
    }
    if (depth > 0 && this.rand() < 0.35) {
      return this.generateRelationalExpression(scope, depth);
    }
    if (depth > 0 && this.rand() < 0.35) {
      return t.unaryExpression('!', this.generateAnyExpression(scope, depth - 1));
    }
    if (depth > 0 && this.rand() < 0.35) {
      const operandDepth = Math.max(0, depth - 1);
      return t.binaryExpression(
        this.pick(COMPARISON_OPERATORS),
        this.generateExpression(scope, 'number', operandDepth),
        this.generateExpression(scope, 'number', operandDepth),
      );
    }
    return t.booleanLiteral(this.rand() < 0.5);
  }

  generateRelationalExpression(scope: Scope, depth: number): t.BinaryExpression {
    const operandDepth = Math.max(0, depth - 1);
    if (this.rand() < 0.5) {
      const objects = scope.allVisible().filter((v) =>
        v.typeHint === 'object' || v.typeHint === 'array' || v.typeHint === 'typedarray'
      );
      const object = objects.length > 0
        ? t.identifier(this.pick(objects).name)
        : this.generateExpression(scope, 'object', operandDepth);
      return t.binaryExpression(
        'in',
        this.generateExpression(scope, this.pick<TypeHint>(['string', 'number']), operandDepth),
        object,
      );
    }

    const classes = scope.allVisible().filter(
      (v) => v.typeHint === 'class' && !this.activeClassNames.has(v.name),
    );
    const functions = scope.allVisible().filter(
      (v) => v.typeHint === 'function' && !this.activeFunctionNames.has(v.name),
    );
    let constructor: t.Expression;
    if (classes.length > 0) {
      constructor = t.identifier(this.pick(classes).name);
    } else if (functions.length > 0) {
      constructor = t.identifier(this.pick(functions).name);
    } else {
      const name = freshId();
      const arrow = t.arrowFunctionExpression([], t.blockStatement([]));
      constructor = t.callExpression(
        t.arrowFunctionExpression(
          [t.identifier(name)],
          t.sequenceExpression([
            t.assignmentExpression(
              '=',
              t.memberExpression(t.identifier(name), t.identifier('prototype')),
              t.objectExpression([]),
            ),
            t.identifier(name),
          ]),
        ),
        [arrow],
      );
    }
    return t.binaryExpression(
      'instanceof',
      this.generateAnyExpression(scope, operandDepth),
      constructor,
    );
  }

  generateSymbolExpression(scope: Scope, depth = 0): t.Expression {
    const symbols = scope.allVisible().filter((v) => v.typeHint === 'symbol');
    if (depth > 0 && symbols.length > 0 && this.rand() < 0.35) {
      return t.identifier(this.pick(symbols).name);
    }
    return t.callExpression(
      t.identifier('Symbol'),
      depth > 0 && this.rand() < 0.5
        ? [this.generateStringExpression(scope, depth - 1)]
        : [],
    );
  }

  /** RegExp literals exercise the regexp parser/compiler in ordinary JS runs. */
  generateRegExpExpression(): t.RegExpLiteral {
    const patterns = [
      '(a)\\1',
      '(?<name>a)\\k<name>',
      '(?<=a)b',
      '(?:a|b){0,3}',
    ];
    const flags = this.pick(['', 'g', 'u', 's', 'y', 'm', 'i', 'd']);
    return t.regExpLiteral(this.pick(patterns), flags);
  }

  generateArrayExpression(scope: Scope, depth: number): t.ArrayExpression {
    const elements: Array<t.Expression | t.SpreadElement | null> = [];
    const len = this.randint(0, 5);
    for (let i = 0; i < len; i++) {
      if (depth > 0 && this.rand() < 0.15) {
        elements.push(t.spreadElement(this.generateArrayExpression(scope, depth - 1)));
      } else {
        elements.push(this.rand() < 0.2 ? null : this.generateAnyExpression(scope, depth));
      }
    }
    return t.arrayExpression(elements);
  }

  generateObjectExpression(scope: Scope, depth: number): t.ObjectExpression {
    const properties: Array<t.ObjectProperty | t.ObjectMethod | t.SpreadElement> = [];
    const len = this.randint(0, 4);
    for (let i = 0; i < len; i++) {
      if (depth > 0 && this.rand() < 0.15) {
        properties.push(t.spreadElement(this.generateObjectExpression(scope, depth - 1)));
      } else {
        const keyRoll = this.rand();
        let key: t.Expression;
        let computed = false;
        if (keyRoll < 0.2) {
          // Computed key: `[expr]: value` — exercises non-constant object shapes.
          computed = true;
          key = this.pick<t.Expression>([
            t.numericLiteral(this.randint(0, 9)),
            t.stringLiteral('v'),
            t.stringLiteral('x'),
          ]);
        } else if (keyRoll < 0.5) {
          key = t.stringLiteral(freshId('key'));
        } else {
          key = t.identifier(freshId('key'));
        }
        properties.push(
          t.objectProperty(key, this.generateAnyExpression(scope, depth), computed),
        );
      }
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
    // Prefer variables visible from this scope (including ancestors); only
    // Undeclared references are opt-in. Previously this used scope.all()
    // (current scope only) and fell back to a fresh undeclared name 30% of the
    // time, so almost every testcase died before later statements executed.
    // While generating a declaration initializer (declaredOnlyIdents > 0)
    // undeclared refs are banned entirely: declarations can't be try/catch
    // wrapped without breaking scoping, so a throw there is uncatchable.
    const vars = scope.allVisible();
    const declaredThreshold = this.declaredOnlyIdents > 0 || !this.config.allowUndeclaredIdentifiers
      ? 1.0
      : 0.95;
    if (vars.length > 0 && this.rand() < declaredThreshold) {
      return t.identifier(this.pick(vars).name);
    }
    // `undefined` is a real global binding and still exercises undefined
    // value feedback without aborting the whole top-level testcase.
    return t.identifier('undefined');
  }

  /** >0 while generating a declaration initializer (see generateIdentifier). */
  private declaredOnlyIdents = 0;

  /** Function declarations visible to the current generated function body. */
  private activeFunctionNames: Set<string> = new Set();

  /** Class constructors must not instantiate themselves recursively. */
  private activeClassNames: Set<string> = new Set();

  generateBinaryExpression(scope: Scope, depth: number): t.BinaryExpression {
    const op = this.pick(ARITHMETIC_OPERATORS);
    // Both operands consume one level. This guarantees that recursive numeric
    // and string productions terminate at the configured expression depth.
    const operandDepth = Math.max(0, depth - 1);
    const left = this.generateExpression(scope, 'number', operandDepth);
    return t.binaryExpression(
      op,
      // ECMAScript forbids an unparenthesized unary/negative base for **;
      // NumericLiteral(-27) is printed with a leading minus even though it is
      // represented as one AST node, so parenthesize every exponent base.
      op === '**' ? t.parenthesizedExpression(left) : left,
      this.generateExpression(scope, 'number', operandDepth),
    );
  }

  generateCallExpression(scope: Scope, depth: number): t.CallExpression {
    // Prefer callees that are actually functions — calling an arbitrary
    // visible variable usually throws "X is not a function" before any of
    // the interesting argument evaluation happens. In uncatchable contexts
    // with no function in scope, fall back to a stub closure rather than an
    // undeclared identifier.
    const fns = scope.allVisible().filter(
      (v) => v.typeHint === 'function' && !this.activeFunctionNames.has(v.name),
    );
    const visibleFunctionCount = scope.allVisible().filter((v) => v.typeHint === 'function').length;
    let callee: t.Expression;
    if (fns.length > 0) {
      callee = t.identifier(this.pick(fns).name);
    } else if (visibleFunctionCount > 0 || this.declaredOnlyIdents > 0) {
      // If every visible function is active, use a local stub instead of
      // emitting a direct recursive call with no base case. A stub is also
      // the only callable fallback when declarations are still initializing.
      callee = t.arrowFunctionExpression([], t.blockStatement([]));
    } else {
      // There is no callable binding in an empty scope. An inline closure
      // keeps the call production runtime-safe without inventing globals.
      callee = t.arrowFunctionExpression([], t.blockStatement([]));
    }
    const argc = this.randint(0, 3);
    const includeSpread = this.rand() < 0.15;
    const argumentCount = includeSpread ? Math.max(1, argc) : argc;
    const spreadIndex = includeSpread ? this.randint(0, argumentCount - 1) : -1;
    const args: Array<t.Expression | t.SpreadElement> = [];
    for (let i = 0; i < argumentCount; i++) {
      args.push(
        i === spreadIndex
          ? t.spreadElement(this.generateExpression(scope, 'array', depth))
          : this.generateAnyExpression(scope, depth),
      );
    }
    return t.callExpression(callee, args);
  }

  generateGeneratorInvocation(scope: Scope, depth: number): t.CallExpression {
    const generator = this.generateGeneratorExpression(scope, depth);
    return t.callExpression(
      t.memberExpression(t.callExpression(generator, []), t.identifier('next')),
      [],
    );
  }

  generateForLoop(scope: Scope, depth: number): t.ForStatement {
    const inner = scope.child();
    const index = freshId();
    // The emitted loop variable is let, but expose it as read-only to body
    // generation. Assignments from nested callbacks otherwise can reset the
    // induction variable and turn a bounded loop into an unbounded one.
    inner.declare(index, 'const', 'number');
    const limit = this.randint(1, this.config.maxLoopIterations);
    const init = this.randint(-10, 10);

    // Correlate test direction with update direction so loops terminate:
    // counting up tests < /<=, counting down tests > />=. Previously these
    // were picked independently, making roughly half of all loops infinite
    // and burning a full d8 timeout each.
    const countUp = this.rand() < 0.95;
    const test = countUp
      ? (this.rand() < 0.5 ? '<' : '<=')
      : (this.rand() < 0.5 ? '>' : '>=');
    const update = countUp ? '++' : '--';
    // When counting down, start above the limit so the loop executes at least
    // once. Adding the prior random initializer could still leave start below
    // the bound and silently remove the loop's body from coverage.
    const start = countUp ? Math.min(init, limit - 1) : limit + 1 + this.randint(0, 10);

    return t.forStatement(
      t.variableDeclaration('let', [
        t.variableDeclarator(t.identifier(index), t.numericLiteral(start)),
      ]),
      t.binaryExpression(
        test,
        t.identifier(index),
        t.numericLiteral(limit),
      ),
      t.updateExpression(update, t.identifier(index), false),
      t.blockStatement([
        this.generateVariableDeclaration(inner, depth),
        this.generateExpressionStatement(inner, depth),
      ]),
    );
  }

  generateForOfStatement(scope: Scope, depth: number): t.ForOfStatement {
    const inner = scope.child();
    const loopVar = freshId('of');
    inner.declare(loopVar, 'const', 'any');
    const iterables = scope.allVisible().filter((v) =>
      v.typeHint === 'array' || v.typeHint === 'string' || v.typeHint === 'typedarray'
    );
    const right = iterables.length > 0
      ? t.identifier(this.pick(iterables).name)
      : this.generateExpression(scope, 'array', Math.max(0, depth - 1));
    const statementCount = this.randint(1, 2);
    const body: t.Statement[] = [];
    for (let i = 0; i < statementCount; i++) {
      body.push(this.generateStatement(inner, Math.max(0, depth - 1)));
    }

    return t.forOfStatement(
      t.variableDeclaration('let', [
        t.variableDeclarator(t.identifier(loopVar)),
      ]),
      right,
      t.blockStatement(body),
    );
  }

  generateForInStatement(scope: Scope, depth: number): t.ForInStatement {
    const inner = scope.child();
    const loopVar = freshId('ki');
    inner.declare(loopVar, 'const', 'any');
    const objectLike = scope.allVisible().filter((v) =>
      v.typeHint === 'object' || v.typeHint === 'array'
    );
    const right = objectLike.length > 0
      ? t.identifier(this.pick(objectLike).name)
      : this.generateExpression(scope, 'object', Math.max(0, depth - 1));
    const statementCount = this.randint(1, 2);
    const body: t.Statement[] = [];
    for (let i = 0; i < statementCount; i++) {
      body.push(this.generateStatement(inner, Math.max(0, depth - 1)));
    }

    return t.forInStatement(
      t.variableDeclaration('let', [
        t.variableDeclarator(t.identifier(loopVar)),
      ]),
      right,
      t.blockStatement(body),
    );
  }

  generateWhileLoop(scope: Scope, depth: number): t.BlockStatement {
    const inner = scope.child();
    const index = freshId('whileIndex');
    inner.declare(index, 'const', 'number');
    const limit = this.randint(1, Math.max(1, this.config.maxLoopIterations));
    return t.blockStatement([
      t.variableDeclaration('let', [
        t.variableDeclarator(t.identifier(index), t.numericLiteral(0)),
      ]),
      t.whileStatement(
        t.binaryExpression('<', t.identifier(index), t.numericLiteral(limit)),
        t.blockStatement([
          this.generateExpressionStatement(inner, Math.max(0, depth)),
          t.expressionStatement(t.updateExpression('++', t.identifier(index), false)),
        ]),
      ),
    ]);
  }

  generateDoWhileStatement(scope: Scope, depth: number): t.BlockStatement {
    const inner = scope.child();
    const counter = freshId('doWhileIndex');
    inner.declare(counter, 'const', 'number');
    const limit = this.randint(1, Math.max(1, this.config.maxLoopIterations));
    return t.blockStatement([
      t.variableDeclaration('let', [
        t.variableDeclarator(t.identifier(counter), t.numericLiteral(0)),
      ]),
      t.doWhileStatement(
        t.binaryExpression('<', t.identifier(counter), t.numericLiteral(limit)),
        t.blockStatement([
          this.generateExpressionStatement(inner, Math.max(0, depth - 1)),
          t.expressionStatement(t.updateExpression('++', t.identifier(counter), false)),
        ]),
      ),
    ]);
  }

  generateThrowStatement(scope: Scope, depth: number): t.ThrowStatement {
    return t.throwStatement(
      t.newExpression(t.identifier('Error'), [
        this.generateExpression(scope, 'string', Math.max(0, depth - 1)),
      ]),
    );
  }

  generateSwitchStatement(scope: Scope, depth: number): t.SwitchStatement {
    const first = this.randint(-2, 2);
    let second = this.randint(-2, 2);
    if (second === first) second = first + 1;
    const makeCase = (value: number | null): t.SwitchCase => t.switchCase(
      value === null ? null : t.numericLiteral(value),
      [
        this.generateTryCatchWrapped(
          this.generateExpressionStatement(scope.child(), Math.max(0, depth)),
        ),
        t.breakStatement(),
      ],
    );
    return t.switchStatement(
      this.generateExpression(scope, 'number', Math.max(0, depth)),
      [makeCase(first), makeCase(second), makeCase(null)],
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
    // Declare in the ENCLOSING scope: function declarations hoist, and
    // registering the name only in the body scope made every generated
    // function invisible to later statements (never called, never picked as
    // a callee).
    scope.declare(name, 'var', 'function');
    const inner = scope.child();

    this.activeFunctionNames.add(name);
    let body: t.BlockStatement;
    try {
      body = t.blockStatement([
        this.generateStatement(inner, depth),
        this.generateExpressionStatement(inner, depth),
      ]);
    } finally {
      this.activeFunctionNames.delete(name);
    }

    return t.functionDeclaration(
      t.identifier(name),
      this.functionParams(),
      body,
    );
  }

  generateAsyncInvocation(scope: Scope, depth: number): t.ExpressionStatement {
    const fn = this.generateFunctionExpression(scope, true, false, depth);
    // Errors inside an async IIFE become unhandled promise rejections —
    // try/catch around the call site cannot contain them, and d8 reports
    // them as top-level failures. Attach a rejection handler instead.
    return t.expressionStatement(
      t.callExpression(
        t.memberExpression(t.callExpression(fn, []), t.identifier('catch')),
        [t.arrowFunctionExpression([], t.blockStatement([]))],
      ),
    );
  }

  generateFunctionExpression(
    scope: Scope,
    async = false,
    generator = false,
    depth: number,
  ): t.FunctionExpression {
    if (generator) {
      return this.generateGeneratorExpression(scope, depth, async);
    }

    const inner = scope.child();
    return t.functionExpression(
      null,
      this.functionParams(),
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
    // 'class' rather than 'function': classes throw when called without
    // new, so they must not be picked as plain callees.
    scope.declare(name, 'let', 'class');

    this.activeClassNames.add(name);
    let body: t.ClassBody;
    let superClass: t.Identifier | null = null;
    try {
      superClass = this.generateClassHeritage(scope);
      body = this.generateClassBody(scope, depth, superClass !== null);
    } finally {
      this.activeClassNames.delete(name);
    }

    return t.classDeclaration(t.identifier(name), superClass, body);
  }

  generateClassExpression(scope: Scope, depth: number): t.ClassExpression {
    const superClass = this.generateClassHeritage(scope);
    return t.classExpression(
      null,
      superClass,
      this.generateClassBody(scope, depth, superClass !== null),
    );
  }

  private generateClassHeritage(scope: Scope): t.Identifier | null {
    const classes = scope.allVisible().filter(
      (binding) => binding.typeHint === 'class' && !this.activeClassNames.has(binding.name),
    );
    return classes.length > 0
      ? t.identifier(this.pick(classes).name)
      : null;
  }

  private generateClassBody(scope: Scope, depth: number, derived: boolean): t.ClassBody {
    const constructorStatements: t.Statement[] = depth > 0
      ? [this.generateStatement(scope.child(), depth - 1)]
      : [];
    if (derived) {
      constructorStatements.unshift(
        t.expressionStatement(t.callExpression(t.super(), [])),
      );
    }

    return t.classBody([
      t.classMethod(
        'constructor',
        t.identifier('constructor'),
        [],
        t.blockStatement(constructorStatements),
      ),
      ...this.generateAdditionalClassMembers(),
    ]);
  }

  private generateAdditionalClassMembers(): Array<t.ClassMethod | t.ClassProperty> {
    const candidates: Array<() => t.ClassMethod | t.ClassProperty> = [
      (): t.ClassProperty => {
        const key = t.identifier(freshId('f'));
        const value = this.rand() < 0.25 ? null : this.generateClassTerminal();
        return t.classProperty(key, value);
      },
      (): t.ClassMethod => {
        const params = Array.from(
          { length: this.randint(0, 2) },
          () => t.identifier(freshId('p')),
        );
        const statementCount = this.randint(1, 2);
        const statements: t.Statement[] = [];
        for (let i = 1; i < statementCount; i++) {
          statements.push(t.expressionStatement(this.generateClassTerminal()));
        }
        statements.push(t.returnStatement(this.generateClassTerminal()));
        return t.classMethod(
          'method',
          t.identifier(freshId('m')),
          params,
          t.blockStatement(statements),
        );
      },
      (): t.ClassMethod => t.classMethod(
        'get',
        t.identifier('value'),
        [],
        t.blockStatement([t.returnStatement(this.generateClassTerminal())]),
      ),
    ];

    const members: Array<t.ClassMethod | t.ClassProperty> = [];
    const memberCount = this.randint(1, 3);
    for (let i = 0; i < memberCount; i++) {
      const candidateIndex = this.randint(0, candidates.length - 1);
      members.push(candidates.splice(candidateIndex, 1)[0]());
    }
    return members;
  }

  private generateClassTerminal(): t.Expression {
    const terminals: Array<() => t.Expression> = [
      (): t.NumericLiteral => t.numericLiteral(0),
      (): t.StringLiteral => t.stringLiteral(''),
      (): t.BooleanLiteral => t.booleanLiteral(false),
      (): t.NullLiteral => t.nullLiteral(),
    ];
    return this.pick(terminals)();
  }

  generateTypedArrayExpression(scope: Scope, depth: number): t.NewExpression {
    const constructors = [
      'Int8Array',
      'Uint8Array',
      'Int32Array',
      'Float32Array',
      'BigInt64Array',
      'Uint8ClampedArray',
      'Int16Array',
      'Uint16Array',
      'Uint32Array',
      'Float64Array',
      'BigUint64Array',
    ];
    // Bound valid lengths: an unbounded edge number here (e.g. 2**32)
    // allocates a multi-GiB array under overcommit, and a later sort/fill
    // on it burns an entire timeout. Invalid lengths (negative, fractional,
    // 2**53) remain as explicit validation edges.
    let length: t.Expression;
    const roll = this.rand();
    if (this.declaredOnlyIdents > 0) {
      length = t.numericLiteral(this.randint(0, 64));
    } else if (roll < 0.55) {
      length = t.numericLiteral(this.randint(0, 1024));
    } else if (roll < 0.75) {
      length = t.numericLiteral(this.randint(1025, 1 << 16));
    } else if (roll < 0.9) {
      length = t.numericLiteral(this.pick([-1, -100, 0.5, 2 ** 53]));
    } else {
      // Clamp expression-derived lengths before allocation. Edge numbers such
      // as 2**32 and Infinity are useful as coercion inputs but can otherwise
      // request multi-gigabyte backing stores from typed-array constructors.
      length = t.callExpression(
        t.memberExpression(t.identifier('Math'), t.identifier('min')),
        [
          t.numericLiteral(1 << 16),
          t.callExpression(
            t.memberExpression(t.identifier('Math'), t.identifier('max')),
            [t.numericLiteral(0), this.generateExpression(scope, 'number', depth)],
          ),
        ],
      );
    }
    return t.newExpression(
      t.identifier(this.pick(constructors)),
      [length],
    );
  }

  generatePromiseExpression(scope: Scope, depth: number): t.NewExpression {
    const statement = this.generateStatement(scope.child(), depth - 1);
    const settledValue = this.generateTerminalExpression(scope, 'any');
    const executor = t.arrowFunctionExpression(
      [t.identifier('resolve'), t.identifier('reject')],
      // Promise constructors turn executor throws into rejections. Keep the
      // executor itself guarded so a generated synchronous fault cannot leak
      // an unhandled rejection from an otherwise unused Promise value.
      t.blockStatement([
        this.generateTryCatchWrapped(statement),
        t.expressionStatement(
          t.callExpression(t.identifier('resolve'), [settledValue]),
        ),
        // The second settlement is intentionally ignored by the Promise
        // state machine, but still exercises the reject-call path without
        // creating a top-level unhandled rejection.
        t.expressionStatement(
          t.callExpression(t.identifier('reject'), [t.stringLiteral('ignored')]),
        ),
      ]),
    );
    return t.newExpression(t.identifier('Promise'), [executor]);
  }

  generateMapExpression(scope: Scope, depth: number): t.NewExpression {
    const entryDepth = Math.max(0, depth - 1);
    const entries = Array.from({ length: this.randint(0, 3) }, () =>
      t.arrayExpression([
        this.generateAnyExpression(scope, entryDepth),
        this.generateAnyExpression(scope, entryDepth),
      ]),
    );
    return t.newExpression(t.identifier('Map'), [t.arrayExpression(entries)]);
  }

  generateSetExpression(scope: Scope, depth: number): t.NewExpression {
    const valueDepth = Math.max(0, depth - 1);
    const values = Array.from({ length: this.randint(0, 3) }, () =>
      this.generateAnyExpression(scope, valueDepth),
    );
    return t.newExpression(t.identifier('Set'), [t.arrayExpression(values)]);
  }

  generateWeakRefExpression(scope: Scope, depth: number): t.NewExpression {
    return t.newExpression(t.identifier('WeakRef'), [
      this.generateExpression(scope, 'object', depth),
    ]);
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
    const delegate = this.rand() < 0.3;
    // `yield*` requires an iterable. Generate arrays/strings for the
    // delegate branch instead of arbitrary expressions such as RegExp or
    // Promise, which otherwise throw before the generator reaches its body.
    const value = delegate
      ? (this.rand() < 0.5
        ? this.generateExpression(scope, 'array', Math.max(0, depth))
        : this.generateStringExpression(scope, Math.max(0, depth)))
      : this.generateAnyExpression(scope, depth);
    return t.yieldExpression(value, delegate);
  }

  generateGcStatement(_scope: Scope): t.ExpressionStatement {
    this.requiredFlags.add('--expose-gc');
    return t.expressionStatement(t.callExpression(t.identifier('gc'), []));
  }

  private productionCounts: Partial<Record<ProductionKey, number>> = {};

  getProductionCounts(): Readonly<Partial<Record<ProductionKey, number>>> {
    return { ...this.productionCounts };
  }

  resetProductionCounts(): void {
    this.productionCounts = {};
  }

  /**
   * Selects an index from `weights` using a single already-drawn random
   * number r in [0, 1). With equal weights (w_i = 1, total = N) this returns
   * the smallest i with (i + 1) > r * N, i.e. i = floor(r * N) — identical to
   * randint(0, N - 1) — so the default-config output distribution is
   * unchanged.
   */
  weightedIndex(weights: number[], r: number): number {
    const total = weights.reduce((a, b) => a + b, 0);
    let acc = r * total;
    for (let i = 0; i < weights.length; i++) {
      acc -= weights[i];
      if (acc < 0) return i;
    }
    return weights.length - 1;
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

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
