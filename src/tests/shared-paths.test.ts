import assert from "node:assert/strict";
import test from "node:test";
import {
  isPathInsideProject,
  isProjectRelativePath,
  normalizeProjectPath,
  resolveProjectPath,
  stripLeadingDotSlash,
  stripTrailingSlash,
  toComparablePosixPath,
  toPosixPath,
} from "../shared/paths.js";

test("the three normalizations are NOT synonyms: './/a' separates them", () => {
  assert.equal(toPosixPath(".\\a"), "./a");
  assert.equal(toPosixPath(".//a"), ".//a", "separators only — no ./ stripping");
  assert.equal(toComparablePosixPath(".//a"), "/a", "ONE leading ./ stripped");
  assert.equal(stripLeadingDotSlash(".//a"), "a", "ALL leading ./ repeats stripped");
  assert.equal(toComparablePosixPath("./x  "), "x", "comparable form strips ONE ./ then trims");
  assert.equal(
    toComparablePosixPath("  ./x"),
    "./x",
    "etalono keistenybe: kirpimas vyksta PRIES trim, tad priekiniai tarpai ji nugincija",
  );
});

test("stripTrailingSlash keeps the root forms intact", () => {
  assert.equal(stripTrailingSlash("a/b//"), "a/b");
  assert.equal(stripTrailingSlash("/"), "/");
  assert.equal(stripTrailingSlash("C:/"), "C:/");
});

test("normalizeProjectPath maps root and inside-root paths to repo-relative POSIX", () => {
  assert.equal(normalizeProjectPath("C:/repo", "C:\\repo\\src\\a.ts"), "src/a.ts");
  assert.equal(normalizeProjectPath("C:/repo", "c:/REPO"), "", "drive-letter paths compare case-folded");
  assert.equal(normalizeProjectPath("/repo", "./src/a.ts"), "src/a.ts");
  assert.equal(normalizeProjectPath("/repo", "/kitur/a.ts"), "/kitur/a.ts", "outside stays as-is");
});

test("isProjectRelativePath / isPathInsideProject refuse absolute and escaping paths", () => {
  assert.ok(isProjectRelativePath("src/a.ts"));
  assert.ok(!isProjectRelativePath("/abs/a.ts"));
  assert.ok(!isProjectRelativePath("C:/abs/a.ts"));
  assert.ok(isPathInsideProject("/repo", "/repo/src/a.ts"));
  assert.ok(!isPathInsideProject("/repo", "/kitur/a.ts"));
});

test("resolveProjectPath enforces presence, containment, extension and prefixes byte-stably", () => {
  const root = process.cwd();
  assert.throws(() => resolveProjectPath(root, "   "), /task file is required/);
  assert.throws(() => resolveProjectPath(root, "../out.md"), /task file escapes project root/);
  assert.throws(() => resolveProjectPath(root, "a.txt", { extension: ".md" }), /task file must be a \.md file/);
  assert.throws(
    () => resolveProjectPath(root, "kitur/x.md", { allowedPrefixes: ["tasks/queue"] }, "target directory"),
    /target directory must be inside tasks\/queue/,
  );
  const resolved = resolveProjectPath(root, "tasks/queue/x.md", { allowedPrefixes: ["tasks/queue"], extension: ".md" });
  assert.ok(resolved.endsWith("x.md"));
});
