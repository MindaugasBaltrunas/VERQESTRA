import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The mobile-app half of the `verification-matrix.md` binding.
 *
 * Its gateway counterpart, `mobile-gateway/src/tests/verification-matrix-conformance.test.ts`,
 * owns every ID except the four listed in `OWNED` here and delegates those to
 * this file by name. Neither package may read the other's sources — that is
 * exactly what ARCH-02..04 assert — so the binding is split rather than shared.
 * The matrix document itself is not a source: both halves read it as text, which
 * is the only thing they share.
 *
 * This file also closes two matrix rows that had no automated check at all: the
 * secure-storage fallback rule and the accessibility annotations on the native
 * shell's controls. The rows that remain genuinely open are declared in `OPEN`
 * with the reason, and the suite refuses a matrix bullet that is in neither
 * table — an unclassified requirement is the failure mode this file exists to
 * prevent.
 *
 * NUKRYPIMAI: `process.cwd()` → modulio kelias; matrica gyvena
 * `mobile-gateway/doc/verification-matrix.md` (žr. jos „Deviations" sekciją); MVA → MVC
 * failų vardai; `screen-degraded-states.test.ts` suskaidytas į tris — įrodymai rodo į tą
 * dalį, kurioje testas iš tikrųjų yra.
 */

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../../../");
const coreSourceRoot = path.join(packageRoot, "src");
const nativeSourceRoot = path.join(packageRoot, "native", "src");
const matrixFile = path.resolve(
  packageRoot,
  "..",
  "mobile-gateway",
  "doc",
  "verification-matrix.md",
);

type Evidence = Readonly<{
  /** Path relative to this package root, so native-shell tests can be cited. */
  file: string;
  titles: readonly string[];
}>;

/** Matrix table IDs this package owns; the gateway file delegates exactly these. */
const OWNED: Readonly<Record<string, readonly Evidence[]>> = {
  "ARCH-02": [{
    file: "src/tests/mvc-boundaries.test.ts",
    titles: [
      "MVC model has no View, Controller, Adapter, React Native or transport imports",
      "the Model layer matcher recognises a real layer import, and only that",
    ],
  }],
  "ARCH-03": [{
    file: "src/tests/mvc-boundaries.test.ts",
    titles: ["View contracts import Model types only, and never a controller or an adapter"],
  }],
  "ARCH-04": [{
    file: "src/tests/mvc-boundaries.test.ts",
    titles: [
      "MVC core never imports the native shell",
      "Native shell reaches the MVC core only through its public barrel",
      "Native shell never imports the orchestrator or the mobile gateway",
    ],
  }],
  // The two halves of AUTH-03 live in the two halves of the pairing suite on
  // purpose: one proves the code never leaves a device that could not confirm
  // the host, the other proves a host that answered wrongly is discarded after
  // it did. Both are the same requirement seen from either side of the wire.
  "AUTH-03": [{
    file: "src/tests/pairing-controller.test.ts",
    titles: ["an unconfirmed or wrongly pinned host never sees the one-time code"],
  }, {
    file: "src/tests/pairing-redeem.test.ts",
    titles: ["a gateway that answers for another host is discarded, key and all"],
  }],
};

/**
 * The matrix's "React Native component and MVC tests" bullets, keyed by the
 * bullet text itself. Keys are compared against the document, so a reworded
 * requirement fails here instead of quietly keeping the old evidence.
 */
const BULLET_EVIDENCE: Readonly<Record<string, readonly Evidence[]>> = {
  "Dashboard renders `online`, `offline`, loading, empty and redacted error states.": [{
    file: "src/tests/ag-loop-presentation.test.ts",
    titles: [
      "each reconnect state reaches the Dashboard with its own label",
      "an idle AG Loop is presented as empty rather than as missing data",
      "an unwired read channel is presented as not configured, not as a network failure",
    ],
  }, {
    file: "src/tests/screen-degraded-ag-loop.test.ts",
    titles: ["every AG Loop degraded frame explains itself, dates itself and keeps a way back"],
  }],
  "Tasks are visibly read-only and expose no swipe/action mutation affordances.": [{
    file: "src/tests/ag-loop-presentation.test.ts",
    titles: [
      "the Dashboard view state carries no AG Loop mutation affordance",
      "a failed bucket read keeps the Tasks screen readable and retryable",
    ],
  }, {
    file: "src/tests/screen-degraded-ag-loop.test.ts",
    titles: ["a degraded read-only space grows no affordance it lacks when healthy"],
  }, {
    file: "native/src/tests/read-only-screens.test.ts",
    titles: ["read-only screens derive no state of their own"],
  }],
  "Terminal requires a provider selection before session creation.": [{
    file: "src/tests/model-and-presentation.test.ts",
    titles: ["terminal can start only with live connection, project and provider"],
  }, {
    file: "src/tests/terminal-presentation.test.ts",
    titles: ["both agent providers are offered and the choice is frozen once a session exists"],
  }],
  "Voice transcript is editable and requires explicit confirmation.": [{
    file: "src/tests/model-and-presentation.test.ts",
    titles: ["voice transcript always requires an explicit confirmation"],
  }, {
    file: "src/tests/voice-presentation.test.ts",
    titles: ["a reviewed transcript is editable and sendable only once every condition holds"],
  }],
  "Reconnect applies snapshot/replay once and never duplicates terminal input.": [{
    file: "src/tests/terminal-stream-client.test.ts",
    titles: [
      "client sends token in header, hello after open and acknowledges ordered output",
      "client rejects an unmarked sequence gap and reconnects with the last ack",
      "client accepts one retained-history gap only when snapshot marks truncation",
    ],
  }, {
    file: "src/tests/voice-capture-controller.test.ts",
    titles: ["a double tap on send delivers the command exactly once"],
  }],
  "Stale lease changes composer to read-only before accepting more input.": [{
    file: "src/tests/terminal-controller.test.ts",
    titles: ["an orphaned lease leaves an observable session that offers no way to write"],
  }, {
    file: "src/tests/terminal-transcript-presentation.test.ts",
    titles: ["an orphaned writer lease is presented as a read-only session, not as a lost one"],
  }],
  "Secure storage adapter never falls back to AsyncStorage for refresh secrets.": [{
    file: "src/tests/verification-matrix-mvc.test.ts",
    titles: ["no credential path can fall back to an insecure store"],
  }, {
    file: "src/tests/secure-credential-store.test.ts",
    titles: ["a field the credential does not own never reaches the keystore"],
  }],
  "Accessibility labels exist for connect, microphone, confirm, interrupt and close actions.": [{
    file: "src/tests/verification-matrix-mvc.test.ts",
    titles: ["every native shell control carries an accessibility annotation"],
  }, {
    file: "src/tests/terminal-presentation.test.ts",
    titles: ["every lifecycle action stays labelled and only closing is destructive"],
  }, {
    file: "src/tests/voice-presentation.test.ts",
    titles: ["every voice situation states a reason exactly when the control is unavailable"],
  }],
};

/**
 * Bullets with no automated evidence, and why. A reason is required: an entry
 * here is a declared hole in the verification, not a place to park a bullet.
 */
const OPEN: Readonly<Record<string, string>> = {
  "App backgrounding disconnects transport but does not send terminal close.":
    "The detach semantics are proven — the stream can be detached without a close " +
    "call — but nothing yet binds them to an OS lifecycle event, because the " +
    "React Native lifecycle adapter is not implemented. Open until that adapter " +
    "exists; covered meanwhile by the Android E2E lock/restore step.",
  "External links require an explicit OS confirmation dialog.":
    "There is no external-link surface to confirm: the native read-only screens " +
    "test forbids `Linking` and `openURL` outright. Open as soon as a screen " +
    "needs to leave the app, and vacuous until then rather than satisfied.",
};

/**
 * The requirements of one `##` section.
 *
 * A bullet is `- <requirement> — <status and evidence>`, wrapped over as many
 * lines as it needs. Continuation lines are joined, and the status clause after
 * the em dash is dropped: the requirement is the key, so restating the evidence
 * in the document cannot change what this suite is bound to, while rewording the
 * requirement itself must.
 */
function sectionBullets(markdown: string, heading: string): string[] {
  const start = markdown.indexOf(heading);
  assert.ok(start >= 0, `${matrixFile} lost its "${heading}" section`);
  const after = markdown.indexOf("\n## ", start + 1);
  const section = markdown.slice(start + heading.length, after === -1 ? markdown.length : after);
  return section
    .split(/\n(?=- )/)
    .flatMap((block) => {
      const bullet = block.trim();
      if (!bullet.startsWith("- ")) return [];
      return [(bullet.slice(2).replace(/\s+/g, " ").split(" — ")[0] as string).trim()];
    });
}

test("the bullet parser joins wrapped lines and drops the status clause", () => {
  const parsed = sectionBullets([
    "## React Native component and MVC tests",
    "",
    "Intro prose that is not a bullet.",
    "",
    "- One line bullet. — `automated`: some-file.test.ts.",
    "- A bullet that wraps",
    "  onto a second line.",
    "  — `OPEN`: because of a reason.",
    "",
    "## Next section",
    "- Not this one.",
  ].join("\n"), "## React Native component and MVC tests");
  assert.deepEqual(parsed, ["One line bullet.", "A bullet that wraps onto a second line."]);
});

async function assertEvidenceExists(label: string, evidence: readonly Evidence[]): Promise<void> {
  for (const { file, titles } of evidence) {
    const source = await readFile(path.join(packageRoot, file), "utf8");
    for (const title of titles) {
      // Matched inside a `test(` call: a title surviving only in a comment or a
      // variable name is not evidence that anything runs. `assert.ok` rather
      // than `assert.match`, which would print the whole source file.
      const declared = new RegExp(
        `test\\(\\s*[\`"'][^\`"']*${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      );
      assert.ok(declared.test(source), `${label}: ${file} no longer has a test titled "${title}"`);
    }
  }
}

test("every matrix ID this package owns is in the matrix and still has its tests", async () => {
  const markdown = await readFile(matrixFile, "utf8");
  for (const [id, evidence] of Object.entries(OWNED)) {
    assert.match(
      markdown,
      new RegExp(`^\\|\\s*${id}\\s*\\|`, "m"),
      `${id} has evidence here but is no longer a matrix row`,
    );
    await assertEvidenceExists(id, evidence);
  }
});

test("every React Native / MVC bullet is either evidenced or declared open", async () => {
  const markdown = await readFile(matrixFile, "utf8");
  const bullets = sectionBullets(markdown, "## React Native component and MVC tests");
  assert.ok(bullets.length > 0, "no bullets parsed from the React Native / MVC section");

  for (const bullet of bullets) {
    const evidenced = bullet in BULLET_EVIDENCE;
    const open = bullet in OPEN;
    assert.ok(evidenced || open, `unclassified matrix requirement: "${bullet}"`);
    assert.equal(evidenced && open, false, `"${bullet}" is both evidenced and open`);
  }
  // The other direction: evidence or an open reason for a requirement that no
  // longer exists would outlive the thing it was written for.
  for (const key of [...Object.keys(BULLET_EVIDENCE), ...Object.keys(OPEN)]) {
    assert.ok(bullets.includes(key), `no matrix bullet matches: "${key}"`);
  }
  for (const reason of Object.values(OPEN)) {
    assert.ok(reason.length > 40, "an open requirement must say why it is open");
  }

  for (const [bullet, evidence] of Object.entries(BULLET_EVIDENCE)) {
    await assertEvidenceExists(bullet, evidence);
  }
});

/* Gap-closing checks. Both discharge a matrix bullet that had no test at all. */

/**
 * Production sources of a tree. Test directories are excluded on purpose: the
 * boundary suites state the forbidden module names as regex literals, and a scan
 * that read them would report the proof as the violation.
 */
async function sourceFiles(root: string, extensions: readonly string[]): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "tests" ? [] : sourceFiles(absolute, extensions);
    }
    return entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))
      ? [absolute]
      : [];
  }))).flat();
}

/**
 * Stores that survive an app reinstall or a device backup, and therefore must
 * never hold a refresh secret. `AsyncStorage` is the one the matrix names; the
 * web storages are here because a React Native for Web target would make them
 * reachable, and a fallback added there would read as harmless.
 */
const INSECURE_STORE = /\bAsyncStorage\b|@react-native-async-storage|\b(?:local|session)Storage\b/;

test("the insecure-store matcher recognises the stores it forbids", () => {
  for (const violation of [
    'import AsyncStorage from "@react-native-async-storage/async-storage";',
    "await AsyncStorage.setItem(key, refreshToken);",
    "window.localStorage.setItem(key, refreshToken);",
    "sessionStorage.setItem(key, refreshToken);",
  ]) {
    assert.match(violation, INSECURE_STORE, violation);
  }
  for (const allowed of [
    "await keystore.setItem(key, refreshToken);",
    "const storage = new SecureCredentialStore(keychain);",
  ]) {
    assert.doesNotMatch(allowed, INSECURE_STORE, allowed);
  }
});

test("no credential path can fall back to an insecure store", async () => {
  const core = await sourceFiles(coreSourceRoot, [".ts", ".tsx"]);
  const shell = await sourceFiles(nativeSourceRoot, [".ts", ".tsx"]);
  // Guards against a vacuous scan if either tree stops resolving.
  assert.ok(core.length > 15, `only ${core.length} MVC core sources scanned`);
  assert.ok(shell.length > 5, `only ${shell.length} native shell sources scanned`);
  for (const file of [...core, ...shell]) {
    assert.doesNotMatch(await readFile(file, "utf8"), INSECURE_STORE, file);
  }
});

/**
 * Accessibility annotations on the native shell's controls.
 *
 * Asserted as a per-file count rather than per element: a JSX prop can contain
 * `>` inside an arrow function (`onPress={() => close()}`), so no regex can
 * delimit an element reliably, and a parser is not a dependency this package
 * carries. One `accessibilityRole` per `<Pressable` cannot say *which* control
 * got the annotation, but it does fail the moment an unannotated control is
 * added — which is the regression the matrix asks about.
 */
test("every native shell control carries an accessibility annotation", async () => {
  const screens = await sourceFiles(nativeSourceRoot, [".tsx"]);
  assert.ok(screens.length > 0, `no native shell components under ${nativeSourceRoot}`);
  let pressables = 0;
  for (const file of screens) {
    const source = await readFile(file, "utf8");
    const opens = source.match(/<Pressable\b/g)?.length ?? 0;
    const roles = source.match(/\baccessibilityRole\s*=/g)?.length ?? 0;
    pressables += opens;
    assert.equal(roles, opens, `${file} has ${opens} Pressable(s) and ${roles} accessibilityRole prop(s)`);

    // Text entry is annotated with a label rather than a role: a screen reader
    // needs to say what the field is for, not that it is a field.
    for (const match of source.matchAll(/<TextInput\b/g)) {
      const element = source.slice(match.index ?? 0, (match.index ?? 0) + 600);
      assert.match(element, /accessibilityLabel\s*=/, `${file}: a TextInput carries no accessibilityLabel`);
    }
  }
  // The shell really does have controls to annotate; a shell reduced to static
  // text would otherwise pass this test by having nothing to check.
  assert.ok(pressables >= 8, `only ${pressables} native controls found`);
});
