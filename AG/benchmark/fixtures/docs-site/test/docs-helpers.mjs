import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Shared readers for the documentation checks. Not a test file: it declares no tests. */

export const fixtureRoot = path.resolve(fileURLToPath(import.meta.url), "../..");

/** @param {string} relative */
export function read(relative) {
  return readFileSync(path.join(fixtureRoot, relative), "utf8");
}

/** @param {string} relative */
export function readJson(relative) {
  return JSON.parse(read(relative));
}

export const MARKDOWN_FILES = ["CHANGELOG.md", "docs/getting-started.md", "docs/configuration.md"];

/**
 * Rows of the settings table in `docs/configuration.md`, with the header and the
 * separator dropped.
 *
 * @returns {{ name: string, type: string, default: string, effect: string }[]}
 */
export function settingRows() {
  return read("docs/configuration.md")
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|[\s:|-]+\|$/.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length === 4 && cells[0] !== "Setting")
    .map((cells) => ({
      name: cells[0].replace(/`/g, ""),
      type: cells[1],
      default: cells[2].replace(/`/g, ""),
      effect: cells[3],
    }));
}
