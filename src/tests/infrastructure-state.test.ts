// VQ-403 (2/2) integraciniai testai — reali FS: context-cache saugykla, attempt
// rezoliucijos adapteriai, token-usage rašytojas su dual-write, stop-bridge no-clobber
// vartai ir session evidencijos tiekėjai.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { relative } from "node:path";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { CODE_INDEX_STALE, CODE_INDEX_UNUSED, CONTEXT_CACHE_ABSENT } from "../application/context-pack/context-cache-model.js";
import { computeContextCacheKey } from "../application/context-pack/context-cache-key.js";
import { parseTaskUsageEntries } from "../domain/tokens/usage-ledger.js";
import type { AttemptRef } from "../application/scheduling/worker-limits.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { createAttempt, openAttempt } from "../infrastructure/persistence/runtime-artifact-store.js";
import {
  collectContextCacheSources,
  createContextCacheAdapter,
  invalidateContextCacheForSources,
  lookupContextCache,
  pruneStaleContextCacheEntries,
  saveContextCacheEntry,
} from "../infrastructure/persistence/context-cache-store.js";
import {
  attemptIdentityAdapter,
  noRuntimeAttemptResolution,
  runtimeArtifactsEnabled,
  type AttemptResolutionPort,
} from "../infrastructure/state/attempt-resolution.js";
import { readSessionFileKinds, readSessionWrites, sessionFileEventsPath, sessionWritesPath } from "../infrastructure/state/session-activity.js";
import { interactiveStopMayOverwrite, stopBridgeForProject, stopBridgePath } from "../infrastructure/state/stop-bridge.js";
import { logTokenUsage, tokenUsageLogPath } from "../infrastructure/state/token-usage-log.js";

const projectRoot = await mkdtemp(path.join(tmpdir(), "vq-state-"));
const runtimeRoot = path.join(projectRoot, "vq");
after(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

const REF: AttemptRef = { runId: "r1", workerId: "w1", taskId: "t1", attemptId: "a1" };

function resolutionFor(ref: AttemptRef): AttemptResolutionPort {
  return {
    async resolveActiveAttempt() {
      const handle = await openAttempt(runtimeRoot, ref);
      if (!handle.ok) return { ok: false, reason: "not-created", errors: handle.errors };
      return { ok: true, attempt: { handle: handle.data, manifest: handle.data.manifest } };
    },
  };
}

await createAttempt({
  runtimeRoot,
  ref: REF,
  graphHash: "none",
  policy: {},
  source: { origin: "queue-task" },
  createdAt: "2026-08-20T12:00:00.000Z",
});

test("context-cache: absent sentinelis, save/hit, code-index drift evict'ina, invalidacija tikslinė", async () => {
  await nodeFsAdapter.writeTextFile(path.join(projectRoot, "src", "taikinys.ts"), "turinys\n");
  const sources = await collectContextCacheSources(projectRoot, runtimeRoot, {
    taskPath: path.join(projectRoot, "AG", "tasks", "queue", "t1.md"),
    taskText: "# Task t1",
    targets: ["src/taikinys.ts"],
    specSources: ["AG/openspec/changes/x/spec.md#skyrius"],
  });
  // Nesamas spec failas — sentinelis, ne metimas; jis dalyvauja fingerprint'e.
  const spec = sources.find((source) => source.kind === "spec");
  assert.equal(spec?.hash, CONTEXT_CACHE_ABSENT);
  const target = sources.find((source) => source.kind === "source");
  assert.notEqual(target?.hash, CONTEXT_CACHE_ABSENT);

  const key = computeContextCacheKey(sources);
  assert.deepEqual(await lookupContextCache(runtimeRoot, key), { status: "miss", reason: "no_entry" });

  const saved = await saveContextCacheEntry(runtimeRoot, {
    key,
    taskId: "t1",
    contextPackJson: '{"pack":1}',
    codeIndexDescriptor: "sha256:abc",
    selectedChars: 100,
    selectedTokenEstimate: 25,
    droppedItemCount: 0,
  });
  assert.deepEqual(saved, { stored: true });

  const hit = await lookupContextCache(runtimeRoot, key, () => Promise.resolve("sha256:abc"));
  assert.equal(hit.status, "hit");
  if (hit.status === "hit") assert.equal(hit.entry.context_pack_json, '{"pack":1}');

  // Pasikeitęs code index — miss + evict; kitas lookup jau no_entry.
  const drift = await lookupContextCache(runtimeRoot, key, () => Promise.resolve("sha256:kitas"));
  assert.deepEqual(drift, { status: "miss", reason: "code_index_drift" });
  assert.deepEqual(await lookupContextCache(runtimeRoot, key), { status: "miss", reason: "no_entry" });

  // STALE indekso assembly nesaugomas.
  const stale = await saveContextCacheEntry(runtimeRoot, {
    key,
    taskId: "t1",
    contextPackJson: "{}",
    codeIndexDescriptor: CODE_INDEX_STALE,
    selectedChars: 1,
    selectedTokenEstimate: 1,
    droppedItemCount: 0,
  });
  assert.deepEqual(stale, { stored: false, reason: "code_index_stale" });

  // Tikslinė invalidacija: pašalinamas tik nuo pakeisto kelio priklausantis įrašas.
  await saveContextCacheEntry(runtimeRoot, {
    key,
    taskId: "t1",
    contextPackJson: "{}",
    codeIndexDescriptor: CODE_INDEX_UNUSED,
    selectedChars: 1,
    selectedTokenEstimate: 1,
    droppedItemCount: 0,
  });
  const invalidated = await invalidateContextCacheForSources(runtimeRoot, ["src/taikinys.ts"]);
  assert.deepEqual(invalidated.removed, [key.fingerprint]);
  assert.deepEqual(invalidated.kept, []);
});

// A2 regresijos tinklas. Change KATALOGO ref'as anksčiau hash'uodavosi per `readFile` ant
// katalogo → EISDIR → `absent` KONSTANTA, tad `proposal.md` redagavimas fingerprint'o
// nekeisdavo ir kešas atiduodavo pasenusį pack'ą. Būtent tie ref'ai, dėl kurių egzistuoja
// visas CHANGE_DIR_FILES išskleidimas, buvo vieninteliai, kurių turinio kešas nematė.
test("context-cache: change-katalogo ref'as seka realų proposal.md turinį (A2)", async () => {
  const changeDir = path.join(projectRoot, "AG", "openspec", "changes", "a2");
  await nodeFsAdapter.writeTextFile(path.join(changeDir, "proposal.md"), "pirma redakcija\n");

  const collect = async () =>
    await collectContextCacheSources(projectRoot, runtimeRoot, {
      taskPath: path.join(projectRoot, "AG", "tasks", "queue", "t2.md"),
      taskText: "# Task t2",
      targets: [],
      specSources: ["AG/openspec/changes/a2"],
    });

  const firstEdition = await collect();
  const specBefore = firstEdition.find((source) => source.kind === "spec");
  assert.notEqual(specBefore?.hash, CONTEXT_CACHE_ABSENT, "katalogo ref'as nebėra amžinas sentinelis");
  assert.equal(
    specBefore?.path,
    "AG/openspec/changes/a2/proposal.md",
    "įrašomas IŠSKLEISTAS kelias — operatorius mato, kurio failo tapatybė saugo įrašą",
  );

  await nodeFsAdapter.writeTextFile(path.join(changeDir, "proposal.md"), "antra redakcija\n");
  const secondEdition = await collect();
  assert.notEqual(
    computeContextCacheKey(secondEdition).fingerprint,
    computeContextCacheKey(firstEdition).fingerprint,
    "proposal.md redagavimas privalo invaliduoti kešą",
  );
});

// Kešas skaito per `node:fs` TIESIOGIAI, tad code-intelligence adapterio vartas jam nebėga —
// containment čia privalo būti savas. Anksčiau buvo tik leksinis, o komentaras tvirtino, kad
// symlink'us pagauna kitas adapteris; symlink'as projekto viduje, rodantis į išorę, praeidavo
// ir svetimas failas būdavo perskaitytas bei hash'uotas.
test("context-cache: symlink į išorę nehash'uojamas, o fiksuojamas absent (C10)", async (t) => {
  const outside = await mkdtemp(path.join(tmpdir(), "vq-cache-out-"));
  try {
    await nodeFsAdapter.writeTextFile(path.join(outside, "slaptas.md"), "svetimas turinys\n");
    try {
      await symlink(path.join(outside, "slaptas.md"), path.join(projectRoot, "nuoroda.md"), "file");
    } catch {
      t.skip("symlink kūrimas neleidžiamas šioje aplinkoje");
      return;
    }

    const sources = await collectContextCacheSources(projectRoot, runtimeRoot, {
      taskPath: path.join(projectRoot, "AG", "tasks", "queue", "t3.md"),
      taskText: "# Task t3",
      targets: ["nuoroda.md"],
      specSources: ["nuoroda.md"],
    });

    // Leksiškai `nuoroda.md` yra projekto viduje — būtent todėl senasis vartas jį praleisdavo.
    for (const kind of ["source", "spec"] as const) {
      assert.equal(
        sources.find((source) => source.kind === kind)?.hash,
        CONTEXT_CACHE_ABSENT,
        `${kind}: už ribų rodanti nuoroda neturi būti perskaityta`,
      );
    }
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

// Prune perhash'uoja kelius iš SAUGOMO įrašo, tad juos gali nukreipti ne tik symlink'as, bet ir
// sugadintas cache failas. Fikstūra sudėliota taip, kad BE varto prune pasakytų „šviežia": įrašo
// hash'as sutampa su tikru symlink'o taikinio turiniu. Su vartu kelias neskaitomas, o įrašas
// numetamas — nežinia apie evidenciją negali reikšti „vis dar galioja".
test("context-cache prune: už ribų vedantis įrašo kelias numetamas, o ne perskaitomas (C14)", async (t) => {
  const outside = await mkdtemp(path.join(tmpdir(), "vq-prune-out-"));
  try {
    const target = path.join(outside, "svetimas.md");
    await nodeFsAdapter.writeTextFile(target, "svetimas turinys\n");
    try {
      await symlink(target, path.join(projectRoot, "prune-nuoroda.md"), "file");
    } catch {
      t.skip("symlink kūrimas neleidžiamas šioje aplinkoje");
      return;
    }

    const realHash = createHash("sha256").update(await readFile(target)).digest("hex");
    const sources = [{ kind: "source" as const, path: "prune-nuoroda.md", hash: realHash }];
    const key = computeContextCacheKey(sources);
    await saveContextCacheEntry(runtimeRoot, {
      key,
      taskId: "t-prune",
      contextPackJson: "{}",
      codeIndexDescriptor: CODE_INDEX_UNUSED,
      selectedChars: 1,
      selectedTokenEstimate: 1,
      droppedItemCount: 0,
    });

    const pruned = await pruneStaleContextCacheEntries(projectRoot, runtimeRoot);
    assert.ok(pruned.removed.includes(key.fingerprint), "už ribų vedantis šaltinis daro įrašą pasenusiu");
    assert.ok(!pruned.kept.includes(key.fingerprint));
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

// `architecture` ir `policy` keliai containment'o netikrinami (runtimeRoot teisėtai gali gulėti
// už projectRoot), tad juos saugo TIKSLUS leidžiamų kelių sąrašas. Suklastotas įrašas, nurodantis
// bet kokį kitą kelią, privalo baigtis numetimu, o ne skaitymu.
test("context-cache prune: suklastotas architecture/policy kelias neskaitomas (C21)", async () => {
  const outside = await mkdtemp(path.join(tmpdir(), "vq-prune-runtime-"));
  try {
    const target = path.join(outside, "svetimas.json");
    await nodeFsAdapter.writeTextFile(target, "{}\n");
    const realHash = createHash("sha256").update(await readFile(target)).digest("hex");

    // Kelias, kurio hash'as SUTAMPA su tikru turiniu — be varto prune pasakytų „šviežia".
    const sources = [{ kind: "policy" as const, path: relative(projectRoot, target), hash: realHash }];
    const key = computeContextCacheKey(sources);
    await saveContextCacheEntry(runtimeRoot, {
      key,
      taskId: "t-forged",
      contextPackJson: "{}",
      codeIndexDescriptor: CODE_INDEX_UNUSED,
      selectedChars: 1,
      selectedTokenEstimate: 1,
      droppedItemCount: 0,
    });

    const pruned = await pruneStaleContextCacheEntries(projectRoot, runtimeRoot);
    assert.ok(pruned.removed.includes(key.fingerprint), "ne allowlist'e esantis runtime kelias — įrašas numetamas");
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("createContextCacheAdapter tenkina ContextCachePort kontraktą", async () => {
  const adapter = createContextCacheAdapter(projectRoot, runtimeRoot);
  const sources = await adapter.collectSources({
    taskPath: "AG/tasks/queue/t1.md",
    taskText: "# Task t1",
    targets: [],
    specSources: [],
  });
  const key = computeContextCacheKey(sources);
  await adapter.save({
    key,
    taskId: "t1",
    contextPackJson: "{}",
    codeIndexDescriptor: CODE_INDEX_UNUSED,
    selectedChars: 1,
    selectedTokenEstimate: 1,
    droppedItemCount: 2,
    specDroppedCount: 3,
    codeContextDroppedCount: 4,
  });
  const lookup = await adapter.lookup(key, () => Promise.resolve(CODE_INDEX_UNUSED));
  assert.equal(lookup.status, "hit");
  if (lookup.status === "hit") {
    // Abu praradimų skaičiai privalo grįžti su įrašu ir NESUSIMAIŠYTI: hit'as praneša tą pačią
    // telemetriją kaip surinkimas, kurį jis pakeičia, o iš pack'o jų atkurti nebeįmanoma.
    assert.equal(lookup.entry.dropped_item_count, 2);
    assert.equal(lookup.entry.spec_dropped_count, 3);
    assert.equal(lookup.entry.code_context_dropped_count, 4);
  }
});

test("attempt-resolution: identity adapteris duoda manifesto tapatybę; no-runtime — tuščią objektą", async () => {
  assert.equal(runtimeArtifactsEnabled({}), true);
  assert.equal(runtimeArtifactsEnabled({ AG_RUNTIME_ARTIFACTS: "off" }), false);

  const identity = attemptIdentityAdapter(resolutionFor(REF));
  assert.deepEqual(await identity.identityFields("t1"), {
    run_id: "r1",
    worker_id: "w1",
    runtime_attempt_id: "a1",
  });

  const none = attemptIdentityAdapter(noRuntimeAttemptResolution);
  assert.deepEqual(await none.identityFields("t1"), {});
});

test("logTokenUsage: globalus žurnalas + dual-write attempt kopija su ta pačia tapatybe", async () => {
  await logTokenUsage({
    runtimeRoot,
    resolution: resolutionFor(REF),
    phase: "dispatch",
    taskId: "t1",
    model: "claude-sonnet-5",
    usage: { input_tokens: 100, output_tokens: 20, num_turns: 4 },
    metadata: { attempt: 1 },
    now: new Date("2026-08-20T12:30:00.000Z"),
  });

  const globalRaw = await nodeFsAdapter.readTextFile(tokenUsageLogPath(runtimeRoot));
  const entries = parseTaskUsageEntries(globalRaw);
  assert.equal(entries.length, 1);
  const record = entries[0] as Record<string, unknown>;
  assert.equal(record["task_phase"], "implementation");
  assert.equal(record["usage_captured"], true);
  assert.equal(record["run_id"], "r1");
  assert.equal(record["runtime_attempt_id"], "a1");
  assert.equal(record["num_turns"], 4);

  const attemptCopy = await nodeFsAdapter.readTextFile(
    path.join(runtimeRoot, "runtime", "runs", "r1", "workers", "w1", "tasks", "t1", "attempts", "a1", "token-usage.jsonl"),
  );
  assert.equal(attemptCopy, globalRaw);
});

test("stop-bridge: dispatch stop rašo attempt įrodymą PIRMA ir globalų veidrodį; interaktyvus jo neperrašo", async () => {
  const env = { AG_DISPATCH_NONCE: "nonce-1" } as NodeJS.ProcessEnv;
  await stopBridgeForProject({
    projectRoot,
    runtimeRoot,
    resolution: resolutionFor(REF),
    status: "done",
    reason: "user_stop",
    taskId: "t1",
    env,
    now: () => "2026-08-20T13:00:00.000Z",
  });

  const bridge = JSON.parse(await nodeFsAdapter.readTextFile(stopBridgePath(runtimeRoot))) as Record<string, unknown>;
  assert.equal(bridge["status"], "done");
  assert.equal(bridge["dispatch_nonce"], "nonce-1");
  assert.equal(bridge["task_id"], "t1");

  const attemptStop = JSON.parse(
    await nodeFsAdapter.readTextFile(
      path.join(runtimeRoot, "runtime", "runs", "r1", "workers", "w1", "tasks", "t1", "attempts", "a1", "stop-state.json"),
    ),
  ) as Record<string, unknown>;
  assert.equal(attemptStop["dispatch_nonce"], "nonce-1");
  assert.equal(attemptStop["status"], "done");

  // Interaktyvus stop (tuščias nonce) dispatch įrašo NEperrašo — PRESERVED kelias.
  assert.equal(interactiveStopMayOverwrite(await nodeFsAdapter.readTextFile(stopBridgePath(runtimeRoot))), false);
  await stopBridgeForProject({
    projectRoot,
    runtimeRoot,
    resolution: resolutionFor(REF),
    status: "interrupted",
    reason: "operator",
    taskId: "t1",
    env: {},
  });
  const preserved = JSON.parse(await nodeFsAdapter.readTextFile(stopBridgePath(runtimeRoot))) as Record<string, unknown>;
  assert.equal(preserved["status"], "done");
  const stopLog = await nodeFsAdapter.readTextFile(path.join(runtimeRoot, "logs", "claude-stop.log"));
  assert.match(stopLog, /PRESERVED/);

  assert.equal(interactiveStopMayOverwrite(""), true);
  assert.equal(interactiveStopMayOverwrite('{"dispatch_nonce":"  "}'), true);
  assert.equal(interactiveStopMayOverwrite("ne json"), true);
});

test("session-activity: pirmas kind'as laimi, deleted perrašo, sugadinta eilutė kainuoja tik save", async () => {
  assert.deepEqual(await readSessionWrites(runtimeRoot), []);
  await nodeFsAdapter.writeTextFile(sessionWritesPath(runtimeRoot), JSON.stringify(["src/a.ts", "src/b.ts", 7]));
  assert.deepEqual(await readSessionWrites(runtimeRoot), ["src/a.ts", "src/b.ts"]);

  const lines = [
    JSON.stringify({ path: "src/a.ts", kind: "created", ts: "2026-08-20T10:00:00.000Z" }),
    JSON.stringify({ path: "src/a.ts", kind: "modified", ts: "2026-08-20T10:05:00.000Z" }),
    "sugadinta eilutė",
    JSON.stringify({ path: "src/b.ts", kind: "modified", ts: "2026-08-20T10:06:00.000Z" }),
    JSON.stringify({ path: "src/b.ts", kind: "deleted", ts: "2026-08-20T10:07:00.000Z" }),
  ].join("\n");
  await nodeFsAdapter.writeTextFile(sessionFileEventsPath(runtimeRoot), `${lines}\n`);

  const kinds = await readSessionFileKinds(runtimeRoot);
  assert.equal(kinds.get("src/a.ts"), "created");
  assert.equal(kinds.get("src/b.ts"), "deleted");
  assert.equal(kinds.size, 2);
});
