/**
 * Progress summaries.
 *
 * The three functions below were written one at a time and each re-implements
 * the same count-and-percentage walk. They agree today; the duplication is what
 * a refactor scenario is asked to remove without changing any result.
 */

/** @typedef {{ id: string, title: string, priority: string, done: boolean }} Task */

/**
 * @param {readonly Task[]} tasks
 * @returns {{ total: number, done: number, percent: number }}
 */
export function overallSummary(tasks) {
  let total = 0;
  let done = 0;
  for (const task of tasks) {
    total += 1;
    if (task.done) done += 1;
  }
  return { total, done, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/**
 * @param {readonly Task[]} tasks
 * @param {string} priority
 * @returns {{ total: number, done: number, percent: number }}
 */
export function prioritySummary(tasks, priority) {
  let total = 0;
  let done = 0;
  for (const task of tasks) {
    if (task.priority !== priority) continue;
    total += 1;
    if (task.done) done += 1;
  }
  return { total, done, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/**
 * @param {readonly Task[]} tasks
 * @param {(task: Task) => boolean} predicate
 * @returns {{ total: number, done: number, percent: number }}
 */
export function filteredSummary(tasks, predicate) {
  let total = 0;
  let done = 0;
  for (const task of tasks) {
    if (!predicate(task)) continue;
    total += 1;
    if (task.done) done += 1;
  }
  return { total, done, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}
