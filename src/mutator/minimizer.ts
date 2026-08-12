/**
 * Delta-debugging style minimizer for reconfuzz programs.
 *
 * Given a program and a predicate (e.g., runner still reproduces the crash),
 * removes top-level statements one at a time while preserving the predicate.
 * Program directives and file comments are preserved in every candidate.
 */
import * as t from '@babel/types';
import { ReconfuzzProgram } from '../generator/ast';

export type Predicate = (program: ReconfuzzProgram) => boolean | Promise<boolean>;

/**
 * Minimize a program while preserving a predicate result.
 *
 * @param options.maxPasses Optional maximum number of complete minimization
 * passes. By default, passes continue until no statement can be removed.
 */
export async function minimizeProgram(
  program: ReconfuzzProgram,
  predicate: Predicate,
  options?: { maxPasses?: number },
): Promise<ReconfuzzProgram> {
  const origProgram = program.javascript.program;
  const origFile = program.javascript;
  const buildFile = (body: t.Statement[]): t.File => t.file(
    t.program(
      body,
      origProgram.directives,
      origProgram.sourceType,
      origProgram.interpreter,
    ),
    origFile.comments,
  );

  const body = [...origProgram.body];
  let changed = true;
  let passes = 0;
  const { maxPasses } = options ?? {};

  while (changed && (maxPasses === undefined || passes < maxPasses)) {
    changed = false;
    for (let i = body.length - 1; i >= 0; i--) {
      const candidate = [...body];
      candidate.splice(i, 1);
      const candidateProgram: ReconfuzzProgram = {
        ...program,
        javascript: buildFile(candidate),
      };

      if (await predicate(candidateProgram)) {
        body.splice(i, 1);
        changed = true;
      }
    }
    passes++;
  }

  return {
    ...program,
    javascript: buildFile(body),
  };
}
