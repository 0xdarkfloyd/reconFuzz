/**
 * Garbage-collector stress templates derived from big_sleep and
 * lokihardt_jshitter POC patterns.
 *
 * V8's GC is a generational, incremental, concurrent marker with a
 * moving young generation and a mostly-non-compacting old generation.
 * Bugs typically surface when:
 *
 *   1. An object is promoted while a weak handle or external pointer is
 *      still observed by C++ code (UAF / stale handle).
 *   2. A GC runs during a delicate compilation or wasm instantiation phase.
 *   3. Detached ArrayBuffers / transferred SABs are accessed after collection.
 *   4. WeakMap / WeakSet / FinalizationRegistry entries are collected at
 *      unexpected times, exposing missing write barriers.
 *
 * The templates below recreate these conditions in a controlled, randomized
 * way so the fuzzer can explore the same state space as the historical POCs.
 */
import * as t from '@babel/types';
import { ReconfuzzProgram } from './ast';

export interface GcTemplate {
  name: string;
  build(): ReconfuzzProgram;
}

function gcCall(): t.ExpressionStatement {
  return t.expressionStatement(t.callExpression(t.identifier('gc'), []));
}

function loop(body: t.Statement[], count = 100): t.ForStatement {
  const i = '__i';
  return t.forStatement(
    t.variableDeclaration('let', [t.variableDeclarator(t.identifier(i), t.numericLiteral(0))]),
    t.binaryExpression('<', t.identifier(i), t.numericLiteral(count)),
    t.updateExpression('++', t.identifier(i), false),
    t.blockStatement(body),
  );
}

/**
 * Template: trigger GC while Wasm instances are being created and torn down.
 * Based on big_sleep patterns that crash during wasm code GC.
 */
export class WasmInstanceGcTemplate implements GcTemplate {
  readonly name = 'wasm-instance-gc';

  build(): ReconfuzzProgram {
    const body: t.Statement[] = [
      t.variableDeclaration('const', [
        t.variableDeclarator(
          t.identifier('bytes'),
          t.newExpression(t.identifier('Uint8Array'), [
            t.arrayExpression([
              t.numericLiteral(0),
              t.numericLiteral(0x61),
              t.numericLiteral(0x73),
              t.numericLiteral(0x6d),
              t.numericLiteral(1),
              t.numericLiteral(0),
              t.numericLiteral(0),
              t.numericLiteral(0),
            ]),
          ]),
        ),
      ]),
      loop(
        [
          t.variableDeclaration('const', [
            t.variableDeclarator(
              t.identifier('module'),
              t.newExpression(
                t.memberExpression(t.identifier('WebAssembly'), t.identifier('Module')),
                [t.identifier('bytes')],
              ),
            ),
          ]),
          t.tryStatement(
            t.blockStatement([
              t.variableDeclaration('const', [
                t.variableDeclarator(
                  t.identifier('instance'),
                  t.newExpression(
                    t.memberExpression(t.identifier('WebAssembly'), t.identifier('Instance')),
                    [t.identifier('module'), t.objectExpression([])],
                  ),
                ),
              ]),
              t.expressionStatement(t.memberExpression(t.identifier('instance'), t.identifier('exports'))),
            ]),
            t.catchClause(t.identifier('e'), t.blockStatement([])),
          ),
          t.expressionStatement(
            t.conditionalExpression(
              t.binaryExpression('===', t.binaryExpression('%', t.identifier('__i'), t.numericLiteral(10)), t.numericLiteral(0)),
              t.callExpression(t.identifier('gc'), []),
              t.unaryExpression('void', t.numericLiteral(0)),
            ),
          ),
        ],
        50,
      ),
    ];

    return {
      javascript: t.file(t.program(body)),
      wasm: [],
      flags: ['--allow-natives-syntax', '--expose-gc'],
      includes: [],
    };
  }
}

/**
 * Template: detach ArrayBuffers and force GC to stress external pointer
 * tracking and detached-buffer checks.
 */
export class ArrayBufferDetachGcTemplate implements GcTemplate {
  readonly name = 'arraybuffer-detach-gc';

  build(): ReconfuzzProgram {
    const body: t.Statement[] = [
      t.functionDeclaration(
        t.identifier('stress'),
        [],
        t.blockStatement([
          t.variableDeclaration('const', [
            t.variableDeclarator(
              t.identifier('ab'),
              t.newExpression(t.identifier('ArrayBuffer'), [t.numericLiteral(1024)]),
            ),
          ]),
          t.variableDeclaration('const', [
            t.variableDeclarator(
              t.identifier('view'),
              t.newExpression(t.identifier('DataView'), [t.identifier('ab')]),
            ),
          ]),
          t.expressionStatement(
            t.callExpression(t.identifier('%ArrayBufferDetach'), [t.identifier('ab')]),
          ),
          t.tryStatement(
            t.blockStatement([
              t.expressionStatement(
                t.callExpression(t.memberExpression(t.identifier('view'), t.identifier('getUint8')), [
                  t.numericLiteral(0),
                ]),
              ),
            ]),
            t.catchClause(t.identifier('e'), t.blockStatement([])),
          ),
          gcCall(),
        ]),
      ),
      loop([t.expressionStatement(t.callExpression(t.identifier('stress'), []))], 20),
    ];

    return {
      javascript: t.file(t.program(body)),
      wasm: [],
      flags: ['--allow-natives-syntax', '--expose-gc'],
      includes: [],
    };
  }
}

/**
 * Template: WeakMap / WeakSet churn with circular references to stress
 * write barriers and weak handle processing.
 */
export class WeakCollectionGcTemplate implements GcTemplate {
  readonly name = 'weak-collection-gc';

  build(): ReconfuzzProgram {
    const body: t.Statement[] = [
      t.variableDeclaration('const', [
        t.variableDeclarator(t.identifier('wm'), t.newExpression(t.identifier('WeakMap'), [])),
      ]),
      t.variableDeclaration('const', [
        t.variableDeclarator(t.identifier('ws'), t.newExpression(t.identifier('WeakSet'), [])),
      ]),
      t.functionDeclaration(
        t.identifier('makeGraph'),
        [t.identifier('depth')],
        t.blockStatement([
          t.variableDeclaration('const', [
            t.variableDeclarator(t.identifier('obj'), t.objectExpression([])),
          ]),
          t.ifStatement(
            t.binaryExpression('>', t.identifier('depth'), t.numericLiteral(0)),
            t.blockStatement([
              t.expressionStatement(
                t.assignmentExpression(
                  '=',
                  t.memberExpression(t.identifier('obj'), t.identifier('child')),
                  t.callExpression(t.identifier('makeGraph'), [
                    t.binaryExpression('-', t.identifier('depth'), t.numericLiteral(1)),
                  ]),
                ),
              ),
            ]),
            null,
          ),
          t.returnStatement(t.identifier('obj')),
        ]),
      ),
      loop(
        [
          t.variableDeclaration('let', [
            t.variableDeclarator(
              t.identifier('root'),
              t.callExpression(t.identifier('makeGraph'), [t.numericLiteral(5)]),
            ),
          ]),
          t.expressionStatement(
            t.callExpression(t.memberExpression(t.identifier('wm'), t.identifier('set')), [
              t.identifier('root'),
              t.objectExpression([t.objectProperty(t.identifier('index'), t.identifier('__i'))]),
            ]),
          ),
          t.expressionStatement(
            t.callExpression(t.memberExpression(t.identifier('ws'), t.identifier('add')), [
              t.memberExpression(t.identifier('root'), t.identifier('child')),
            ]),
          ),
          t.expressionStatement(
            t.assignmentExpression(
              '=',
              t.identifier('root'),
              t.nullLiteral(),
            ),
          ),
          t.expressionStatement(
            t.conditionalExpression(
              t.binaryExpression('===', t.binaryExpression('%', t.identifier('__i'), t.numericLiteral(7)), t.numericLiteral(0)),
              t.callExpression(t.identifier('gc'), []),
              t.unaryExpression('void', t.numericLiteral(0)),
            ),
          ),
        ],
        30,
      ),
    ];

    return {
      javascript: t.file(t.program(body)),
      wasm: [],
      flags: ['--expose-gc'],
      includes: [],
    };
  }
}

/**
 * Template: FinalizationRegistry with unregister tokens and resurrection
 * risks. Targets GC bugs in weak callback dispatch.
 */
export class FinalizationRegistryGcTemplate implements GcTemplate {
  readonly name = 'finalization-registry-gc';

  build(): ReconfuzzProgram {
    const body: t.Statement[] = [
      t.variableDeclaration('const', [
        t.variableDeclarator(
          t.identifier('registry'),
          t.newExpression(t.identifier('FinalizationRegistry'), [
            t.arrowFunctionExpression(
              [t.identifier('heldValue')],
              t.blockStatement([
                t.expressionStatement(
                  t.callExpression(t.identifier('gc'), []),
                ),
              ]),
            ),
          ]),
        ),
      ]),
      loop(
        [
          t.variableDeclaration('let', [
            t.variableDeclarator(
              t.identifier('target'),
              t.objectExpression([t.objectProperty(t.identifier('i'), t.identifier('__i'))]),
            ),
          ]),
          t.variableDeclaration('const', [
            t.variableDeclarator(t.identifier('token'), t.objectExpression([])),
          ]),
          t.expressionStatement(
            t.callExpression(t.memberExpression(t.identifier('registry'), t.identifier('register')), [
              t.identifier('target'),
              t.identifier('__i'),
              t.identifier('token'),
            ]),
          ),
          t.ifStatement(
            t.binaryExpression('===', t.binaryExpression('%', t.identifier('__i'), t.numericLiteral(3)), t.numericLiteral(0)),
            t.blockStatement([
              t.expressionStatement(
                t.callExpression(t.memberExpression(t.identifier('registry'), t.identifier('unregister')), [
                  t.identifier('token'),
                ]),
              ),
            ]),
            null,
          ),
          t.expressionStatement(
            t.assignmentExpression('=', t.identifier('target'), t.nullLiteral()),
          ),
          t.expressionStatement(
            t.conditionalExpression(
              t.binaryExpression('===', t.binaryExpression('%', t.identifier('__i'), t.numericLiteral(5)), t.numericLiteral(0)),
              t.callExpression(t.identifier('gc'), []),
              t.unaryExpression('void', t.numericLiteral(0)),
            ),
          ),
        ],
        40,
      ),
    ];

    return {
      javascript: t.file(t.program(body)),
      wasm: [],
      flags: ['--expose-gc'],
      includes: [],
    };
  }
}

/**
 * Template: SharedArrayBuffer + Atomics with forced GC between wait/notify,
 * recreating big_sleep issue 490058871.
 */
export class SharedArrayBufferGcTemplate implements GcTemplate {
  readonly name = 'sharedarraybuffer-gc';

  build(): ReconfuzzProgram {
    const body: t.Statement[] = [
      t.functionDeclaration(
        t.identifier('test'),
        [],
        t.blockStatement([
          t.variableDeclaration('const', [
            t.variableDeclarator(
              t.identifier('sab'),
              t.newExpression(t.identifier('SharedArrayBuffer'), [t.numericLiteral(1024)]),
            ),
          ]),
          t.variableDeclaration('const', [
            t.variableDeclarator(
              t.identifier('i32'),
              t.newExpression(t.identifier('Int32Array'), [t.identifier('sab')]),
            ),
          ]),
          t.tryStatement(
            t.blockStatement([
              t.expressionStatement(
                t.callExpression(t.memberExpression(t.identifier('Atomics'), t.identifier('waitAsync')), [
                  t.identifier('i32'),
                  t.numericLiteral(0),
                  t.numericLiteral(0),
                ]),
              ),
            ]),
            t.catchClause(t.identifier('e'), t.blockStatement([])),
          ),
          gcCall(),
          t.variableDeclaration('const', [
            t.variableDeclarator(
              t.identifier('sab2'),
              t.newExpression(t.identifier('SharedArrayBuffer'), [t.numericLiteral(1024)]),
            ),
          ]),
          t.variableDeclaration('const', [
            t.variableDeclarator(
              t.identifier('i32_2'),
              t.newExpression(t.identifier('Int32Array'), [t.identifier('sab2')]),
            ),
          ]),
          t.tryStatement(
            t.blockStatement([
              t.expressionStatement(
                t.callExpression(t.memberExpression(t.identifier('Atomics'), t.identifier('notify')), [
                  t.identifier('i32_2'),
                  t.numericLiteral(0),
                  t.numericLiteral(1),
                ]),
              ),
            ]),
            t.catchClause(t.identifier('e'), t.blockStatement([])),
          ),
        ]),
      ),
      loop([t.expressionStatement(t.callExpression(t.identifier('test'), []))], 10),
    ];

    return {
      javascript: t.file(t.program(body)),
      wasm: [],
      flags: ['--expose-gc'],
      includes: [],
    };
  }
}

export const GC_TEMPLATES: GcTemplate[] = [
  new WasmInstanceGcTemplate(),
  new ArrayBufferDetachGcTemplate(),
  new WeakCollectionGcTemplate(),
  new FinalizationRegistryGcTemplate(),
  new SharedArrayBufferGcTemplate(),
];
