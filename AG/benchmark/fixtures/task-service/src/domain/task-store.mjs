/**
 * Task rules over plain values. No I/O, no clock, no randomness: everything the
 * store decides is decided by its arguments.
 */

/** @typedef {{ id: string, title: string, priority: string, done: boolean }} Task */

export class TaskNotFoundError extends Error {
  /** @param {string} id */
  constructor(id) {
    super(`No task with id "${id}".`);
    this.name = "TaskNotFoundError";
    this.id = id;
  }
}

export class DuplicateTaskError extends Error {
  /** @param {string} id */
  constructor(id) {
    super(`A task with id "${id}" already exists.`);
    this.name = "DuplicateTaskError";
    this.id = id;
  }
}

/**
 * Adds a task, returning a new list. The input is never mutated so a caller
 * holding the previous list still sees the state it was given.
 *
 * @param {readonly Task[]} tasks
 * @param {Task} task
 * @returns {Task[]}
 */
export function addTask(tasks, task) {
  if (tasks.some((existing) => existing.id === task.id)) {
    throw new DuplicateTaskError(task.id);
  }
  return [...tasks, { ...task }];
}

/**
 * @param {readonly Task[]} tasks
 * @param {string} id
 * @returns {Task[]}
 */
export function completeTask(tasks, id) {
  if (!tasks.some((task) => task.id === id)) {
    throw new TaskNotFoundError(id);
  }
  return tasks.map((task) => (task.id === id ? { ...task, done: true } : task));
}

/**
 * @param {readonly Task[]} tasks
 * @param {string} id
 * @returns {Task[]}
 */
export function removeTask(tasks, id) {
  if (!tasks.some((task) => task.id === id)) {
    throw new TaskNotFoundError(id);
  }
  return tasks.filter((task) => task.id !== id);
}

/**
 * @param {readonly Task[]} tasks
 * @param {{ done?: boolean, priority?: string }} [filter]
 * @returns {Task[]}
 */
export function listTasks(tasks, filter = {}) {
  return tasks.filter((task) => {
    if (filter.done !== undefined && task.done !== filter.done) return false;
    if (filter.priority !== undefined && task.priority !== filter.priority) return false;
    return true;
  });
}
