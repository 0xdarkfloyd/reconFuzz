/**
 * Builds deterministic V8 tier-up probes that gather feedback and request
 * optimization of both synthesized and, occasionally, user-declared functions.
 */
import * as t from "@babel/types";
import { Scope } from "./ast";

export interface TierUpOptions {
  maxLoopIterations: number;
}

export interface TierUpResult {
  statements: t.Statement[];
  flags: string[];
}

const ARGUMENT_POOL = [0, 1, -1, 2, 1.5, 3];

function randInt(rng: () => number, min: number, max: number): number {
  const upper = Math.max(min, max);
  return Math.floor(rng() * (upper - min + 1)) + min;
}

function pick<T>(rng: () => number, values: T[]): T {
  return values[randInt(rng, 0, values.length - 1)];
}

function bitOr(left: t.Expression, right: t.Expression): t.BinaryExpression {
  return t.binaryExpression("|", left, right);
}

function makeForLoop(limit: number, body: t.Statement[]): t.ForStatement {
  return t.forStatement(
    t.variableDeclaration("let", [
      t.variableDeclarator(t.identifier("i"), t.numericLiteral(0)),
    ]),
    t.binaryExpression("<", t.identifier("i"), t.numericLiteral(limit)),
    t.updateExpression("++", t.identifier("i"), false),
    t.blockStatement(body),
  );
}

function makeArithmeticBody(limit: number): t.BlockStatement {
  const sum = t.identifier("s");
  const index = t.identifier("i");
  const input = t.identifier("x");
  const product = t.binaryExpression("*", index, input);
  const addition = t.binaryExpression("+", sum, product);
  return t.blockStatement([
    t.variableDeclaration("let", [
      t.variableDeclarator(
        t.identifier("s"),
        bitOr(input, t.numericLiteral(0)),
      ),
    ]),
    makeForLoop(limit, [
      t.expressionStatement(
        t.assignmentExpression("=", sum, bitOr(addition, t.numericLiteral(0))),
      ),
    ]),
    t.returnStatement(sum),
  ]);
}

function makePropertyBody(limit: number): t.BlockStatement {
  const object = t.identifier("o");
  const index = t.identifier("i");
  const input = t.identifier("x");
  const propertyA = t.memberExpression(object, t.identifier("a"));
  const propertyB = t.memberExpression(object, t.identifier("b"));
  const nextA = t.binaryExpression("+", propertyA, index);
  return t.blockStatement([
    t.variableDeclaration("let", [
      t.variableDeclarator(
        object,
        t.objectExpression([
          t.objectProperty(t.identifier("a"), input),
          t.objectProperty(
            t.identifier("b"),
            t.binaryExpression("+", input, t.numericLiteral(1)),
          ),
        ]),
      ),
    ]),
    makeForLoop(limit, [
      t.expressionStatement(
        t.assignmentExpression(
          "=",
          propertyA,
          bitOr(nextA, t.numericLiteral(0)),
        ),
      ),
    ]),
    t.returnStatement(t.binaryExpression("+", propertyA, propertyB)),
  ]);
}

function makeArrayBody(limit: number): t.BlockStatement {
  const array = t.identifier("a");
  const index = t.identifier("i");
  const input = t.identifier("x");
  const element = t.memberExpression(array, index, true);
  const append = t.callExpression(
    t.memberExpression(array, t.identifier("push")),
    [bitOr(t.binaryExpression("+", element, index), t.numericLiteral(0))],
  );
  const last = t.memberExpression(
    array,
    t.binaryExpression(
      "-",
      t.memberExpression(array, t.identifier("length")),
      t.numericLiteral(1),
    ),
    true,
  );
  return t.blockStatement([
    t.variableDeclaration("let", [
      t.variableDeclarator(array, t.arrayExpression([input])),
    ]),
    makeForLoop(limit, [t.expressionStatement(append)]),
    t.returnStatement(last),
  ]);
}

function makeTypedArrayBody(limit: number): t.BlockStatement {
  const array = t.identifier("a");
  const index = t.identifier("i");
  const input = t.identifier("x");
  const offset = t.binaryExpression("&", index, t.numericLiteral(7));
  const element = t.memberExpression(array, offset, true);
  const next = t.binaryExpression(
    "+",
    t.binaryExpression("+", element, input),
    index,
  );
  return t.blockStatement([
    t.variableDeclaration("let", [
      t.variableDeclarator(
        array,
        t.newExpression(t.identifier("Int32Array"), [t.numericLiteral(8)]),
      ),
    ]),
    makeForLoop(limit, [
      t.expressionStatement(
        t.assignmentExpression("=", element, bitOr(next, t.numericLiteral(0))),
      ),
    ]),
    t.returnStatement(t.memberExpression(array, t.numericLiteral(0), true)),
  ]);
}

function makeTargetDeclaration(
  name: string,
  shape: number,
  limit: number,
): t.FunctionDeclaration {
  const body = [
    (): t.BlockStatement => makeArithmeticBody(limit),
    (): t.BlockStatement => makePropertyBody(limit),
    (): t.BlockStatement => makeArrayBody(limit),
    (): t.BlockStatement => makeTypedArrayBody(limit),
  ][shape]();
  return t.functionDeclaration(t.identifier(name), [t.identifier("x")], body);
}

function makeCall(name: string, args: t.Expression[]): t.ExpressionStatement {
  return t.expressionStatement(t.callExpression(t.identifier(name), args));
}

function makeIntrinsicCall(
  name: string,
  target: string,
): t.ExpressionStatement {
  // Babel's standard parser does not recognize V8's `%name` identifier form.
  // Direct eval still parses the native under d8's --allow-natives-syntax flag,
  // while keeping generated source valid for ordinary JavaScript tooling.
  return t.expressionStatement(
    t.callExpression(t.identifier("eval"), [
      t.stringLiteral(`${name}(${target})`),
    ]),
  );
}

function makeTierUpBlock(
  target: string,
  declaration: t.FunctionDeclaration | undefined,
  args: t.Expression[],
): t.TryStatement {
  const calls = declaration
    ? [makeCall(target, [args[0]]), makeCall(target, [args[1]])]
    : [makeCall(target, []), makeCall(target, [])];
  const trigger = declaration
    ? makeCall(target, [args[2]])
    : makeCall(target, []);
  const body: t.Statement[] = [];
  if (declaration) body.push(declaration);
  body.push(
    makeIntrinsicCall("%PrepareFunctionForOptimization", target),
    ...calls,
    makeIntrinsicCall("%OptimizeFunctionOnNextCall", target),
    trigger,
  );
  return t.tryStatement(
    t.blockStatement(body),
    t.catchClause(t.identifier("e"), t.blockStatement([])),
  );
}

export function buildTierUpHarness(
  topScope: Scope,
  rng: () => number,
  options: TierUpOptions,
): TierUpResult {
  // Only freshly-synthesized functions are tiered up. Grammar-generated user
  // functions may already have been hot-called by the statement loop and thus
  // already tiered up by V8; calling %OptimizeFunctionOnNextCall on them then
  // trips a V8 correctness DCHECK ("should be prepared for optimization before
  // %OptimizeFunctionOnNextCall") which aborts the process with SIGTRAP -- not
  // catchable by the surrounding try/catch. Synthesized targets are declared
  // here and never called before the harness, so Prepare -> warmup -> Optimize
  // -> trigger sequences them reliably.
  const synthesized: Array<{
    name: string;
    declaration: t.FunctionDeclaration;
  }> = [];
  const targetCount = randInt(rng, 1, 2);
  const loopMax = Math.max(0, Math.min(16, Math.floor(options.maxLoopIterations)));
  const loopMin = Math.min(2, loopMax);
  let nameIndex = 0;

  for (let index = 0; index < targetCount; index++) {
    let name = `tier_${nameIndex++}`;
    while (topScope.lookup(name) !== undefined) name = `tier_${nameIndex++}`;
    const shape = randInt(rng, 0, 3);
    const limit = randInt(rng, loopMin, loopMax);
    const declaration = makeTargetDeclaration(name, shape, limit);
    topScope.declare(name, "var", "function");
    synthesized.push({ name, declaration });
  }

  const statements: t.Statement[] = [];
  for (const target of synthesized) {
    const args = [
      t.numericLiteral(pick(rng, ARGUMENT_POOL)),
      t.numericLiteral(pick(rng, ARGUMENT_POOL)),
      t.numericLiteral(pick(rng, ARGUMENT_POOL)),
    ];
    statements.push(makeTierUpBlock(target.name, target.declaration, args));
  }

  return { statements, flags: ["--allow-natives-syntax"] };
}
