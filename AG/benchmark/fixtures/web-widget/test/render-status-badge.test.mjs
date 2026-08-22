import assert from "node:assert/strict";
import test from "node:test";

import { escapeHtml, renderStatusBadge } from "../src/render-status-badge.mjs";

test("a known status renders its translated label", () => {
  const html = renderStatusBadge({ status: "done" });
  assert.match(html, /class="badge badge--done"/);
  assert.match(html, /<span class="badge__label">Done<\/span>/);
  assert.match(html, /role="status"/);
});

test("the label follows the requested locale", () => {
  assert.match(renderStatusBadge({ status: "blocked" }, "lt"), />Užblokuota</);
});

test("interpolated data cannot inject markup", () => {
  const html = renderStatusBadge({ status: "done", updatedAt: '<img src=x onerror="1">' });
  assert.ok(!html.includes("<img"), html);
  assert.match(html, /&lt;img/);
});

test("an unknown status is refused rather than rendered blank", () => {
  assert.throws(() => renderStatusBadge({ status: "archived" }), RangeError);
});

test("escapeHtml covers every character that could close an attribute or a tag", () => {
  assert.equal(escapeHtml(`<&>"'`), "&lt;&amp;&gt;&quot;&#39;");
});
