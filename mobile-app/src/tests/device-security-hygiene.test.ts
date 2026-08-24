import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * NUKRYPIMAS (kelias ir apimtis, ne taisyklės): etalonas skaičiavo `process.cwd()`; VERQESTRA
 * workspace'e tas pats bėgimas kitame pakete tyliai perskaitytų svetimą `src` arba nieko, tad
 * šaknis imama nuo modulio. GRIEŽTINIMAS: į skenuojamų sąrašą įtrauktas
 * `adapters/push-notification-adapter.ts` — jis vienintelis adapteris, tikrinantis, ar į
 * pranešimų dėklą nepatenka tokeno formos eilutė, tad jo paties higiena yra tos pačios klasės
 * reikalas. Kontrolerių keliai `composition/` → `controller/` (MVA → MVC).
 */
const sourceRoot = path.resolve(fileURLToPath(import.meta.url), "../../../", "src");

/**
 * Whole directories, plus the individual modules that live outside them. A
 * hand-maintained file list would silently stop covering the next adapter
 * someone adds next to these, which is exactly when the scan matters.
 */
const securitySensitiveTrees = [
  "adapters/secure-storage",
  "adapters/device-identity",
  "adapters/biometrics",
  // Speech handles no token, but it handles what the operator said out loud and
  // a consent slot in the keystore: a logged transcript is the same class of
  // leak as a logged credential.
  "adapters/speech",
  "adapters/shared",
] as const;
const securitySensitiveFiles = [
  "controller/pairing-controller.ts",
  "controller/voice-capture-controller.ts",
  "adapters/push-notification-adapter.ts",
] as const;

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(absolute);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [absolute] : [];
  }))).flat();
}

/**
 * Source rules for the code that handles device secrets. They are asserted on
 * the text because the failure they prevent — a token reaching a log line, a
 * crash report or an error message — cannot be observed from behaviour alone.
 */
async function securitySensitiveSources(): Promise<string[]> {
  const scanned = [
    ...(await Promise.all(
      securitySensitiveTrees.map((tree) => sources(path.join(sourceRoot, tree))),
    )).flat(),
    ...securitySensitiveFiles.map((file) => path.join(sourceRoot, file)),
  ];
  // A tree that stops resolving would make every scan below vacuously pass.
  assert.ok(
    scanned.length >= securitySensitiveTrees.length + securitySensitiveFiles.length,
    "the secret-handling scan found fewer sources than it names",
  );
  return scanned;
}

const consolePattern = /\bconsole\s*\./;
const nodeImportPattern = new RegExp(String.raw`(?:from|require\s*\()\s*["']node:`);
const weakRandomPattern = /\bMath\s*\.\s*random\b/;
const wallClockPattern = /\bDate\s*\.\s*now\b/;
const secretInterpolationPattern =
  /\$\{[^}]*(?:accessToken|refreshToken|oneTimeCode|privateKey|proof|transcript)/;

test("the hygiene matchers recognise the very things they forbid", () => {
  // Without this the scan below could go vacuous after a harmless-looking edit
  // and would then pass on a real leak.
  assert.match("console.log(token)", consolePattern);
  assert.match('import { randomUUID } from "node:crypto";', nodeImportPattern);
  assert.match("const n = Math.random();", weakRandomPattern);
  assert.match("const t = Date.now();", wallClockPattern);
  assert.match("throw new Error(`failed for ${accessToken}`)", secretInterpolationPattern);
  assert.doesNotMatch("throw new Error(`failed for ${action}`)", secretInterpolationPattern);
});

test("secret-handling sources log nothing, import no platform module and invent no entropy", async () => {
  for (const file of await securitySensitiveSources()) {
    const relative = path.relative(sourceRoot, file);
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, consolePattern, `${relative} writes to the console`);
    // React Native has no `node:` builtins: randomness, digests and signing are
    // ports, so a `node:crypto` import here would be dead on a device.
    assert.doesNotMatch(text, nodeImportPattern, `${relative} imports a Node builtin`);
    assert.doesNotMatch(text, weakRandomPattern, `${relative} uses a non-cryptographic random`);
    // Clocks are injected so an unlock window and an expiry check stay testable
    // and cannot silently depend on device time drifting under them.
    assert.doesNotMatch(text, wallClockPattern, `${relative} reads the wall clock directly`);
    assert.doesNotMatch(text, secretInterpolationPattern, `${relative} interpolates a secret`);
  }
});

test("no secret-handling source hands key material back to its caller", async () => {
  const forbiddenSurface = /\b(?:exportPrivateKey|getPrivateKey|privateKey\s*[:(])/;
  assert.match("async getPrivateKey() {", forbiddenSurface);

  const scanned = [...await securitySensitiveSources(), path.join(sourceRoot, "model/ports.ts")];
  for (const file of scanned) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(
      text,
      forbiddenSurface,
      `${path.relative(sourceRoot, file)} exposes private key material`,
    );
  }
});
