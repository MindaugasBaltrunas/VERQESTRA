/**
 * Priority ordering.
 *
 * KNOWN DEFECT (reproduced by `test/priority-unknown-label.test.mjs`): a label
 * this module does not recognise makes `indexOf` return `-1`, which sorts the
 * unknown task ahead of `urgent` instead of behind `low`. Ties are also left
 * unbroken, so two tasks of equal priority come out in whichever order the
 * engine's sort happened to produce.
 */

/** Most important first. */
export const PRIORITY_ORDER = ["urgent", "high", "normal", "low"];

/** @param {string} priority */
export function isKnownPriority(priority) {
  return PRIORITY_ORDER.includes(priority);
}

/**
 * @param {readonly { id: string, priority: string }[]} tasks
 * @returns {{ id: string, priority: string }[]}
 */
export function sortByPriority(tasks) {
  return [...tasks].sort(
    (left, right) => PRIORITY_ORDER.indexOf(left.priority) - PRIORITY_ORDER.indexOf(right.priority),
  );
}
