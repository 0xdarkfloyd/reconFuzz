/**
 * Structure-aware mutators for Babel ASTs.
 *
 * Mutations preserve syntactic validity and are inspired by the compact,
 * dense trigger patterns in the jshitter corpus.
 */
import * as t from '@babel/types';
import traverse from '@babel/traverse';

export type AstMutator = (ast: t.File) => t.File;

export const EDGE_LITERALS = [
  t.numericLiteral(0),
  t.numericLiteral(-0),
  t.numericLiteral(NaN),
  t.numericLiteral(Infinity),
  t.numericLiteral(-Infinity),
  t.numericLiteral(0x7fffffff),
  t.numericLiteral(0x80000000),
  t.stringLiteral(''),
  t.stringLiteral('[]'),
  t.identifier('undefined'),
  t.nullLiteral(),
];

export function spliceStatements(ast: t.File): t.File {
  const clone = JSON.parse(JSON.stringify(ast)) as t.File;
  const body = clone.program.body;
  if (body.length < 2) return clone;

  const idx = Math.floor(Math.random() * body.length);
  const otherIdx = Math.floor(Math.random() * body.length);
  if (idx !== otherIdx) {
    const tmp = body[idx];
    body[idx] = body[otherIdx];
    body[otherIdx] = tmp;
  }
  return clone;
}

export function substituteOperator(ast: t.File): t.File {
  const clone = JSON.parse(JSON.stringify(ast)) as t.File;
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
    '|': '&',
    '&': '|',
    '<<': '>>',
    '>>': '>>>',
  };

  traverse(clone, {
    BinaryExpression(path) {
      const replacement = swaps[path.node.operator];
      if (replacement && Math.random() < 0.3) {
        path.node.operator = replacement as t.BinaryExpression['operator'];
        path.stop();
      }
    },
  });

  return clone;
}

export function injectEdgeLiteral(ast: t.File): t.File {
  const clone = JSON.parse(JSON.stringify(ast)) as t.File;

  traverse(clone, {
    NumericLiteral(path) {
      if (Math.random() < 0.1) {
        const replacement = EDGE_LITERALS[Math.floor(Math.random() * EDGE_LITERALS.length)];
        path.replaceWith(replacement);
        path.stop();
      }
    },
  });

  return clone;
}

export function wrapInAsync(ast: t.File): t.File {
  const body = [...ast.program.body];
  const wrapped = t.expressionStatement(
    t.callExpression(
      t.arrowFunctionExpression(
        [],
        t.blockStatement(body),
        true,
      ),
      [],
    ),
  );
  return t.file(t.program([wrapped]));
}

export function wrapInTryCatch(ast: t.File): t.File {
  const body = [...ast.program.body];
  const wrapped = t.tryStatement(
    t.blockStatement(body),
    t.catchClause(t.identifier('e'), t.blockStatement([])),
  );
  return t.file(t.program([wrapped]));
}

export const AST_MUTATORS: AstMutator[] = [
  spliceStatements,
  substituteOperator,
  injectEdgeLiteral,
  wrapInAsync,
  wrapInTryCatch,
];
