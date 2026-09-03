// VQ-502 (6/6-d) testai — Stop hook'o srautas. Svarbiausia, ką jie pin'ina: INVARIANTAS, kad
// joks kelias nesibaigia be stop-bridge įrašo; blokuojančios šakos grąžina exit 2 su „error",
// o po commit'o nepavykęs push lieka „done" (darbas repo JAU yra); lifecycle-only darbas nėra
// tylus no-op; ir stage'inama tik šios sesijos aibė, niekada `git add --all`.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { hookOnStop } from "../interfaces/hooks/on-stop.js";
import type {
  StopCommitResult,
  StopHookDeps,
  StopHookPorts,
} from "../interfaces/hooks/on-stop-context.js";
import type { HookIo } from "../interfaces/hooks/protocol.js";

const ROOT = path.resolve("/repo");
const RUNTIME = path.join(ROOT, "vq");
const HOOKS_LOG = path.join(RUNTIME, "logs", "hooks.log");
const CHANGES_LOG = path.join(RUNTIME, "logs", "changes.log");
const COMMIT_MSG = path.join(RUNTIME, "logs", "commit-msg.md");
const LEDGER = path.join(RUNTIME, "state", "session-writes.json");
const CURRENT_TASK = path.join(RUNTIME, "state", "current-task-id");
const NOW = new Date("2026-08-21T12:00:00.000Z");

type StopWorld = {
  ports: StopHookPorts;
  io: HookIo;
  errors: string[];
  store: Map<string, string>;
  bridge: { status: string; reason: string; taskId: string }[];
  commits: { paths: readonly string[]; push: boolean; message: string }[];
  guardCodes: Record<string, number>;
  changed: string[];
  status: string;
  isRepo: boolean;
  hasChanges: boolean;
  commitResult: StopCommitResult;
  autoCommit: boolean;
  autoPush: boolean;
  gatesPassed: boolean;
};

function stopWorld(files: Record<string, string> = {}): StopWorld {
  const store = new Map(Object.entries(files));
  const errors: string[] = [];
  const world: StopWorld = {
    errors,
    store,
    bridge: [],
    commits: [],
    guardCodes: {},
    changed: [],
    status: "",
    isRepo: true,
    hasChanges: true,
    commitResult: { ok: true, branch: "main" },
    autoCommit: true,
    autoPush: false,
    gatesPassed: true,
    io: { out: () => {}, error: (line) => errors.push(line) },
    ports: {
      fs: {
        exists: async (p) => store.has(p),
        readTextFileIfExists: async (p) => store.get(p),
        writeTextFile: async (p, content) => void store.set(p, content),
        appendTextFile: async (p, text) => void store.set(p, `${store.get(p) ?? ""}${text}`),
        makeDirectory: async () => {},
        removeIfExists: async (p) => void store.delete(p),
      },
      env: () => undefined,
      now: () => NOW,
      guardRoots: async () => ({ frontend: "apps/web", backend: "apps/api", mobile: "apps/mobile" }),
      runGuard: async () => 0,
      runStopGuard: async (command) => world.guardCodes[command] ?? 0,
      collectChangedFiles: async () => world.changed,
      isGitRepository: async () => world.isRepo,
      hasGitChanges: async () => world.hasChanges,
      gitStatusPorcelain: async () => ({ code: 0, stdout: world.status, stderr: "" }),
      filterGitIgnored: async () => new Set<string>(),
      commitAndPush: async ({ paths, push, message }) => {
        world.commits.push({ paths, push, message });
        return world.commitResult;
      },
      stopBridge: async (entry) => void world.bridge.push(entry),
      loadGitAutomationPolicy: async () =>
        ({
          auto_commit_enabled: world.autoCommit,
          auto_push_enabled: world.autoPush,
          conventional_commits_required: false,
          pr_after_successful_task: false,
          pr_requires_create_flag: false,
          release_notes_after_final_audit: false,
          release_notes_path: "vq/project/release-notes.md",
        }),
      readQualityGatesStatus: async () =>
        ({ passed: world.gatesPassed }) as Awaited<ReturnType<StopHookPorts["readQualityGatesStatus"]>>,
      commandExists: async () => false,
      runShell: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
  };
  return world;
}

function deps(world: StopWorld): StopHookDeps {
  return { ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME, io: world.io };
}

// ---------------------------------------------------------------------------
// terminalinės šakos ir stop-bridge invariantas
// ---------------------------------------------------------------------------

test("hookOnStop: jokių pakeitimų — done su stop-bridge įrašu", async () => {
  const world = stopWorld();
  assert.equal(await hookOnStop(deps(world)), 0);
  assert.deepEqual(world.bridge, [{ status: "done", reason: "stop hook allowed: no changes", taskId: "" }]);
  assert.deepEqual(world.commits, []);
});

test("hookOnStop: lifecycle-only darbas NĖRA tylus no-op", async () => {
  // `collectChangedFiles` filtruoja runtime prefiksus, tad užduotis, kurios vienintelis
  // rezultatas yra generuotas artefaktas, čia atrodo kaip „jokių pakeitimų" — bet planas jį
  // stage'ina, ir be šios šakos loop'as ją perdispatch'intų kaip „nulis commit'ų".
  const world = stopWorld({ [CURRENT_TASK]: "890\n" });
  world.status = " M vq/architecture/generated/map.json\n";

  assert.equal(await hookOnStop(deps(world)), 0);
  assert.deepEqual(world.commits[0]?.paths, ["vq/architecture/generated/map.json"]);
  assert.equal(world.bridge.at(-1)?.status, "done");
  assert.match(world.store.get(HOOKS_LOG) ?? "", /lifecycle failų/);
});

test("hookOnStop: guard'o blokada — exit 2, error statusas ir garsi eilutė", async () => {
  const world = stopWorld({ [CURRENT_TASK]: "890\n" });
  world.changed = ["src/a.ts"];
  world.guardCodes["hook-secret-scan"] = 1;

  assert.equal(await hookOnStop(deps(world)), 2);
  assert.deepEqual(world.bridge, [{ status: "error", reason: "secret scan blocked stop", taskId: "890" }]);
  assert.equal(world.commits.length, 0, "užblokuotas Stop niekada necommit'ina");
  assert.match(world.errors.join("\n"), /STOP BLOKUOTAS/);
});

test("hookOnStop: TypeScript fallback bėga TIK be žalio quality-gates statuso", async () => {
  const world = stopWorld({ [CURRENT_TASK]: "890\n", [path.join(ROOT, "tsconfig.json")]: "{}" });
  world.changed = ["src/a.ts"];
  world.gatesPassed = false;
  world.ports.commandExists = () => Promise.resolve(true);
  world.ports.runShell = () => Promise.resolve({ code: 2, stdout: "src/a.ts(1,1): error TS1005: x\n", stderr: "" });

  assert.equal(await hookOnStop(deps(world)), 2);
  assert.deepEqual(world.bridge, [{ status: "error", reason: "typescript blocked stop", taskId: "890" }]);
  assert.match(world.store.get(HOOKS_LOG) ?? "", /1 TypeScript klaidų/);

  // Žalias gate statusas fallback'ą praleidžia — patikra nedubliuojama.
  const green = stopWorld({ [CURRENT_TASK]: "890\n", [path.join(ROOT, "tsconfig.json")]: "{}" });
  green.changed = ["src/a.ts"];
  green.status = " M src/a.ts\n";
  green.store.set(LEDGER, JSON.stringify(["src/a.ts"]));
  green.ports.commandExists = () => Promise.resolve(true);
  green.ports.runShell = () => Promise.resolve({ code: 2, stdout: "error TS1005\n", stderr: "" });
  assert.equal(await hookOnStop(deps(green)), 0);
  assert.equal(green.bridge.at(-1)?.status, "done");
});

test("hookOnStop: išjungtas auto-commit ir ne-git medis baigiasi done, be commit'o", async () => {
  const disabled = stopWorld({ [CURRENT_TASK]: "890\n" });
  disabled.changed = ["src/a.ts"];
  disabled.autoCommit = false;
  assert.equal(await hookOnStop(deps(disabled)), 0);
  assert.equal(disabled.bridge.at(-1)?.reason, "stop hook allowed: auto commit disabled by policy");
  assert.equal(disabled.commits.length, 0);

  const noRepo = stopWorld({ [CURRENT_TASK]: "890\n" });
  noRepo.changed = ["src/a.ts"];
  noRepo.isRepo = false;
  assert.equal(await hookOnStop(deps(noRepo)), 0);
  assert.equal(noRepo.bridge.at(-1)?.reason, "stop hook allowed: no git repository");
  assert.equal(noRepo.store.get(CHANGES_LOG), "");
});

test("hookOnStop: vien svetimi pakeitimai — commit praleidžiamas, jie lieka nepaliesti", async () => {
  const world = stopWorld({
    [CURRENT_TASK]: "890\n",
    [LEDGER]: JSON.stringify(["src/theirs.ts"]),
    [path.join(RUNTIME, "state", "session-write-owners.json")]: JSON.stringify({
      "src/theirs.ts": { sessions: ["kitas"], tasks: ["999"] },
    }),
  });
  world.changed = ["src/theirs.ts"];
  world.status = " M src/theirs.ts\n";
  // Be sesijos tapatybės niekas negali būti ĮRODYTA svetimu: nuosavybės filtras be nonce
  // sąmoningai nieko nemeta, tad svetimumą tikrinti galima tik dispatch'intoje sesijoje.
  world.ports.env = (name) => (name === "AG_DISPATCH_NONCE" ? "nonce-1" : undefined);

  assert.equal(await hookOnStop(deps(world)), 0);
  assert.equal(world.commits.length, 0);
  assert.equal(world.bridge.at(-1)?.reason, "stop hook allowed: no session-scoped changes to commit");
  assert.match(world.store.get(HOOKS_LOG) ?? "", /SVETIMOS SESIJOS RAŠYMAI/);
});

// ---------------------------------------------------------------------------
// commit kelias
// ---------------------------------------------------------------------------

test("hookOnStop: Claude parašyta žinutė naudojama, o failas išvalomas", async () => {
  const world = stopWorld({
    [CURRENT_TASK]: "890\n",
    [LEDGER]: JSON.stringify(["src/a.ts"]),
    [COMMIT_MSG]: "feat: mano antraste\n\nkunas",
  });
  world.changed = ["src/a.ts"];
  world.status = " M src/a.ts\n";

  assert.equal(await hookOnStop(deps(world)), 0);
  const commit = world.commits[0];
  assert.deepEqual(commit?.paths, ["src/a.ts"]);
  assert.equal(commit?.push, false, "push politika išjungta");
  // Kūno sudėjimas 1:1 kaip etalone: `split` palieka tuščią eilutę, tad tarp antraštės ir kūno
  // lieka etalono baitai — on-disk commit žinutės forma yra kontraktas, ne kosmetika.
  assert.match(commit?.message ?? "", /^feat: mano antraste\n\n\nkunas\n/);
  assert.equal(world.store.get(COMMIT_MSG), "", "panaudota žinutė nebegali nutekėti į kitą commit'ą");
  assert.equal(world.store.get(CHANGES_LOG), "");
  assert.equal(world.bridge.at(-1)?.reason, "stop hook allowed: commit completed, push disabled by policy");
});

test("hookOnStop: be žinutės failo antraštė generuojama iš REALIAI stage'inamų failų", async () => {
  const world = stopWorld({ [CURRENT_TASK]: "890\n", [LEDGER]: JSON.stringify(["src/a.ts"]) });
  world.changed = ["src/a.ts"];
  world.status = " M src/a.ts\n";
  world.autoPush = true;

  assert.equal(await hookOnStop(deps(world)), 0);
  const commit = world.commits[0];
  assert.equal(commit?.push, true);
  assert.match(commit?.message ?? "", /src\/a\.ts/);
  assert.match(commit?.message ?? "", /\[orchestrator\] 2026-08-21T12:00:00\.000Z$/);
  assert.equal(world.bridge.at(-1)?.reason, "stop hook allowed: commit and push completed");
});

test("hookOnStop: nepavykęs commit — error; nepavykęs PUSH po commit'o — done", async () => {
  const failedCommit = stopWorld({ [CURRENT_TASK]: "890\n", [LEDGER]: JSON.stringify(["src/a.ts"]) });
  failedCommit.changed = ["src/a.ts"];
  failedCommit.status = " M src/a.ts\n";
  failedCommit.commitResult = { ok: false, step: "commit", result: { code: 1, stdout: "", stderr: "nothing" } };
  assert.equal(await hookOnStop(deps(failedCommit)), 0);
  assert.deepEqual(failedCommit.bridge.at(-1), { status: "error", reason: "git commit failed", taskId: "890" });

  // Commit'as JAU repo: klaida čia priverstų orkestratorių perdaryti darbą, kuris jau padarytas.
  const failedPush = stopWorld({ [CURRENT_TASK]: "890\n", [LEDGER]: JSON.stringify(["src/a.ts"]) });
  failedPush.changed = ["src/a.ts"];
  failedPush.status = " M src/a.ts\n";
  failedPush.autoPush = true;
  failedPush.commitResult = { ok: false, step: "push", result: { code: 1, stdout: "", stderr: "rejected" } };
  assert.equal(await hookOnStop(deps(failedPush)), 0);
  assert.equal(failedPush.bridge.at(-1)?.status, "done");
  assert.match(failedPush.bridge.at(-1)?.reason ?? "", /commit ok, resolve manually/);
  assert.match(failedPush.errors.join("\n"), /Commit atliktas/);
});

// Task 002 lenktynė (2026-08-25): žinutė buvo valoma PRIEŠ sužinant commit'o baigtį, tad
// guard'o atmestas commit'as palikdavo darbą medyje, o aprašą — ištrintą; kitas stop'as
// krisdavo į fallback su WIP žyme. Kontraktas dabar simetriškas: žinutė ir darbas, kurį ji
// aprašo, išgyvena arba išsivalo KARTU.
test("hookOnStop: nepavykęs commit'as ŽINUTĖS nepraranda — kitas bandymas ją perpanaudoja", async () => {
  const AUTHORED = "feat: tikroji antraste\n\nkunas";
  const world = stopWorld({
    [CURRENT_TASK]: "890\n",
    [LEDGER]: JSON.stringify(["src/a.ts"]),
    [COMMIT_MSG]: AUTHORED,
  });
  world.changed = ["src/a.ts"];
  world.status = " M src/a.ts\n";
  world.commitResult = { ok: false, step: "commit", result: { code: 1, stdout: "", stderr: "guard blocked" } };

  assert.equal(await hookOnStop(deps(world)), 0);
  assert.equal(world.bridge.at(-1)?.status, "error");
  assert.equal(world.store.get(COMMIT_MSG), AUTHORED, "atmestas commit'as negali ištrinti darbo aprašo");

  // Antras stop'as po pataisymo: TA PATI autorinė žinutė, ne failų vardų fallback'as su WIP.
  world.commitResult = { ok: true, branch: "main" };
  assert.equal(await hookOnStop(deps(world)), 0);
  assert.match(world.commits.at(-1)?.message ?? "", /^feat: tikroji antraste/);
  assert.equal(world.store.get(COMMIT_MSG), "", "po sėkmės žinutė išvalyta");
});

test("hookOnStop: push kritimas PO commit'o žinutę išvalo — darbas jau istorijoje", async () => {
  const world = stopWorld({
    [CURRENT_TASK]: "890\n",
    [LEDGER]: JSON.stringify(["src/a.ts"]),
    [COMMIT_MSG]: "feat: antraste\n\nkunas",
  });
  world.changed = ["src/a.ts"];
  world.status = " M src/a.ts\n";
  world.autoPush = true;
  world.commitResult = { ok: false, step: "push", result: { code: 1, stdout: "", stderr: "rejected" } };

  assert.equal(await hookOnStop(deps(world)), 0);
  assert.equal(world.bridge.at(-1)?.status, "done");
  assert.equal(world.store.get(COMMIT_MSG), "", "commit'as istorijoje — palikta žinutė priliptų prie svetimo darbo");
});

// 020-a-02 (R1): Bash kanalu parašytas darbas ledger'iui nematomas, o rescue/gap saugikliai
// ilgame bandyme išsijungia. Fallback'as jį grąžina TIK su scope įrodymu ir TIK garsiai.
test("hookOnStop: allowed-paths fallback stage'ina ledger'iui nematomą darbą su GARSIA žyma", async () => {
  const TASK_FILE = path.join(ROOT, "AG", "tasks", "delegated", "890.md");
  const world = stopWorld({
    [CURRENT_TASK]: "890\n",
    [LEDGER]: "[]",
    [path.join(RUNTIME, "state", "current-task-file")]: `${TASK_FILE}\n`,
    [TASK_FILE]: [
      "# Task",
      "",
      "## Tikslas",
      "Testinis task'as.",
      "",
      "## Failai",
      "Leidžiama:",
      "- `src/app/**`",
      "",
      "## Patikra",
      "- `pnpm test`",
    ].join("\n"),
    [path.join(RUNTIME, "state", "session-start-status.json")]: JSON.stringify({
      dispatch_nonce: "nonce-1",
      task_id: "890",
      baseline_valid: true,
      non_runtime_dirty_entries: [{ status: " M", path: "src/app/bash-written.ts" }],
    }),
  });
  world.ports.env = (name) => (name === "AG_DISPATCH_NONCE" ? "nonce-1" : undefined);
  world.changed = ["src/app/bash-written.ts"];
  world.status = " M src/app/bash-written.ts\n";

  assert.equal(await hookOnStop(deps(world)), 0);
  assert.deepEqual(world.commits[0]?.paths, ["src/app/bash-written.ts"], "ledger'iui nematomas darbas grįžo į commit'ą");
  assert.match(
    world.store.get(HOOKS_LOG) ?? "",
    /STAGING LEDGER FALLBACK: task=890 \+1 files: src\/app\/bash-written\.ts/,
    "fallback'as niekada nebūna tylus",
  );
});

// ---------------------------------------------------------------------------
// task 141: tyli tuštuma po žalio darbo
// ---------------------------------------------------------------------------

// Atkurta 098 sąlyga (2026-09-01, run ec04af19): vykdytojas baigė žaliai, medyje guli produkto
// failai, o Stop hook'o portas metė iš vidurio. Iki šio testo tai reiškė NULĮ pėdsakų: jokios
// hooks.log eilutės, jokio stop-bridge įrašo, jokio commit'o — orkestratorius matė tik vėlesnį
// „Claude did not create a new commit". 097 tame pačiame bėgime commit'ino, tad skirtumo
// paaiškinti nebuvo iš ko.
test("hookOnStop: kritęs portas nebelieka tylus — garsi eilutė IR stop-bridge įrašas", async () => {
  const world = stopWorld({ [CURRENT_TASK]: "098\n", [LEDGER]: JSON.stringify(["src/a.ts"]) });
  world.changed = ["src/a.ts"];
  world.status = " M src/a.ts\n";
  world.ports.filterGitIgnored = () => Promise.reject(new Error("git ls-files nulūžo"));

  assert.equal(await hookOnStop(deps(world)), 0);
  assert.equal(world.commits.length, 0, "kritęs kelias necommit'ina");
  assert.deepEqual(world.bridge.at(-1), {
    status: "error",
    reason: "stop hook crashed: git ls-files nulūžo",
    taskId: "098",
  });
  assert.match(world.store.get(HOOKS_LOG) ?? "", /STOP NEBAIGTAS — Stop hook'as krito.*git ls-files nulūžo/);
  assert.match(world.errors.join("\n"), /LIKO NECOMMIT'INTAS/);
});

// Sulaikymas privalo išgyventi ir tada, kai gedimas yra pats stop tiltas: bent vienas kanalas
// (hooks.log arba stderr) turi pasakyti, kad darbas liko medyje.
test("hookOnStop: kritęs stop-bridge NENUŽUDO garsios eilutės", async () => {
  const world = stopWorld({ [CURRENT_TASK]: "098\n" });
  world.changed = ["src/a.ts"];
  world.ports.collectChangedFiles = () => Promise.reject(new Error("git status nepasiekiamas"));
  world.ports.stopBridge = () => Promise.reject(new Error("attempt namespace nepasiekiamas"));

  assert.equal(await hookOnStop(deps(world)), 0);
  assert.match(world.store.get(HOOKS_LOG) ?? "", /STOP NEBAIGTAS/);
  assert.match(world.errors.join("\n"), /STOP hook'as krito: git status nepasiekiamas/);
});

// Antra 098 klasės pusė: hook'as terminalinę šaką PASIEKIA, bet staging planas tuščias, nors
// medyje guli žalias produkto darbas. Toks atvejis skelbdavosi „done" — melas, kurio orkestratorius
// paskui negalėdavo paaiškinti. Įrodytai svetimas purvas (testas aukščiau) lieka „done".
test("hookOnStop: tuščias planas su žaliu darbu — error su failų vardais, ne tylus done", async () => {
  const world = stopWorld({ [CURRENT_TASK]: "098\n", [LEDGER]: "[]" });
  world.changed = ["src/application/code-intelligence/code-map/coverage.ts"];
  world.status = " M src/application/code-intelligence/code-map/coverage.ts\n";
  // Galiojantis SAVO baseline su nepaaiškintu co-tenant'o purvu: clean-baseline rescue išsijungia
  // (baseline nešvarus), gap saugiklis išsijungia (bandymo startas ŽINOMAS), o allowed-paths
  // fallback'as be `current-task-file` net neįsijungia. Planas lieka tuščias — lygiai ta būsena,
  // kurioje 098 darbas liko medyje.
  world.store.set(
    path.join(RUNTIME, "state", "session-start-status.json"),
    JSON.stringify({
      dispatch_nonce: "nonce-098",
      task_id: "098",
      baseline_valid: true,
      non_runtime_dirty_entries: [{ status: " M", path: "src/co-tenant.ts" }],
    }),
  );
  world.ports.env = (name) => (name === "AG_DISPATCH_NONCE" ? "nonce-098" : undefined);

  assert.equal(await hookOnStop(deps(world)), 0);
  assert.equal(world.commits.length, 0);
  assert.equal(world.bridge.at(-1)?.status, "error");
  assert.match(world.bridge.at(-1)?.reason ?? "", /stop hook made no commit: 1 product file\(s\)/);
  assert.match(
    world.store.get(HOOKS_LOG) ?? "",
    /NECOMMIT'INTAS DARBAS: task=098 .*src\/application\/code-intelligence\/code-map\/coverage\.ts/,
  );
  // changes.log NEVALOMAS: darbas tebėra medyje, tad jo įrodymas negali dingti.
  assert.equal(world.store.get(CHANGES_LOG), undefined);
});

// 097 klasės kelias — žalias darbas, matomas ledger'yje — nepakito nė per vieną eilutę.
test("hookOnStop: 097 klasės kelias nepakitęs — ledger'io darbas commit'inamas kaip anksčiau", async () => {
  const world = stopWorld({ [CURRENT_TASK]: "097\n", [LEDGER]: JSON.stringify(["src/a.ts", "src/b.ts"]) });
  world.changed = ["src/a.ts", "src/b.ts"];
  world.status = " M src/a.ts\n M src/b.ts\n";

  assert.equal(await hookOnStop(deps(world)), 0);
  assert.deepEqual(world.commits[0]?.paths, ["src/a.ts", "src/b.ts"]);
  assert.equal(world.bridge.at(-1)?.status, "done");
  assert.equal(world.store.get(CHANGES_LOG), "");
});

test("hookOnStop: sesijos nuotrauka užrašoma PRIEŠ commit'ą, kuris išvalo changes.log", async () => {
  const world = stopWorld({ [CURRENT_TASK]: "890\n", [LEDGER]: JSON.stringify(["src/a.ts"]) });
  world.changed = ["src/a.ts"];
  world.status = " M src/a.ts\n";

  assert.equal(await hookOnStop(deps(world)), 0);
  // Be nuotraukos SessionEnd ir santrauka commit'inusiai sesijai rodytų 0 pakeistų failų.
  assert.equal(world.store.get(path.join(RUNTIME, "logs", "session-changes.log")), "src/a.ts\n");
  assert.equal(world.store.get(CHANGES_LOG), "");
});
