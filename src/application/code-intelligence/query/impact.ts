// Failo lygio impact analizė. Behaviour etalon: AG_loop code-index/impact.ts.

import { selectSemanticCodeContext } from "./semantic-context.js";
import type { CodeIndexData } from "../indexing/types.js";

export type ImpactAnalysis = {
  targets: string[];
  related_files: string[];
  impacted_tests: string[];
  notes: string[];
};

/**
 * File-level impact of a change to `targets`: the graph neighbourhood and the tests that
 * cover it, without symbol detail.
 *
 * Task 1106: this is now a projection of `selectSemanticCodeContext` (`maxSymbols: 0`
 * skips symbol selection entirely) so the file-level and symbol-level views can never
 * disagree about what the graph says — there is one traversal, one set of notes.
 */
export function analyzeImpact(data: CodeIndexData, targets: string[]): ImpactAnalysis {
  const context = selectSemanticCodeContext(data, targets, { maxSymbols: 0 });
  return {
    targets,
    related_files: context.related_files,
    impacted_tests: context.impacted_tests,
    notes: context.notes,
  };
}
