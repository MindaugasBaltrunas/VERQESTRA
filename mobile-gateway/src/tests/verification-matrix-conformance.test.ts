import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Binds `doc/verification-matrix.md` to the tests that discharge it.
 *
 * The matrix is a checklist, and a checklist in Markdown rots in one direction
 * only: a row keeps claiming coverage after the test that produced it was
 * renamed, moved or deleted. This suite makes the claim executable — every ID in
 * the matrix must name evidence, every piece of evidence must be a test title
 * that still exists in the file it names, and every ID this package does not own
 * must be listed as delegated to the one that does.
 *
 * The mirror of this file is `mobile-app/src/tests/verification-matrix-mvc.test.ts`,
 * which owns exactly the IDs delegated here. Together they are bidirectional; a
 * single file could not be, because neither package may reach into the other's
 * sources — that is the very boundary ARCH-02..04 assert.
 *
 * NUKRYPIMAI nuo etalono (visi užrašyti ir pačioje matricoje):
 *  - matrica gyvena pakete (`mobile-gateway/doc/`), o ne etalono keitimo aplanke;
 *  - keliai skaičiuojami nuo modulio, ne nuo `process.cwd()` — kitame workspace pakete
 *    paleistas bėgimas kitaip tyliai perskaitytų svetimą failą arba nieko;
 *  - `OWNED` įrašai rodo VERQESTRA failus: 500 eilučių vartas suskaldė dalį etalono rinkinių,
 *    ir būtent ši patikra įrodo, kad įraše užrašytas vardas vis dar teisingas;
 *  - GRIEŽTINIMAS: etalone `DELEGATED` buvo vien eilutės, kurių niekas netikrino. Čia jos
 *    virsta reikalavimu, kai tik `mobile-app` įgyja šaltinius.
 */

const packageRoot = resolve(fileURLToPath(import.meta.url), "../../../");
const workspaceRoot = resolve(packageRoot, "..");
const matrixFile = join(packageRoot, "doc", "verification-matrix.md");
const testRoot = join(packageRoot, "src", "tests");

type Evidence = Readonly<{
  /** Test file under this package's `src/tests`, and the titles it must carry. */
  file: string;
  titles: readonly string[];
}>;

/**
 * IDs owned by the gateway package. Each entry names test titles verbatim: a
 * renamed test breaks the binding loudly instead of leaving the matrix lying.
 */
const OWNED: Readonly<Record<string, readonly Evidence[]>> = {
  "ARCH-01": [{
    file: "architecture-boundaries.test.ts",
    titles: [
      "mobile gateway never imports orchestrator internals",
      "gateway core holds no reference to an orchestrator module",
      "gateway core has no AG Loop process-control implementation",
    ],
  }],
  "ARCH-05": [{
    file: "architecture-boundaries.test.ts",
    titles: ["the AG Loop UI adapter reads and never mutates"],
  }, {
    file: "ag-loop-read-routes.test.ts",
    titles: ["no AG Loop UI path answers a mutation verb"],
  }],
  "ARCH-06": [{
    file: "api-contract-conformance.test.ts",
    titles: [
      "the contract exposes no AG Loop process-control or branch-integration route",
      "the declared route surface matches the routes the router actually serves",
    ],
  }, {
    file: "remote-integration-surface.test.ts",
    titles: [
      "the remote request path never reaches the local integration flow",
      "only the local integration files name a Git integration verb",
    ],
  }],
  "ARCH-07": [{
    file: "architecture-boundaries.test.ts",
    titles: ["the direct agent terminal port can only start a gateway-owned session"],
  }, {
    file: "terminal-supervisor.test.ts",
    titles: ["supervisor owns one isolated, idempotent and lease-fenced terminal session"],
  }],

  "PTY-01": [{
    file: "agent-provider-connection.test.ts",
    titles: [
      "both providers are listed, and a missing installation is not an error",
      "a signed-out provider asks for authentication and still reports its version",
    ],
  }],
  "PTY-02": [{
    file: "agent-provider-connection.test.ts",
    titles: [
      "an absent provider is never asked for its sign-in state",
      "one provider's failure never hides the other",
    ],
  }],
  "PTY-03": [{
    file: "node-pty-direct-agent-terminal-adapter.test.ts",
    titles: ["PTY uses a fixed executable, empty args and the supplied isolated cwd"],
  }],
  "PTY-04": [{
    file: "terminal-supervisor.test.ts",
    titles: ["supervisor owns one isolated, idempotent and lease-fenced terminal session"],
  }],
  "PTY-05": [{
    file: "terminal-supervisor.test.ts",
    titles: ["supervisor owns one isolated, idempotent and lease-fenced terminal session"],
  }],
  "PTY-06": [{
    file: "node-pty-direct-agent-terminal-adapter.test.ts",
    titles: ["adapter rejects arbitrary cwd, invalid dimensions and duplicate live session ids"],
  }],
  "PTY-07": [{
    file: "node-pty-direct-agent-terminal-adapter.test.ts",
    titles: ["signals nothing outside its own PTY"],
  }, {
    file: "terminal-supervisor-noninterference.test.ts",
    titles: ["signals nothing and writes to no foreign stdin"],
  }],
  "PTY-08": [{
    file: "terminal-supervisor-noninterference.test.ts",
    titles: [
      "signals nothing and writes to no foreign stdin",
      "force-close terminates only the gateway-spawned PTY and frees the host",
    ],
  }],
  "PTY-09": [{
    file: "fake-provider-contract.test.ts",
    titles: ["a client disconnect leaves the provider live and replay continues"],
  }],
  "PTY-10": [{
    file: "terminal-output.test.ts",
    titles: ["an output flood at production limits stays byte- and event-bounded"],
  }, {
    file: "terminal-stream-service.test.ts",
    titles: ["stream closes when the transport buffer exceeds its byte budget"],
  }],
  "PTY-11": [{
    file: "terminal-output.test.ts",
    titles: [
      "streaming sanitizer removes ANSI, OSC clipboard, titles and hyperlinks",
      "splitting a secret at any chunk boundary never leaks it",
    ],
  }],
  "PTY-12": [{
    file: "fake-provider-contract.test.ts",
    titles: ["a provider exit is normalized once and frees the host"],
  }, {
    file: "audit-chain.test.ts",
    titles: ["editing, deleting or reordering a record breaks the chain at that point"],
  }],
  "PTY-13": [{
    file: "session-reconciliation.test.ts",
    titles: [
      "an exactly matching process is reattached and its pre-restart lease is still revoked",
      "any single mismatch keeps the session orphaned",
    ],
  }],
  "PTY-14": [{
    file: "terminal-supervisor.test.ts",
    titles: [
      "supervisor owns one isolated, idempotent and lease-fenced terminal session",
      "failed terminal start clears the global active-session reservation",
    ],
  }],

  "AGREAD-01": [{
    file: "ag-loop-read-routes.test.ts",
    titles: [
      "an unreachable AG Loop UI is reported as offline without upstream detail",
      "an unconfigured AG Loop UI is offline rather than a missing route",
    ],
  }],
  "AGREAD-02": [{
    file: "ag-loop-ui-http-adapter.test.ts",
    titles: ["adapter bootstraps an in-memory token and refreshes once after 403"],
  }],
  "AGREAD-03": [{
    file: "ag-loop-ui-http-adapter.test.ts",
    titles: ["adapter bootstraps an in-memory token and refreshes once after 403"],
  }],
  "AGREAD-04": [{
    file: "ag-loop-ui-http-adapter.test.ts",
    titles: [
      "a redirected AG Loop UI is refused, and the adapter never leaves the loopback origin",
      "a redirected API read is refused after a successful bootstrap",
    ],
  }],
  "AGREAD-05": [{
    file: "ag-loop-ui-http-adapter.test.ts",
    titles: ["dashboard projection drops mutation metadata, paths and raw logs"],
  }, {
    file: "ag-loop-read-models.test.ts",
    titles: ["policy controls projection drops route, source, editable and pending proposals"],
  }],
  "AGREAD-06": [{
    file: "ag-loop-read-models.test.ts",
    titles: ["redaction hides host account names in every absolute-path form"],
  }, {
    file: "ag-loop-ui-adapter-reads.test.ts",
    titles: ["task bucket projection keeps names only, never the host location they live at"],
  }],
  "AGREAD-07": [{
    file: "ag-loop-read-models.test.ts",
    titles: [
      "redaction removes secrets, host paths and terminal control sequences",
      "log projection redacts, bounds the line count and bounds each line",
    ],
  }],
  "AGREAD-08": [{
    file: "ag-loop-read-models.test.ts",
    titles: ["activity projection redacts the command fragment the upstream parser embeds"],
  }, {
    file: "ag-loop-stream-transport.test.ts",
    titles: ["upstream text cannot forge SSE frames the phone would read as events"],
  }],
  "AGREAD-09": [{
    file: "ag-loop-stream-transport.test.ts",
    titles: ["no AG Loop UI mutation survives the transport, and none reaches the upstream"],
  }, {
    file: "ag-loop-ui-adapter-reads.test.ts",
    titles: ["every extended read is a GET against an allowlisted AG UI path"],
  }],
  "AGREAD-10": [{
    file: "ag-loop-ui-http-adapter.test.ts",
    titles: ["adapter rejects non-loopback origins and invalid task buckets"],
  }, {
    file: "ag-loop-ui-adapter-reads.test.ts",
    titles: ["an unknown log name never becomes an upstream request"],
  }],

  "AUTH-01": [{
    file: "device-auth.test.ts",
    titles: ["pairing stores only hashes, verifies Ed25519 and consumes once"],
  }, {
    file: "remote-gateway-router.test.ts",
    titles: ["router redeems pairing, refreshes tokens and returns contract-shaped responses"],
  }],
  "AUTH-02": [{
    file: "device-auth.test.ts",
    titles: ["pairing stores only hashes, verifies Ed25519 and consumes once"],
  }],
  "AUTH-04": [{
    file: "device-auth.test.ts",
    titles: ["invalid device proof does not consume a pairing challenge"],
  }],
  "AUTH-05": [{
    file: "device-auth.test.ts",
    titles: ["refresh rotation and reuse revocation invalidate prior access"],
  }],
  "AUTH-06": [{
    file: "device-auth.test.ts",
    titles: ["refresh rotation and reuse revocation invalidate prior access"],
  }],
  "AUTH-07": [{
    file: "device-auth.test.ts",
    titles: ["device revocation survives restart and invalidates credentials"],
  }, {
    file: "local-force-close-and-revoke.test.ts",
    titles: ["revoking a device fences its leases and disconnects its streams without touching the repository"],
  }],
  "AUTH-08": [{
    file: "remote-gateway-terminal-routes.test.ts",
    titles: ["terminal routes enforce device scope, control membership, leases and mutation idempotency"],
  }],
  "AUTH-09": [{
    file: "device-auth.test.ts",
    titles: ["access tokens reject expiry and tampering"],
  }],
  "AUTH-10": [{
    file: "remote-gateway-router.test.ts",
    titles: ["protected project and AG UI reads require scope and enforce project membership"],
  }, {
    file: "ag-loop-read-routes.test.ts",
    titles: ["every AG Loop UI read is invisible for a project the principal cannot see"],
  }],

  "GIT-01": [{
    file: "terminal-supervisor.test.ts",
    titles: ["supervisor owns one isolated, idempotent and lease-fenced terminal session"],
  }, {
    file: "project-and-worktree.test.ts",
    titles: ["worktree service constructs fixed git arguments under the session root"],
  }],
  "GIT-02": [{
    file: "terminal-supervisor.test.ts",
    titles: ["supervisor owns one isolated, idempotent and lease-fenced terminal session"],
  }, {
    file: "local-control-isolation.test.ts",
    titles: ["the local Git allowlist refuses every destructive vector"],
  }, {
    file: "session-gates.test.ts",
    titles: ["a recorded worktree outside the session root never becomes a working directory"],
  }],
  "GIT-03": [{
    file: "local-integration-flow.test.ts",
    titles: ["a dirty target refuses the integration"],
  }, {
    file: "session-gates.test.ts",
    titles: ["uncommitted work is refused before a gate runs, not tested and left behind"],
  }],
  "GIT-04": [{
    file: "local-integration-flow.test.ts",
    titles: [
      "repository state that moved after the preview is a conflict, not a merge",
      "a target that moved after the approval was journalled is refused before the merge",
    ],
  }],
  "GIT-05": [{
    file: "local-integration-flow.test.ts",
    titles: ["missing or failed gates refuse the integration"],
  }, {
    file: "worktree-lifecycle.test.ts",
    titles: ["integration is local-only and a failure returns to review_ready"],
  }],
  "GIT-06": [{
    file: "local-integration-merge.test.ts",
    titles: ["a conflicted merge is aborted, leaves HEAD alone and retains the worktree"],
  }],
  "GIT-07": [{
    file: "remote-integration-surface.test.ts",
    titles: ["the remote request path never reaches the local integration flow"],
  }, {
    file: "terminal-websocket-gateway.test.ts",
    titles: ["an integration intent is refused before and after hello"],
  }, {
    file: "local-control-isolation.test.ts",
    titles: ["the remote router answers 404 for every local path"],
  }],
  "GIT-08": [{
    file: "worktree-lifecycle.test.ts",
    titles: [
      "a failed git worktree add quarantines the journalled allocation",
      "an allocation interrupted by a restart is quarantined, never reused",
    ],
  }],
  "GIT-09": [{
    file: "worktree-lifecycle.test.ts",
    titles: ["cleanup refuses remote callers, unexported changes and unconfirmed requests"],
  }],
  "GIT-10": [{
    file: "local-force-close-and-revoke.test.ts",
    titles: ["a verified force close ends the session, fences the lease and keeps the worktree"],
  }, {
    file: "terminal-supervisor-noninterference.test.ts",
    titles: ["force-close terminates only the gateway-spawned PTY and frees the host"],
  }],
};

/**
 * IDs the mobile app owns. Listed here so that `OWNED ∪ DELEGATED` can be
 * compared against the matrix: without the list, a new gateway row could be
 * dropped simply by never adding it.
 */
const DELEGATED: Readonly<Record<string, string>> = {
  "ARCH-02": "mobile-app/src/tests/verification-matrix-mvc.test.ts",
  "ARCH-03": "mobile-app/src/tests/verification-matrix-mvc.test.ts",
  "ARCH-04": "mobile-app/src/tests/verification-matrix-mvc.test.ts",
  "AUTH-03": "mobile-app/src/tests/verification-matrix-mvc.test.ts",
};

/** Every `| ID | ... |` row in the matrix, in document order. */
function matrixIds(markdown: string): string[] {
  return [...markdown.matchAll(/^\|\s*((?:ARCH|PTY|AGREAD|AUTH|GIT)-\d{2})\s*\|/gm)]
    .flatMap((match) => match[1] ?? []);
}

test("the matrix ID parser finds table rows and only table rows", () => {
  const parsed = matrixIds([
    "| ID | Gate | Required evidence |",
    "| ARCH-01 | boundary | static test |",
    "| PTY-14 | host busy | rejected |",
    "prose mentioning ARCH-99 outside a table",
    "|not-a-row AUTH-01 |",
  ].join("\n"));
  assert.deepEqual(parsed, ["ARCH-01", "PTY-14"]);
});

test("every matrix ID is either owned here or delegated to the mobile app", async () => {
  const markdown = await readFile(matrixFile, "utf8");
  const declared = matrixIds(markdown);
  assert.ok(declared.length > 0, `no ID rows parsed from ${matrixFile}`);
  assert.equal(new Set(declared).size, declared.length, "the matrix declares an ID twice");

  const covered = new Set([...Object.keys(OWNED), ...Object.keys(DELEGATED)]);
  for (const id of declared) {
    assert.ok(covered.has(id), `${id} is in the matrix with no evidence and no delegation`);
  }
  // The other direction: evidence for a row that no longer exists is dead weight
  // that would quietly outlive the requirement it was written for.
  for (const id of covered) {
    assert.ok(declared.includes(id), `${id} has evidence but is no longer in the matrix`);
  }
  for (const id of Object.keys(DELEGATED)) {
    assert.equal(id in OWNED, false, `${id} is both owned and delegated`);
  }
});

test("every piece of declared evidence is a test that still exists", async () => {
  const sources = new Map<string, string>();
  for (const [id, evidence] of Object.entries(OWNED)) {
    for (const { file, titles } of evidence) {
      let source = sources.get(file);
      if (source === undefined) {
        source = await readFile(join(testRoot, file), "utf8");
        sources.set(file, source);
      }
      for (const title of titles) {
        // Titles are matched inside a `test(` call, so a title that survives only
        // as a comment or as a variable name does not count as evidence.
        // `assert.ok` rather than `assert.match`, which would print the whole file.
        const declared = new RegExp(
          `test\\(\\s*[\`"'][^\`"']*${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        );
        assert.ok(declared.test(source), `${id}: ${file} no longer has a test titled "${title}"`);
      }
    }
  }
});

/**
 * GRIEŽTINIMAS vs etalonas. There, `DELEGATED` was four strings nobody checked:
 * the mirror suite could be renamed, or never written, and this package would
 * still report the four IDs as covered. `mobile-app` has no sources in VERQESTRA
 * yet, so the check cannot run today — and a TODO would be exactly the promise
 * this whole file exists to refuse. It closes itself instead: the first source
 * file under `mobile-app/src` turns the delegation into a requirement.
 */
test("the moment mobile-app has sources, the suite it is delegated to must exist", async () => {
  const appSource = join(workspaceRoot, "mobile-app", "src");
  const present = await readdir(appSource).catch(() => undefined);
  if (present === undefined || present.length === 0) return;

  for (const relative of new Set(Object.values(DELEGATED))) {
    const mirror = join(workspaceRoot, ...relative.split("/"));
    const found = await readFile(mirror, "utf8").catch(() => undefined);
    assert.ok(
      found !== undefined,
      `mobile-app/src now has ${present.length} entries, so ${relative} must exist`,
    );
    // Existing is not enough: it must actually claim the IDs delegated to it.
    for (const [id, target] of Object.entries(DELEGATED)) {
      if (target !== relative) continue;
      assert.ok(found.includes(id), `${relative} exists but does not own ${id}`);
    }
  }
});

test("the Android physical-device E2E is handed to a human and claims no automated evidence", async () => {
  const markdown = await readFile(matrixFile, "utf8");
  const heading = markdown.indexOf("## Android physical-device E2E");
  assert.ok(heading > 0, "the matrix lost its Android E2E section");
  const next = markdown.indexOf("\n## ", heading + 1);
  const section = markdown.slice(heading, next === -1 ? markdown.length : next);

  assert.match(section, /HUMAN-REQUIRED/, "the Android E2E section does not state that it needs a human");
  // No ID row may hide in there: an E2E step marked with an ID would let this
  // suite's evidence check "cover" something no test can run.
  assert.deepEqual(matrixIds(section), [], "an automated ID row appeared inside the Android E2E section");
  // Every numbered step must still be enumerated, so the section stays a runbook
  // rather than a promise.
  const steps = [...section.matchAll(/^\d+\.\s+\S/gm)];
  assert.ok(steps.length >= 13, `the Android E2E runbook lists only ${steps.length} steps`);
});
