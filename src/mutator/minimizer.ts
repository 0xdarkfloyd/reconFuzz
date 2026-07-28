/**
 * Delta-debugging style minimizer for reconfuzz programs.
 *
 * Given a program and a predicate (e.g., runner still reproduces the crash),
 * removes top-level statements one at a time while preserving the predicate.
 */
import * as t from '@babel/types';
import { ReconfuzzProgram } from '../generator/ast';

export type Predicate = (program: ReconfuzzProgram) => boolean | Promise<boolean>;

export async function minimizeProgram(
  program: ReconfuzzProgram,
  predicate: Predicate,
): Promise<ReconfuzzProgram> {
  const body = [...program.javascript.program.body];
  let changed = true;

  while (changed) {
    changed = false;
    for (let i = body.length - 1; i >= 0; i--) {
      const candidate = [...body];
      candidate.splice(i, 1);
      const candidateProgram: ReconfuzzProgram = {
        ...program,
        javascript: t.file(t.program(candidate)),
      };

      if (await predicate(candidateProgram)) {
        body.splice(i, 1);
        changed = true;
      }
    }
  }

  return {
    ...program,
    javascript: t.file(t.program(body)),
  };
}
