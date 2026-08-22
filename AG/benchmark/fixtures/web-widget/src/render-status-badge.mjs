import { translate } from "./i18n.mjs";

/**
 * Renders a status badge as an HTML string. No DOM, no framework: the output is
 * compared as text, which is what makes a UI scenario checkable without a
 * browser.
 */

const STATUS_KEYS = {
  done: "status.done",
  blocked: "status.blocked",
  "in-progress": "status.inProgress",
};

/** Escapes the five characters that could turn interpolated data into markup. */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * @param {{ status: string, updatedAt?: string }} task
 * @param {string} [locale]
 * @returns {string}
 */
export function renderStatusBadge(task, locale = "en") {
  const key = STATUS_KEYS[task.status];
  if (key === undefined) throw new RangeError(`Unknown status "${task.status}".`);
  const label = translate(key, locale);
  const ariaLabel = translate("badge.ariaLabel", locale);
  const updated =
    task.updatedAt === undefined
      ? ""
      : `<span class="badge__meta">${escapeHtml(translate("badge.updated", locale, { when: task.updatedAt }))}</span>`;
  return (
    `<span class="badge badge--${escapeHtml(task.status)}" role="status" aria-label="${escapeHtml(ariaLabel)}">` +
    `<span class="badge__label">${escapeHtml(label)}</span>${updated}` +
    `</span>`
  );
}
