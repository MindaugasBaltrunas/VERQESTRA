// VQ-503 (2/5) testai — control-plane UI modelis ir token biudžeto vaizdas. Svarbiausia, ką jie
// pin'ina: neatpažintas biudžeto turinys duoda „duomenų nėra", o ne tuščią biudžetą su
// melagingais nuliais; laukiantis pasiūlymas prikabinamas prie SAVO valdiklio (naujausias
// laimi); išspręsta rekomendacija nebesiūlo mygtukų; o trūkstamas human-review katalogas nėra
// klaida.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  loadUiControlPlaneData,
  loadUiPolicyControls,
  latestLearningRecommendations,
  toUiStackDecision,
  type ControlPlanePorts,
} from "../interfaces/ui-model/control-plane-model.js";
import { toUiTokenBudget } from "../interfaces/ui-model/token-budget-view.js";
import type { LearningMemoryRecord } from "../application/learning/learning-memory.js";

const ROOT = path.resolve("/repo");
const RUNTIME = path.join(ROOT, "vq");
const PROPOSALS = path.join(RUNTIME, "state", "policy", "proposals.jsonl");
const HUMAN_REVIEW = path.join(ROOT, "AG", "tasks", "human-review");

function fakePorts(files: Record<string, string> = {}): ControlPlanePorts {
  const store = new Map(Object.entries(files));
  return {
    fs: {
      exists: (p) => Promise.resolve(store.has(p)),
      readTextFileIfExists: (p) => Promise.resolve(store.get(p)),
      appendTextFile: () => Promise.resolve(),
      writeTextFile: () => Promise.resolve(),
      makeDirectory: () => Promise.resolve(),
      listFiles: (dir) =>
        Promise.resolve(
          [...store.keys()]
            .filter((key) => path.dirname(key) === dir)
            .map((key) => path.basename(key))
            .sort(),
        ),
    },
  };
}

function proposal(settingId: string, timestamp: string, policyFile = "vq/architecture/architecture-style.json"): string {
  return JSON.stringify({
    policy_file: policyFile,
    setting_id: settingId,
    requested_value: "strict",
    reason: "pagrindimas",
    timestamp,
    routing: "human-review",
  });
}

// ---------------------------------------------------------------------------
// token biudžetas
// ---------------------------------------------------------------------------

test("toUiTokenBudget: neatpažintas turinys duoda undefined, ne tuščią biudžetą", () => {
  assert.equal(toUiTokenBudget(undefined), undefined);
  assert.equal(toUiTokenBudget("tekstas"), undefined);
  assert.equal(toUiTokenBudget([]), undefined);
  // Objektas be nė vieno atpažinto bloko: UI turi matyti „duomenų nėra", o ne nulius.
  assert.equal(toUiTokenBudget({ kitas_raktas: 1 }), undefined);
});

test("toUiTokenBudget: blokai NESULIEJAMI, o nežinomos ribos yra `null`", () => {
  const budget = toUiTokenBudget({
    budget_enforcement: {
      ok: false,
      task_id: "890",
      llm_calls: 4,
      billable_tokens: 1200,
      limits: { max_llm_calls: 10 },
      reasons: ["ceiling", 7],
      soft_reasons: [],
      reduce_context: true,
      profile: "  ",
    },
  });

  assert.equal(budget?.llm_call_authorization, undefined, "antras blokas rašomas savo momentu");
  assert.deepEqual(budget?.budget_enforcement?.limits, {
    max_llm_calls: 10,
    max_total_llm_calls: null,
    max_total_tokens: null,
  });
  // Ne string įrašai iškrenta, o tuščias sąrašas nėra reikšmė.
  assert.deepEqual(budget?.budget_enforcement?.reasons, ["ceiling"]);
  assert.equal(budget?.budget_enforcement?.soft_reasons, undefined);
  // Vien iš tarpų sudarytas tekstas nėra reikšmė.
  assert.equal(budget?.budget_enforcement?.profile, undefined);

  const authorization = toUiTokenBudget({ llm_call_authorization: { allowed: true, remaining_total_tokens: 500 } });
  assert.equal(authorization?.budget_enforcement, undefined);
  assert.equal(authorization?.llm_call_authorization?.remaining_total_tokens, 500);
  assert.equal(authorization?.llm_call_authorization?.remaining_total_llm_calls, null);
});

// ---------------------------------------------------------------------------
// politikų valdikliai
// ---------------------------------------------------------------------------

test("loadUiPolicyControls: trūkstami konfigai duoda numatytąsias reikšmes, ne klaidą", async () => {
  const groups = await loadUiPolicyControls(fakePorts(), RUNTIME);

  assert.deepEqual(
    groups.map((group) => group.group),
    ["architecture-style", "coding-principles", "enforcement"],
  );
  const style = groups[0]?.controls.find((control) => control.id === "style");
  assert.equal(style?.source, "vq/architecture/architecture-style.json");
  assert.equal(style?.route, "/api/policies/architecture-style/set");
  const dry = groups[1]?.controls.find((control) => control.id === "dry");
  assert.deepEqual(dry?.allowed_values, ["advisory", "warn", "block"], "lygių sąrašas ateina iš domain");
});

test("loadUiPolicyControls: laukiantis pasiūlymas kabinamas prie SAVO valdiklio, naujausias laimi", async () => {
  const ports = fakePorts({
    [PROPOSALS]: [
      proposal("style", "2026-08-20T10:00:00.000Z"),
      proposal("style", "2026-08-21T10:00:00.000Z"),
      proposal("dry", "2026-08-21T09:00:00.000Z", "vq/architecture/coding-principles.json"),
    ].join("\n"),
  });

  const groups = await loadUiPolicyControls(ports, RUNTIME);
  const style = groups[0]?.controls.find((control) => control.id === "style");
  assert.equal(style?.pending_proposal?.timestamp, "2026-08-21T10:00:00.000Z");

  // Kitos grupės valdiklis gauna SAVO pasiūlymą, o ne pirmą rastą.
  const dry = groups[1]?.controls.find((control) => control.id === "dry");
  assert.equal(dry?.pending_proposal?.setting_id, "dry");
  const yagni = groups[1]?.controls.find((control) => control.id === "yagni");
  assert.equal(yagni?.pending_proposal, undefined);

  // SUSPAUDIMAS ĮVARDIJAMAS (2026-08-24, operatoriaus radinys). `style` turi DU laukiančius
  // pasiūlymus, valdiklis rodo naujausią — be kiekio politikų suvestinė skaičiuodavo NUSTATYMUS,
  // sprendimų eilė PASIŪLYMUS, abi vadindavo tai tuo pačiu žodžiu, ir skirtumas ekrane atrodė
  // kaip nepaaiškintas dublikatas.
  assert.equal(style?.pending_proposal_count, 2);
  // Vienas pasiūlymas kiekio NEGAUNA: `1` nieko neprideda prie jau matomo pasiūlymo.
  assert.equal(dry?.pending_proposal_count, undefined);
});

// ---------------------------------------------------------------------------
// visas control-plane
// ---------------------------------------------------------------------------

test("loadUiControlPlaneData: git politika, governance ir loop valdikliai", async () => {
  const ports = fakePorts({
    [path.join(RUNTIME, "config", "git-automation-policy.json")]: JSON.stringify({
      auto_commit_enabled: false,
      auto_push_enabled: true,
    }),
  });

  const data = await loadUiControlPlaneData(ports, { projectRoot: ROOT, runtimeRoot: RUNTIME });
  const byId = new Map(data.config_controls.map((control) => [control.id, control]));
  assert.equal(byId.get("auto_commit_enabled")?.value, false);
  assert.equal(byId.get("auto_push_enabled")?.value, true);
  // Trūkstamas governance konfigas yra „missing:N", o ne „ok" — nežinia neatrodo žalia.
  assert.match(String(byId.get("architecture_governance")?.value), /^missing:/);
  // `loop_controls` PAŠALINTAS 2026-08-24: jis siuntė maršrutus, kuriuos klientas turi savo
  // `api.ts` ir skaito iš ten. Serverio siunčiamas endpoint'as be vartotojo atrodo kaip
  // autoritetas, tad pervadinus maršrutą kiltų pagunda taisyti jį, o realus kelias liktų senas.
  assert.equal("loop_controls" in data, false);
  assert.deepEqual(data.human_review_tasks, [], "nesamas katalogas nėra klaida");
  assert.equal(data.stack_decision, undefined);
});

test("loadUiControlPlaneData: human-review užduotys rūšiuojamos ir neša savo laukus", async () => {
  const ports = fakePorts({
    [path.join(HUMAN_REVIEW, "0042.md")]: "# Antra užduotis\n- blocked_by: gates\n- reason: raudoni testai\n",
    [path.join(HUMAN_REVIEW, "0007.md")]: "# Pirma užduotis\n",
    [path.join(HUMAN_REVIEW, "skip.txt")]: "ne užduotis",
  });

  const data = await loadUiControlPlaneData(ports, { projectRoot: ROOT, runtimeRoot: RUNTIME });
  assert.deepEqual(
    data.human_review_tasks.map((task) => task.task_id),
    ["0007", "0042"],
  );
  const second = data.human_review_tasks[1];
  assert.equal(second?.title, "Antra užduotis");
  assert.equal(second?.blocked_by, "gates");
  assert.equal(second?.reason, "raudoni testai");
  // Kelias visada posix forma — UI jį rodo ir siunčia atgal.
  assert.equal(second?.file, "AG/tasks/human-review/0042.md");
  const first = data.human_review_tasks[0];
  assert.equal(first?.blocked_by, undefined);
});

test("latestLearningRecommendations: naujausias įrašas laimi, o išspręsta nesiūlo mygtukų", () => {
  const record = (over: Partial<LearningMemoryRecord>): LearningMemoryRecord => ({
    id: "rec-1",
    ts: "2026-08-20T10:00:00.000Z",
    type: "policy_recommendation",
    summary: "sena",
    labels: [],
    evidence: [],
    ...over,
  });

  const recommendations = latestLearningRecommendations([
    record({}),
    record({ ts: "2026-08-21T10:00:00.000Z", summary: "nauja" }),
    record({ id: "rec-2", recommendation_status: "approved", summary: "patvirtinta" }),
    record({ id: "rec-3", type: "task_outcome", summary: "ne rekomendacija" }),
  ]);

  assert.deepEqual(
    recommendations.map((entry) => entry.id),
    ["rec-1", "rec-2"],
  );
  assert.equal(recommendations[0]?.summary, "nauja");
  assert.deepEqual(recommendations[0]?.actions, ["approve", "reject"]);
  // Jau patvirtinta rekomendacija neturi siūlyti mygtuko, kuris tyliai nieko nedarytų.
  assert.deepEqual(recommendations[1]?.actions, []);
  assert.equal(recommendations[1]?.status, "approved");
});

test("toUiStackDecision: sprendimas verčiamas į snake_case kontraktą be praradimų", () => {
  assert.deepEqual(
    toUiStackDecision({
      selectedLanguage: null,
      selectedFramework: "express",
      architectureStyle: "clean",
      inputSignals: ["package.json"],
      alternativesConsidered: [],
      confidence: "low",
      reason: "nepakanka signalų",
      humanReviewRequired: true,
    }),
    {
      selected_language: null,
      selected_framework: "express",
      architecture_style: "clean",
      confidence: "low",
      human_review_required: true,
      reason: "nepakanka signalų",
    },
  );
});
