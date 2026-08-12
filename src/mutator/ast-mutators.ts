/**
 * Structure-aware mutators for Babel ASTs.
 *
 * Mutations preserve syntactic validity and are inspired by the compact,
 * dense trigger patterns in the jshitter corpus.
 */
import * as t from '@babel/types';
import traverse, { NodePath } from '@babel/traverse';
import { freshId } from '../generator/ast';

export type AstMutator = (ast: t.File, rng: () => number) => t.File;

function randomIndex(length: number, rng: () => number): number {
  const sample = rng();
  if (!Number.isFinite(sample)) {
    throw new RangeError('rng() must return a finite number');
  }
  return Math.floor(Math.min(1 - Number.EPSILON, Math.max(0, sample)) * length);
}

export const EDGE_LITERALS = [
  t.numericLiteral(0),
  t.unaryExpression('-', t.numericLiteral(0)),
  t.binaryExpression('/', t.numericLiteral(0), t.numericLiteral(0)),
  t.binaryExpression('/', t.numericLiteral(1), t.numericLiteral(0)),
  t.binaryExpression('/', t.numericLiteral(-1), t.numericLiteral(0)),
  t.numericLiteral(0x7fffffff),
  t.numericLiteral(0x80000000),
  t.stringLiteral(''),
  t.stringLiteral('[]'),
  t.identifier('undefined'),
  t.nullLiteral(),
];

const ALLOCATION_LENGTH_CONSTRUCTORS = new Set([
  'ArrayBuffer',
  'SharedArrayBuffer',
  'Uint8Array',
  'Int8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Int16Array',
  'Uint32Array',
  'Int32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
]);

/** Do not perturb loop bounds or tests: doing so can turn bounded fuzz cases
 * into infinite loops and prevent later statements from executing. */
function isLoopControlPath(path: NodePath<t.Node>): boolean {
  let current: NodePath<t.Node> | null = path;
  while (current?.parentPath) {
    const parent: NodePath<t.Node> = current.parentPath as unknown as NodePath<t.Node>;
    const key = typeof current.key === 'string' ? current.key : undefined;
    if (
      (parent.isForStatement() && (key === 'init' || key === 'test' || key === 'update')) ||
      ((parent.isWhileStatement() || parent.isDoWhileStatement()) && key === 'test')
    ) {
      return true;
    }
    current = parent;
  }
  return false;
}

function isAllocationLengthPath(path: NodePath<t.Node>): boolean {
  let current: NodePath<t.Node> | null = path;
  while (current?.parentPath) {
    const parent: NodePath<t.Node> = current.parentPath as unknown as NodePath<t.Node>;
    if (
      parent.isNewExpression() &&
      t.isIdentifier(parent.node.callee) &&
      ALLOCATION_LENGTH_CONSTRUCTORS.has(parent.node.callee.name) &&
      parent.node.arguments[0] === current.node
    ) {
      return true;
    }
    current = parent;
  }
  return false;
}

export function spliceStatements(ast: t.File, rng: () => number): t.File {
  const clone = t.cloneDeep(ast);
  const body = clone.program.body;
  const movable = body.reduce<number[]>((indexes, statement, index) => {
    // Reordering declarations can violate temporal-dead-zone and hoisting
    // dependencies. Keep statement splicing focused on side-effecting
    // expression statements, where order changes remain executable.
    if (t.isExpressionStatement(statement)) indexes.push(index);
    return indexes;
  }, []);
  if (movable.length < 2) return clone;

  const idx = movable[randomIndex(movable.length, rng)];
  const otherIdx = movable[randomIndex(movable.length, rng)];
  if (idx !== otherIdx) {
    const tmp = body[idx];
    body[idx] = body[otherIdx];
    body[otherIdx] = tmp;
  }
  return clone;
}

export function substituteOperator(ast: t.File, rng: () => number): t.File {
  const clone = t.cloneDeep(ast);
  const swaps: Record<string, string> = {
    '+': '-',
    '-': '+',
    '*': '/',
    '/': '*',
    '==': '===',
    '===': '==',
    '!=': '!==',
    '!==': '!=',
    '<': '>',
    '>': '<',
    '<=': '>=',
    '>=': '<=',
    '|': '&',
    '&': '|',
    '^': '|',
    '<<': '>>',
    '>>': '>>>',
    '>>>': '<<',
    '%': '*',
    '**': '*',
  };

  traverse(clone, {
    BinaryExpression(path) {
      if (isLoopControlPath(path)) return;
      const replacement = swaps[path.node.operator];
      if (replacement && rng() < 0.3) {
        path.node.operator = replacement as t.BinaryExpression['operator'];
        path.stop();
      }
    },
  });

  return clone;
}

export function substituteLogicalOperator(ast: t.File, rng: () => number): t.File {
  const clone = t.cloneDeep(ast);
  const swaps: Record<t.LogicalExpression['operator'], t.LogicalExpression['operator']> = {
    '&&': '||',
    '||': '??',
    '??': '&&',
  };

  traverse(clone, {
    LogicalExpression(path) {
      if (rng() < 0.3) {
        path.node.operator = swaps[path.node.operator];
        path.stop();
      }
    },
  });

  return clone;
}

export function injectEdgeLiteral(ast: t.File, rng: () => number): t.File {
  const clone = t.cloneDeep(ast);

  traverse(clone, {
    NumericLiteral(path) {
      if (isLoopControlPath(path) || isAllocationLengthPath(path)) return;
      if (rng() < 0.1) {
        const replacement = t.cloneNode(
          EDGE_LITERALS[randomIndex(EDGE_LITERALS.length, rng)],
          true,
        );
        path.replaceWith(replacement);
        path.stop();
      }
    },
  });

  return clone;
}

export function wrapInAsync(ast: t.File, _rng: () => number): t.File {
  const clone = t.cloneDeep(ast);
  const invocation = t.callExpression(
    t.arrowFunctionExpression(
      [],
      t.blockStatement(clone.program.body),
      true,
    ),
    [],
  );
  const wrapped = t.expressionStatement(
    t.callExpression(
      t.memberExpression(invocation, t.identifier('catch')),
      [t.arrowFunctionExpression([], t.blockStatement([]))],
    ),
  );
  return t.file(
    t.program(
      [wrapped],
      clone.program.directives,
      clone.program.sourceType,
      clone.program.interpreter,
    ),
  );
}

export function wrapInTryCatch(ast: t.File, _rng: () => number): t.File {
  const clone = t.cloneDeep(ast);
  const wrapped = t.tryStatement(
    t.blockStatement(clone.program.body),
    t.catchClause(t.identifier('e'), t.blockStatement([])),
  );
  return t.file(
    t.program(
      [wrapped],
      clone.program.directives,
      clone.program.sourceType,
      clone.program.interpreter,
    ),
  );
}

export function repeatInLoop(ast: t.File, rng: () => number): t.File {
  const clone = t.cloneDeep(ast);
  const usedNames = new Set<string>();
  t.traverseFast(clone, (node) => {
    if (t.isIdentifier(node)) usedNames.add(node.name);
  });
  let counter = '__mut_i';
  let suffix = 0;
  while (usedNames.has(counter)) counter = `__mut_i_${++suffix}`;

  const repetitions = 2 + randomIndex(7, rng);
  const loop = t.forStatement(
    t.variableDeclaration('let', [
      t.variableDeclarator(t.identifier(counter), t.numericLiteral(0)),
    ]),
    t.binaryExpression('<', t.identifier(counter), t.numericLiteral(repetitions)),
    t.updateExpression('++', t.identifier(counter), false),
    t.blockStatement(clone.program.body),
  );
  return t.file(
    t.program(
      [loop],
      clone.program.directives,
      clone.program.sourceType,
      clone.program.interpreter,
    ),
    clone.comments,
  );
}

function numericBoundaryExpression(value: number): t.Expression {
  let inner: t.Expression;
  if (Number.isNaN(value)) inner = t.identifier('NaN');
  else if (value === Infinity) inner = t.identifier('Infinity');
  else if (value === -Infinity) {
    inner = t.unaryExpression('-', t.identifier('Infinity'));
  } else if (Object.is(value, -0)) {
    inner = t.unaryExpression('-', t.numericLiteral(0));
  } else {
    inner = t.numericLiteral(value);
  }

  const signLeading = value < 0 || Object.is(value, -0) || value === -Infinity;
  // sign-safe: wrap so a leading '-' can't merge with an adjacent +/- / ++ / --
  return signLeading ? t.parenthesizedExpression(inner) : inner;
}

export function mutateNumericBoundaries(ast: t.File, rng: () => number): t.File {
  const clone = t.cloneDeep(ast);

  traverse(clone, {
    NumericLiteral(path) {
      if (isLoopControlPath(path) || isAllocationLengthPath(path) || rng() >= 0.25) return;

      const value = path.node.value;
      const boundaries = [
        value + 1,
        value - 1,
        -value,
        value * 2,
        value | 0,
        value + 0.5,
        0,
        -0,
        1,
        -1,
        NaN,
        Infinity,
      ];
      path.replaceWith(numericBoundaryExpression(boundaries[randomIndex(boundaries.length, rng)]));
      path.skip();
    },
  });

  return clone;
}

export function mutateStrings(ast: t.File, rng: () => number): t.File {
  const clone = t.cloneDeep(ast);

  traverse(clone, {
    StringLiteral(path) {
      if (rng() >= 0.25) return;

      const value = path.node.value;
      switch (randomIndex(6, rng)) {
        case 0:
          path.node.value = value.slice(0, 1);
          break;
        case 1:
          path.node.value = value.repeat(2 + randomIndex(3, rng));
          break;
        case 2:
          path.node.value = `${value}\u2028`;
          break;
        case 3:
          path.node.value = `${value}${''}`;
          break;
        case 4:
          path.node.value = '';
          break;
        case 5:
          if (value.toUpperCase() !== value.toLowerCase()) {
            path.node.value = value.toUpperCase();
          }
          break;
      }
    },
  });

  return clone;
}

export function mutateArrayElements(ast: t.File, rng: () => number): t.File {
  const clone = t.cloneDeep(ast);

  traverse(clone, {
    ArrayExpression(path) {
      const elements = path.node.elements;
      if (elements.length === 0 || rng() >= 0.3) return;

      switch (randomIndex(4, rng)) {
        case 0:
          if (elements.length > 1) elements.pop();
          break;
        case 1:
          if (elements.length < 16) {
            elements.splice(randomIndex(elements.length + 1, rng), 0, null);
          }
          break;
        case 2:
          if (elements.length < 16) {
            elements.unshift(t.spreadElement(t.arrayExpression([])));
          }
          break;
        case 3:
          if (elements.length < 16) {
            const first = elements[0];
            elements.push(first === null ? null : t.cloneNode(first, true));
          }
          break;
      }
    },
  });

  return clone;
}

export function mutateObjectShape(ast: t.File, rng: () => number): t.File {
  const clone = t.cloneDeep(ast);
  const usedNames = new Set<string>();
  t.traverseFast(clone, (node) => {
    if (t.isIdentifier(node)) usedNames.add(node.name);
  });

  traverse(clone, {
    ObjectExpression(path) {
      if (rng() >= 0.3) return;

      switch (randomIndex(3, rng)) {
        case 0: {
          const base = freshId('key').replace(/_\d+$/, '');
          let name = base;
          let suffix = 0;
          while (usedNames.has(name)) name = `${base}_${++suffix}`;
          usedNames.add(name);
          path.node.properties.push(
            t.objectProperty(t.identifier(name), t.numericLiteral(0)),
          );
          break;
        }
        case 1:
          path.node.properties.push(
            t.objectMethod(
              'get',
              t.identifier('value'),
              [],
              t.blockStatement([]),
            ),
          );
          break;
        case 2:
          if (path.node.properties.length >= 2) path.node.properties.pop();
          break;
      }
    },
  });

  return clone;
}

function negateTest(test: t.Expression): t.UnaryExpression {
  return t.unaryExpression('!', t.parenthesizedExpression(test), true);
}

export function negateConditions(ast: t.File, rng: () => number): t.File {
  const clone = t.cloneDeep(ast);

  traverse(clone, {
    IfStatement(path) {
      if (rng() < 0.3) path.node.test = negateTest(path.node.test);
    },
    WhileStatement(path) {
      if (rng() < 0.3) path.node.test = negateTest(path.node.test);
    },
    DoWhileStatement(path) {
      if (rng() < 0.3) path.node.test = negateTest(path.node.test);
    },
    ForStatement(path) {
      if (path.node.test && rng() < 0.3) {
        path.node.test = negateTest(path.node.test);
      }
    },
  });

  return clone;
}

const COMMUTATIVE_OPERATORS = new Set([
  '+',
  '*',
  '&',
  '|',
  '^',
  '==',
  '===',
  '!=',
  '!==',
  '&&',
  '||',
  '??',
]);

export function swapBinaryOperands(ast: t.File, rng: () => number): t.File {
  const clone = t.cloneDeep(ast);

  traverse(clone, {
    BinaryExpression(path) {
      if (!COMMUTATIVE_OPERATORS.has(path.node.operator) || rng() >= 0.25) return;
      const left = path.node.left as t.Expression;
      path.node.left = path.node.right;
      path.node.right = left;
    },
    LogicalExpression(path) {
      if (!COMMUTATIVE_OPERATORS.has(path.node.operator) || rng() >= 0.25) return;
      const left = path.node.left;
      path.node.left = path.node.right;
      path.node.right = left;
    },
  });

  return clone;
}

export function injectDeadCode(ast: t.File, rng: () => number): t.File {
  const clone = t.cloneDeep(ast);
  const usedNames = new Set<string>();
  t.traverseFast(clone, (node) => {
    if (t.isIdentifier(node)) usedNames.add(node.name);
  });

  let counter = 0;
  for (let insertion = 0; insertion < 2; insertion++) {
    let name = counter === 0 ? '__dc' : `__dc_${counter}`;
    while (usedNames.has(name)) {
      counter++;
      name = `__dc_${counter}`;
    }
    usedNames.add(name);
    counter++;

    const declaration = t.variableDeclaration('let', [
      t.variableDeclarator(t.identifier(name), t.numericLiteral(0)),
    ]);
    const index = randomIndex(clone.program.body.length + 1, rng);
    clone.program.body.splice(index, 0, declaration);
  }

  return clone;
}

/** Toggle `?.` ↔ `.` on optional member/call chains (multi-site). */
export function toggleOptionalChaining(ast: t.File, rng: () => number): t.File {
  const clone = t.cloneDeep(ast);
  traverse(clone, {
    OptionalMemberExpression(path) {
      if (rng() < 0.4) path.node.optional = !path.node.optional;
    },
    OptionalCallExpression(path) {
      if (rng() < 0.4) path.node.optional = !path.node.optional;
    },
  });
  return clone;
}

/** Toggle class-field initializers between null and a literal (multi-site). */
export function mutateClassFields(ast: t.File, rng: () => number): t.File {
  const clone = t.cloneDeep(ast);
  traverse(clone, {
    ClassProperty(path) {
      if (rng() < 0.4) {
        path.node.value =
          path.node.value === null ? t.booleanLiteral(rng() < 0.5) : null;
      }
    },
  });
  return clone;
}

/** Mutate template-literal quasi text (multi-site). */
export function mutateTemplateQuasis(ast: t.File, rng: () => number): t.File {
  const clone = t.cloneDeep(ast);
  const tags = ['x', 'aa', '', '0', 'v'];
  traverse(clone, {
    TemplateLiteral(path) {
      for (const q of path.node.quasis) {
        if (rng() < 0.3) {
          const v = tags[Math.floor(rng() * tags.length)];
          q.value = { raw: v, cooked: v };
        }
      }
    },
  });
  return clone;
}

/** Shuffle call-expression arguments (only when no spread is present). */
export function shuffleCallArgs(ast: t.File, rng: () => number): t.File {
  const clone = t.cloneDeep(ast);
  traverse(clone, {
    CallExpression(path) {
      const args = path.node.arguments;
      if (args.length > 1 && rng() < 0.3 && args.every((a) => !t.isSpreadElement(a))) {
        for (let i = args.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [args[i], args[j]] = [args[j], args[i]];
        }
      }
    },
  });
  return clone;
}

/** Swap compound-assignment operators (=, +=, -=, *=, ...). */
export function mutateAssignmentOperators(ast: t.File, rng: () => number): t.File {
  const clone = t.cloneDeep(ast);
  const ops = ['=', '+=', '-=', '*=', '/=', '%=', '**=', '|=', '&=', '^=', '<<=', '>>=', '>>>=', '&&=', '||=', '??='];
  traverse(clone, {
    AssignmentExpression(path) {
      if (rng() < 0.3) path.node.operator = ops[Math.floor(rng() * ops.length)];
    },
  });
  return clone;
}

/** Mutate RegExp literal flags. */
export function mutateRegexFlags(ast: t.File, rng: () => number): t.File {
  const clone = t.cloneDeep(ast);
  const flags = ['g', 'i', 'm', 's', 'u', 'y', 'd', ''];
  traverse(clone, {
    RegExpLiteral(path) {
      if (rng() < 0.4) {
        const f = flags[Math.floor(rng() * flags.length)];
        path.node.flags = f;
        path.node.extra = undefined;
      }
    },
  });
  return clone;
}

export const AST_MUTATORS: AstMutator[] = [
  spliceStatements,
  substituteOperator,
  substituteLogicalOperator,
  injectEdgeLiteral,
  wrapInAsync,
  wrapInTryCatch,
  repeatInLoop,
  mutateNumericBoundaries,
  mutateStrings,
  mutateArrayElements,
  mutateObjectShape,
  negateConditions,
  swapBinaryOperands,
  injectDeadCode,
  toggleOptionalChaining,
  mutateClassFields,
  mutateTemplateQuasis,
  shuffleCallArgs,
  mutateAssignmentOperators,
  mutateRegexFlags,
];
