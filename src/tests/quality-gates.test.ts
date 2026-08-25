// VQ-305 (2 dalis): quality-gates vykdymo kelio unit testai — bash/spawn komandų politikos
// matricos (denylist > allowlist), quality-policy schema/resolveriai/loaderis per fake portą,
// gates-memo grynosios taisyklės ir runQualityGates seka su fake portais (memo hit/miss/red/
// corrupted, blocked komanda, žalio antspaudo rašymas tik stabiliam medžiui). Jokio realaus
// git/FS/spawn.
import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateBashCommandPolicy,
  isDistRebuildCommand,
} from "../domain/policies/bash-command-policy.js";
import {
  baseExecutable,
  checkStacksForLanguage,
  evaluateSpawnCheckCommand,
  isDestructiveCheckCommand,
  EMPTY_CHECK_COMMAND_CONTEXT,
  type CheckCommandContext,
} from "../domain/policies/check-command-allowlist.js";
import { evaluateSpawnQualityCommand } from "../domain/policies/quality-command-policy.js";
import {
  collectConfiguredSpawnChecks,
  loadQualityPolicy,
  qualityPolicySchema,
  resolveCheckCommandContext,
  resolveQualityChecks,
  resolveWaveGateCommands,
} from "../application/policy-governance/quality-policy.js";
import {
  gatesMemoKey,
  gatesMemoRecordFor,
  gatesMemoRecordSchema,
  memoCovers,
  type GatesMemoIdentity,
  type GatesMemoPort,
  type GatesMemoReadResult,
} from "../application/quality-gates/gates-memo.js";
import {
  parseQualityScope,
  renderChecksLog,
  runQualityGates,
  type QualityGatesPorts,
} from "../application/quality-gates/quality-gates.js";
import type { QualityGatesStatus } from "../application/quality-gates/quality-gates-status.js";

test("bash politika: allowlist segmentai, injekcija per skirtukus ir escape šablonai", () => {
  assert.equal(evaluateBashCommandPolicy("git status").blockedPattern, undefined);
  assert.equal(evaluateBashCommandPolicy("pnpm test").blockedPattern, undefined);
  assert.equal(evaluateBashCommandPolicy("rg TODO src | head -5").blockedPattern, undefined);
  assert.equal(evaluateBashCommandPolicy("git log --oneline 2>&1").blockedPattern, undefined, "2>&1 saugus");

  assert.match(evaluateBashCommandPolicy("echo labas").blockedPattern ?? "", /^not-allowlisted:echo/);
  assert.match(evaluateBashCommandPolicy("git status; echo pwned").blockedPattern ?? "", /^not-allowlisted:echo/);
  assert.match(evaluateBashCommandPolicy("ls & rm -rf /tmp/x").blockedPattern ?? "", /^not-allowlisted:rm/, "vienišas & yra skirtukas");
  assert.ok(evaluateBashCommandPolicy("git log $(rm x)").blockedPattern, "substitucija blokuojama");
  assert.ok(evaluateBashCommandPolicy("git status > out.txt").blockedPattern, "failo redirect blokuojamas");
  assert.ok(evaluateBashCommandPolicy("rg TODO --pre sh src").blockedPattern, "rg --pre vykdo komandą");
});

// 2026-08-24, operatoriaus sprendimas: `pnpm --dir` allowlist'as praplėstas VIENU script'u.
// Testas fiksuoja plyšio DYDĮ, ne tik jo egzistavimą: praplėtimas be ribų testo po pusmečio
// tampa „benchmark script'ai leidžiami", o būtent to čia ir nenorima.
test("bash politika: --dir leidžia benchmark:smoke, bet ne mokamas ar rašančias formas", () => {
  assert.equal(
    evaluateBashCommandPolicy("pnpm --dir AG/benchmark benchmark:smoke").blockedPattern,
    undefined,
    "offline dūmų testas leidžiamas: jis pats tikrina, kad nė viena jo komanda neneša --allow-network/--live",
  );

  // Rašantis script'as — kitas saugumo profilis, sąmoningai neleidžiamas.
  assert.ok(evaluateBashCommandPolicy("pnpm --dir AG/benchmark benchmark:report").blockedPattern);
  // Šablonas leidžia TIK script'o vardą, tad mokamos formos nepraeina net su leistinu vardu.
  assert.ok(evaluateBashCommandPolicy("pnpm --dir AG/benchmark benchmark:smoke --allow-network").blockedPattern);
  assert.ok(evaluateBashCommandPolicy("pnpm --dir AG/benchmark benchmark:smoke --live").blockedPattern);
  // Kelio ribos nepasikeitė kartu su script'o vardu.
  assert.ok(evaluateBashCommandPolicy("pnpm --dir ../outside benchmark:smoke").blockedPattern);
  assert.ok(evaluateBashCommandPolicy("pnpm --dir C:/tmp benchmark:smoke").blockedPattern);
});

// 2026-08-24, operatoriaus sprendimas: `benchmark` per sugeneruotą CLI. Testas gina ne tai, kad
// plyšys veikia, o tai, ko jis NEĮLEIDŽIA — mokama forma be `--scenario`/`--repetitions 1` ir
// bet kuri kita subkomanda privalo likti už denylist'o.
test("bash politika: benchmark per dist/cli.js — tik viena celė, tik dvi subkomandos", () => {
  const blocked = (command: string): string => evaluateBashCommandPolicy(command).blockedPattern ?? "";

  // Nemokamos formos.
  assert.equal(evaluateBashCommandPolicy("node dist/cli.js benchmark validate").blockedPattern, undefined);
  assert.equal(
    evaluateBashCommandPolicy("node dist/cli.js benchmark run --dry-run --mode deterministic-control --json").blockedPattern,
    undefined,
  );

  // Mokama forma — leidžiama TIK su abiem apimties ribomis.
  assert.equal(
    evaluateBashCommandPolicy(
      "node dist/cli.js benchmark run --allow-network --mode ag-loop --scenario bugfix-i18n-missing-key --repetitions 1",
    ).blockedPattern,
    undefined,
  );

  // BENCH-9: visi rinkinio scenarijai nedeterministiniai, tad 3 repeticijos yra GRINDYS.
  assert.equal(
    evaluateBashCommandPolicy(
      "node dist/cli.js benchmark run --allow-network --mode ag-loop --scenario bugfix-i18n-missing-key --repetitions 3",
    ).blockedPattern,
    undefined,
  );

  // Trūkstant bet kurios iš trijų apimties ribų mokama forma NEPRAEINA — apimtis yra politikos
  // savybė, ne kviečiančiojo pažadas.
  assert.match(blocked("node dist/cli.js benchmark run --allow-network"), /dist[\\/]cli\.js/);
  assert.match(
    blocked("node dist/cli.js benchmark run --allow-network --scenario x --repetitions 3"),
    /dist[\\/]cli\.js/,
    "be --mode paleistų VISUS režimus, du iš jų mokami",
  );
  assert.match(
    blocked("node dist/cli.js benchmark run --allow-network --mode ag-loop --repetitions 3"),
    /dist[\\/]cli\.js/,
    "be --scenario paleistų visą rinkinį",
  );
  assert.match(blocked("node dist/cli.js benchmark run --live --mode ag-loop --scenario x"), /dist[\\/]cli\.js/);
  assert.match(blocked("node dist/cli.js benchmark run --live --mode ag-loop --scenario x --repetitions 5"), /dist[\\/]cli\.js/);
  assert.match(
    blocked("node dist/cli.js benchmark run --live --mode ag-loop --scenario x --repetitions 12"),
    /dist[\\/]cli\.js/,
    "1 nėra 12 prefiksas",
  );

  // `report`/`verify` be `--out` skaito ir rašo į stdout; su `--out` tampa laisvo kelio rašymu.
  assert.equal(evaluateBashCommandPolicy("node dist/cli.js benchmark report --format markdown").blockedPattern, undefined);
  assert.equal(evaluateBashCommandPolicy("node dist/cli.js benchmark verify --json").blockedPattern, undefined);

  // task-move per dist/cli.js — TA PATI viena kryptis kaip `ag` formoje (2026-08-25).
  assert.equal(
    evaluateBashCommandPolicy("node dist/cli.js task-move AG/tasks/human-review/005-x.md AG/tasks/done").blockedPattern,
    undefined,
  );
  assert.equal(evaluateBashCommandPolicy("node dist/cli.js task-ledger-sync").blockedPattern, undefined, "sync be argumentų");
  assert.match(blocked("node dist/cli.js task-ledger-sync --force"), /dist[\\/]cli\.js/, "sync su argumentais — ne");
  assert.equal(evaluateBashCommandPolicy('node dist/cli.js compound-init "VERQESTRA orchestrator"').blockedPattern, undefined);
  assert.match(
    blocked('node dist/cli.js compound-init "x" --force'),
    /dist[\\/]cli\.js/,
    "perrašymas (--force) lieka žmogui — writeTextIfMissing be jo esamų failų neliečia",
  );
  assert.match(blocked("node dist/cli.js compound-init x"), /dist[\\/]cli\.js/, "aprašymas tik kabutėse");
  assert.equal(evaluateBashCommandPolicy("node dist/cli.js requeue 012-task.md").blockedPattern, undefined, "requeue kaip ag formoje");
  assert.match(blocked("node dist/cli.js requeue AG/tasks/done/x.md"), /dist[\\/]cli\.js/, "requeue tik failo vardu, be kelio");
  assert.match(blocked("node dist/cli.js task-move AG/tasks/done/005-x.md AG/tasks/queue"), /dist[\\/]cli\.js/, "atgal į eilę — ne");
  assert.match(blocked("node dist/cli.js task-move AG/tasks/queue/005-x.md AG/tasks/done"), /dist[\\/]cli\.js/, "iš queue — ne");
  assert.match(
    blocked("node dist/cli.js task-move AG/tasks/human-review/../queue/x.md AG/tasks/done"),
    /dist[\\/]cli\.js/,
    "traversal failo varde — ne",
  );

  // Kitos subkomandos ir rašantys flag'ai lieka uždrausti.
  assert.match(blocked("node dist/cli.js loop"), /dist[\\/]cli\.js/);
  assert.match(blocked("node dist/cli.js benchmark report --out r.md"), /dist[\\/]cli\.js/, "--out yra laisvo kelio rašymas");
  assert.match(blocked("node dist/cli.js benchmark report --format markdown --out r.md"), /dist[\\/]cli\.js/);
  assert.match(blocked("node dist/cli.js benchmark baseline create --out b.json"), /dist[\\/]cli\.js/);
  assert.match(blocked("node dist/cli.js benchmark validate; node dist/cli.js loop"), /dist[\\/]cli\.js/);
});

test("bash politika: saugomi runtime keliai — vq ir AG formos, dist runtime, inline executor", () => {
  assert.equal(evaluateBashCommandPolicy("cat vq/state/task-ledger.json").blockedPattern, "vq/state/");
  assert.equal(evaluateBashCommandPolicy("cat AG/state/task-ledger.json").blockedPattern, "AG/state/");
  assert.equal(
    evaluateBashCommandPolicy("cat vq/supervisor/decision.json").blockedPattern,
    "vq/supervisor/decision.json",
  );
  assert.match(evaluateBashCommandPolicy("cat vq/state/readme-read-events.json").blockedPattern ?? "", /readme-read-events/);
  assert.match(evaluateBashCommandPolicy("node dist/cli.js loop").blockedPattern ?? "", /dist[\\/]cli\.js/);
  assert.equal(evaluateBashCommandPolicy("npm run build").blockedPattern, undefined, "rebuild komanda leidžiama");
  assert.match(evaluateBashCommandPolicy("bash -c 'rm x'").blockedPattern ?? "", /bash/, "inline executor blokuojamas");
});

test("bash politika: sensitive žymė ir isDistRebuildCommand", () => {
  assert.equal(evaluateBashCommandPolicy("git status").sensitive, false);
  const merge = evaluateBashCommandPolicy('git merge worktree-operatorfix -m "žinutė"');
  assert.equal(merge.blockedPattern, undefined, "operatorinis merge kanalas leidžiamas");
  assert.equal(merge.sensitive, true, "git merge pažymimas sensitive");

  assert.equal(isDistRebuildCommand("npm run build"), true);
  assert.equal(isDistRebuildCommand("tsc -p tsconfig.json --noEmit"), true);
  assert.equal(isDistRebuildCommand("npm run build && rm x"), false, "junginiai atmetami");
});

const GO_CTX: CheckCommandContext = { configuredSpawnChecks: [], activeStacks: ["go"] };

test("check allowlist: denylist visada laimi, executor'iai atmetami net sukonfigūruoti", () => {
  assert.equal(isDestructiveCheckCommand("rm", ["-rf", "x"]), true);
  assert.equal(isDestructiveCheckCommand("git", ["-C", "x", "reset", "--hard"]), true, "-C reikšmė praleidžiama");
  assert.equal(isDestructiveCheckCommand("sed", ["-i", "s/a/b/", "f"]), true);
  assert.equal(isDestructiveCheckCommand("find", [".", "-delete"]), true);
  assert.equal(isDestructiveCheckCommand("busybox", ["rm", "x"]), true);
  assert.equal(isDestructiveCheckCommand("go", ["test"]), false);

  const configuredNode: CheckCommandContext = {
    configuredSpawnChecks: [{ cmd: "node", args: ["build.js"] }],
    activeStacks: [],
  };
  assert.ok(
    evaluateSpawnCheckCommand("node", ["build.js"], configuredNode).blockedPattern,
    "code executor neleidžiamas net deklaruotas",
  );

  const configuredRuff: CheckCommandContext = {
    configuredSpawnChecks: [{ cmd: "ruff", args: ["check", "."] }],
    activeStacks: [],
  };
  assert.equal(evaluateSpawnCheckCommand("ruff", ["check", "."], configuredRuff).blockedPattern, undefined);
  assert.ok(evaluateSpawnCheckCommand("ruff", ["check"], configuredRuff).blockedPattern, "argumentai turi sutapti tiksliai");
});

test("check allowlist: template'ai pagal aktyvų stack'ą, exec flag'ai blokuojami", () => {
  assert.equal(evaluateSpawnCheckCommand("go", ["test", "./..."], GO_CTX).blockedPattern, undefined);
  assert.ok(
    evaluateSpawnCheckCommand("go", ["test", "./..."], EMPTY_CHECK_COMMAND_CONTEXT).blockedPattern,
    "neaktyvus stack'as — template negalioja",
  );
  assert.ok(evaluateSpawnCheckCommand("go", ["test", "-exec", "sh"], GO_CTX).blockedPattern, "-exec blokuojamas");
  assert.equal(baseExecutable('"C:\\tools\\node.exe."'), "node", "Windows normalizacija");
  assert.deepEqual(checkStacksForLanguage("TypeScript"), ["javascript"]);
  assert.deepEqual(checkStacksForLanguage("nežinoma"), []);
});

test("quality-command-policy: JS package manager forma griežtesnė", () => {
  assert.equal(evaluateSpawnQualityCommand("pnpm", ["--dir", "apps/web", "test"]).blockedPattern, undefined);
  assert.equal(evaluateSpawnQualityCommand("npm", ["run", "typecheck"]).blockedPattern, undefined);
  assert.match(
    evaluateSpawnQualityCommand("pnpm", ["--dir", "../evil", "test"]).blockedPattern ?? "",
    /spawn working directory/,
  );
  assert.match(evaluateSpawnQualityCommand("pnpm", ["test", "lint"]).blockedPattern ?? "", /spawn arguments/);
  assert.match(evaluateSpawnQualityCommand("pnpm", ["test;rm"]).blockedPattern ?? "", /shell syntax/);
  assert.match(evaluateSpawnQualityCommand("git", ["reset", "--hard"]).blockedPattern ?? "", /destructive/);
});

const POLICY_JSON = {
  task: { checks: ["pnpm typecheck", { cmd: "ruff", args: ["check", "."] }] },
  feature: { checks: [] },
  milestone: { checks: ["pnpm test"] },
  wave: { typecheck: { cmd: "tsc", args: ["-p", "tsconfig.json", "--noEmit"] } },
};

test("quality-policy: schema, resolveriai ir konteksto sudarymas", () => {
  const policy = qualityPolicySchema.parse(POLICY_JSON);
  const checks = resolveQualityChecks(policy, "task");
  assert.deepEqual(checks[0], { kind: "shell", display: "pnpm typecheck" });
  assert.deepEqual(checks[1], { kind: "spawn", display: "ruff check .", cmd: "ruff", args: ["check", "."] });

  const wave = resolveWaveGateCommands(policy);
  assert.deepEqual(wave.typecheck, { cmd: "tsc", args: ["-p", "tsconfig.json", "--noEmit"] });
  assert.deepEqual(resolveWaveGateCommands(qualityPolicySchema.parse({ task: {}, feature: {}, milestone: {} })), {});

  const spawnChecks = collectConfiguredSpawnChecks(policy);
  assert.equal(spawnChecks.length, 2, "scope spawn check + wave gate komanda");

  const ctx = resolveCheckCommandContext(policy, { language: "typescript", selectedLanguage: "go" });
  assert.deepEqual(ctx.activeStacks.sort(), ["go", "javascript"]);
  assert.deepEqual(resolveCheckCommandContext(undefined, undefined), EMPTY_CHECK_COMMAND_CONTEXT);
});

test("loadQualityPolicy: trūkstamas failas ir blogas JSON — klaidos, validus — parse", async () => {
  const files = new Map<string, string>();
  const fs = { readTextFileIfExists: async (p: string) => files.get(p.replace(/\\/g, "/")) };
  await assert.rejects(() => loadQualityPolicy(fs, "/repo/vq"), /quality-policy not found/);
  files.set("/repo/vq/config/quality-policy.json", "{ negaliojantis");
  await assert.rejects(() => loadQualityPolicy(fs, "/repo/vq"), /not valid JSON/);
  files.set("/repo/vq/config/quality-policy.json", JSON.stringify(POLICY_JSON));
  const policy = await loadQualityPolicy(fs, "/repo/vq");
  assert.equal(resolveQualityChecks(policy, "milestone").length, 1);
});

const IDENTITY: GatesMemoIdentity = {
  key: gatesMemoKey({ tree: "t1", dist: "d1", config: "c1", scope: "task", commands: ["pnpm test"] }),
  tree: "t1",
  dist: "d1",
  config: "c1",
};

test("gates-memo: raktas deterministinis, memoCovers reikalauja pilno sutapimo, schema strict", () => {
  assert.equal(
    IDENTITY.key,
    gatesMemoKey({ tree: "t1", dist: "d1", config: "c1", scope: "task", commands: ["pnpm test"] }),
  );
  const record = gatesMemoRecordFor(IDENTITY, "task", ["pnpm test"], "2026-08-20T00:00:00Z");
  assert.equal(gatesMemoRecordSchema.safeParse(record).success, true);
  assert.equal(gatesMemoRecordSchema.safeParse({ ...record, extra: 1 }).success, false, "nežinomas laukas = memo nėra");

  const hit: GatesMemoReadResult = { status: "hit", record };
  assert.equal(memoCovers(hit, IDENTITY, "task", ["pnpm test"]), true);
  assert.equal(memoCovers({ status: "absent" }, IDENTITY, "task", ["pnpm test"]), false);
  assert.equal(memoCovers(hit, IDENTITY, "task", ["pnpm lint"]), false, "kitos komandos — ne cover");
  assert.equal(memoCovers(hit, { ...IDENTITY, tree: "t2" }, "task", ["pnpm test"]), false);
});

type MemoState = { identity: GatesMemoIdentity | null; read: GatesMemoReadResult; writes: unknown[]; cleared: number };

function makePorts(input: {
  checks?: unknown[];
  runnerExit?: number | ((display: string) => number);
  memo?: MemoState;
  identifyAfterTree?: string;
}): { ports: QualityGatesPorts; statuses: QualityGatesStatus[]; logs: string[]; runnerCalls: string[] } {
  const statuses: QualityGatesStatus[] = [];
  const logs: string[] = [];
  const runnerCalls: string[] = [];
  const memo = input.memo;
  let identifyCalls = 0;
  const memoPort: GatesMemoPort | undefined = memo
    ? {
        identify: async () => {
          identifyCalls += 1;
          if (memo.identity === null) return null;
          if (identifyCalls > 1 && input.identifyAfterTree) {
            return { ...memo.identity, tree: input.identifyAfterTree };
          }
          return memo.identity;
        },
        read: async () => memo.read,
        write: async (_root, record) => void memo.writes.push(record),
        clear: async () => void (memo.cleared += 1),
      }
    : undefined;
  const ports: QualityGatesPorts = {
    loadPolicy: async () =>
      qualityPolicySchema.parse({ task: { checks: input.checks ?? ["pnpm test"] }, feature: {}, milestone: {} }),
    commandContext: async () => EMPTY_CHECK_COMMAND_CONTEXT,
    runner: async (check) => {
      runnerCalls.push(check.display);
      const exit = typeof input.runnerExit === "function" ? input.runnerExit(check.display) : (input.runnerExit ?? 0);
      return { code: exit, stdout: `out:${check.display}`, stderr: "" };
    },
    writeStatus: async (status) => void statuses.push(status),
    writeChecksLog: async (text) => void logs.push(text),
    loadLocalEnv: async () => ({}),
    ...(memoPort ? { memoPort } : {}),
  };
  return { ports, statuses, logs, runnerCalls };
}

function emptyMemo(): MemoState {
  return { identity: IDENTITY, read: { status: "absent" }, writes: [], cleared: 0 };
}

test("runQualityGates: be komandų — has_commands=false ir exit 1", async () => {
  const { ports, statuses } = makePorts({ checks: [] });
  const status = await runQualityGates(ports, ["--scope", "feature"]);
  assert.equal(status.has_commands, false);
  assert.equal(status.exit_code, 1);
  assert.equal(statuses.length, 1);
  assert.throws(() => parseQualityScope(["--scope", "banana"]), /Usage: verqestra quality-gates/);
});

test("runQualityGates: memo hit praleidžia suite; --no-memo paleidžia pilną ir atnaujina antspaudą", async () => {
  const record = gatesMemoRecordFor(IDENTITY, "task", ["pnpm test"], "anksčiau");
  const memo = { ...emptyMemo(), read: { status: "hit", record } as GatesMemoReadResult };
  const { ports, runnerCalls } = makePorts({ memo });
  const status = await runQualityGates(ports, []);
  assert.equal(status.passed, true);
  assert.match(status.message ?? "", /QUALITY GATES PASSED: memo/);
  assert.equal(runnerCalls.length, 0, "suite nepaleistas");

  const memo2 = { ...emptyMemo(), read: { status: "hit", record } as GatesMemoReadResult };
  const { ports: ports2, runnerCalls: calls2 } = makePorts({ memo: memo2 });
  const full = await runQualityGates(ports2, ["--no-memo"]);
  assert.equal(full.passed, true);
  assert.equal(calls2.length, 1, "--no-memo paleidžia pilną suite");
  assert.equal(memo2.writes.length, 1, "šviežias žalias rezultatas atnaujina memo");
});

test("runQualityGates: sugadintas memo — garsi pastaba ir pilnas suite; raudonas — memo išvalomas", async () => {
  const memo = { ...emptyMemo(), read: { status: "corrupted", errors: ["bad json"] } as GatesMemoReadResult };
  const { ports, logs, runnerCalls } = makePorts({ memo });
  await runQualityGates(ports, []);
  assert.equal(runnerCalls.length, 1);
  assert.match(logs[0] ?? "", /memo ignoruotas — sugadintas įrašas/);

  const redMemo = emptyMemo();
  const { ports: redPorts } = makePorts({ memo: redMemo, runnerExit: 1 });
  const red = await runQualityGates(redPorts, []);
  assert.equal(red.passed, false);
  assert.deepEqual(red.failed_gates, ["task-1"]);
  assert.equal(redMemo.cleared, 1, "raudonas verdiktas išvalo memo");
  assert.equal(redMemo.writes.length, 0);
});

test("runQualityGates: žalias antspaudas rašomas tik stabiliam medžiui", async () => {
  const memo = emptyMemo();
  const { ports } = makePorts({ memo });
  await runQualityGates(ports, []);
  assert.equal(memo.writes.length, 1, "žalias run'as įrašo memo");

  const movedMemo = emptyMemo();
  const { ports: movedPorts, logs } = makePorts({ memo: movedMemo, identifyAfterTree: "kitas-medis" });
  await runQualityGates(movedPorts, []);
  assert.equal(movedMemo.writes.length, 0, "pajudėjęs medis — memo nerašomas");
  assert.equal(movedMemo.cleared, 1);
  assert.match(logs[0] ?? "", /medis pasikeitė vartų vykdymo metu/);
});

test("runQualityGates: politikos užblokuota komanda gauna 126 be runner'io kvietimo", async () => {
  const { ports, runnerCalls } = makePorts({ checks: ["rm -rf dist", "pnpm test"] });
  const status = await runQualityGates(ports, []);
  assert.equal(status.passed, false);
  assert.equal(status.results[0]?.exit_code, 126);
  assert.match(status.results[0]?.stderr ?? "", /blocked by shell policy/);
  assert.deepEqual(runnerCalls, ["pnpm test"], "užblokuota komanda nevykdoma");
  assert.match(renderChecksLog(status), /=== task-1 ===/);
});

test("check allowlist: `node --test <kelias>` leidžiamas, bet TIK ta forma", () => {
  // 2026-08-22, VQ-802 pilotas: loop'o vartai atmesdavo kiekvieną benchmark scenarijaus patikrą
  // (`spawn executable: node`), tad celė baigdavosi human-review net ištaisiusi bugą. JavaScript
  // buvo vienintelis stack'as be jokio šablono — projektas be `package.json` neturėjo NĖ VIENO
  // vartų kelio, o vartai, kurie niekada negali suveikti, yra blogiau nei viena leista forma.
  const js: CheckCommandContext = { configuredSpawnChecks: [], activeStacks: ["javascript"] };

  assert.equal(
    evaluateSpawnCheckCommand("node", ["--test", "test/i18n.test.mjs"], js).blockedPattern,
    undefined,
    "scenarijaus patikros forma",
  );
  assert.equal(
    evaluateSpawnCheckCommand("node", ["--test"], js).blockedPattern,
    undefined,
    "be kelio — visi projekto testai",
  );

  // Riba. Kiekviena eilutė žemiau yra atskiras kodo vykdymo kelias, ir nė vienas jų neatsidaro.
  assert.ok(
    evaluateSpawnCheckCommand("node", ["-e", "require('fs').rmSync('.', {recursive:true})"], js)
      .blockedPattern,
    "`-e` niekada nebuvo ir nėra leistinas",
  );
  assert.ok(
    evaluateSpawnCheckCommand("node", ["--test", "-e", "payload"], js).blockedPattern,
    "`-e` PO `--test` vis tiek įvykdytų kodą",
  );
  assert.ok(
    evaluateSpawnCheckCommand("node", ["--test", "--import", "./payload.mjs"], js).blockedPattern,
    "`--import` prikrauna modulį, kurio testai neįvardijo",
  );
  assert.ok(
    evaluateSpawnCheckCommand("node", ["--require", "./payload.js", "--test"], js).blockedPattern,
    "`--test` privalo būti PIRMAS argumentas",
  );
  assert.ok(
    evaluateSpawnCheckCommand("node", ["script.js"], js).blockedPattern,
    "paprastas skriptas nėra patikra",
  );
  assert.ok(
    evaluateSpawnCheckCommand("node", ["--test", "test/x.mjs"], EMPTY_CHECK_COMMAND_CONTEXT)
      .blockedPattern,
    "neaktyvus JS stack'as — šablonas negalioja",
  );

  // Deklaravimas `quality-policy.json` NEATRAKINA `node`: šablonas yra vienintelis kelias, ir jis
  // nekonfigūruojamas. Priešingu atveju politikos failo pakeitimas taptų kodo vykdymo vektoriumi.
  const configured: CheckCommandContext = {
    configuredSpawnChecks: [{ cmd: "node", args: ["-e", "payload"] }],
    activeStacks: [],
  };
  assert.ok(
    evaluateSpawnCheckCommand("node", ["-e", "payload"], configured).blockedPattern,
    "code executor lieka blokuojamas ir deklaruotas",
  );
});
