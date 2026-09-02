// `/api/**` ATSAKYMŲ VOKŲ testai (2026-08-23 UI audito antras ratas).
//
// Kodėl atskiras failas nuo `interfaces-http-router.test.ts`: tas pin'ina VARTUS (kas praleidžia,
// kas atmeta), o šis — KONTRAKTĄ SU KLIENTU. Auditas rado keturis maršrutus, kuriuose vartai
// veikė nepriekaištingai, o kūnas buvo ne tos formos: `ui-app/src/model/api.ts` skaito
// `data.loop`, `data.worker_request`, `data.proposals`, ir bendrinis kūnas be šių raktų klientui
// atrodo kaip `undefined` — ekrane pasirodo sėkmė ten, kur jos nebuvo.
//
// Antra šio failo pusė — STATUSAI. Vartotojo klaida (netinkamas `requested`, nepatvirtintas
// pasiūlymas, human-review maršrutas) niekada nėra 500: 500 pasako „serveris sugedo", o
// operatorius tada ieško ne ten, kur problema.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { handleUiRequest, type UiRouterDeps, type UiRouterPorts } from "../interfaces/http/ui-router.js";
import { UI_TOKEN_HEADER } from "../interfaces/http/ui-security.js";
import { InvalidWorkerRequestError } from "../application/scheduling/worker-request-store.js";
import { InvalidLoopControlError } from "../application/scheduling/loop-control-store.js";
import { UnsupportedPolicyFileError } from "../application/policy-governance/policy-file-registry.js";
import {
  HumanReviewApprovalRequiredError,
  ProposalNoOpError,
  ProposalNotApprovedError,
} from "../application/policy-governance/policy-proposal-service.js";

const ROOT = path.resolve("/repo");
const TOKEN = "sesijos-token";

type Recorded = { name: string; payload: unknown };

type World = {
  deps: UiRouterDeps;
  calls: Recorded[];
  errors: string[];
  throwOn: Map<string, Error>;
};

function world(): World {
  const state: World = { calls: [], errors: [], throwOn: new Map(), deps: undefined as unknown as UiRouterDeps };

  const record = <T>(name: string, payload: unknown, value: T): Promise<T> => {
    state.calls.push({ name, payload });
    const failure = state.throwOn.get(name);
    return failure ? Promise.reject(failure) : Promise.resolve(value);
  };

  const ports: UiRouterPorts = {
    dashboardData: () => record("dashboard", null, {}),
    listPolicyProposals: () => record("proposals", null, { proposals: [] }),
    proposePolicyChange: (group, input) => record("propose", { group, input }, { proposal: { group } }),
    decidePolicyProposal: (verb, input) => record("decide", { verb, input }, { proposals: [] }),
    tokenUsage: (query) => record("token-usage", query.toString(), { records: [] }),
    logs: (query) =>
      record("logs", query.toString(), query.get("log") === "claude"
        ? { log: "claude", lines: [], truncated: false }
        // Nežinomas vardas grąžina `undefined` — maršrutas iš to privalo padaryti 400.
        : undefined),
    tokenAnalytics: () => record("token-analytics", null, { groups: [], candidates: [], history: [] }),
    reliabilityAnalytics: (fresh) => record("reliability", { fresh }, {}),
    benchmarkReport: () => record("benchmark", null, {}),
    compressionView: () => record("compression-view", null, {}),
    setCompressionFeature: (feature, value) => record("compression-set", { feature, value }, {}),
    workflowBuckets: () => record("buckets", null, []),
    workflowBucketTasks: (bucket) => record("bucket", bucket, { name: bucket, tasks: [], totalCount: 0 }),
    wavesView: (limit) => record("waves", limit, {}),
    decideLearningRecommendation: (id) => record("learning", id, {}),
    openTaskBucketFolder: () => record("folder", null, true),
    uploadQueueFiles: () => record("upload", null, ["0001.md"]),
    ensureLoopRunning: () => record("loop-start", null, { status: "started", pid: 7 }),
    requestLoopStop: () => record("loop-stop", null, { status: "stop-requested", pid: 7 }),
    drainAllSlots: () => record("drain", null, { slots: { w1: { mode: "drain" }, w2: { mode: "drain" } } }),
    resetLoopControl: () => record("reset", null, { slots: { w1: { mode: "run" }, w2: { mode: "run" } } }),
    setRequestedWorkers: (body) => record("workers", body, { requested: 2, source: "state" }),
    setSlotMode: (workerId, body) => record("slot", { workerId, body }, { slots: {} }),
    applyTaskTriage: (action, reference) => record("triage", { action, reference }, {}),
    hasStaticAssets: () => false,
    logError: (message) => state.errors.push(message),
  };

  state.deps = {
    ports,
    projectRoot: ROOT,
    uiToken: TOKEN,
    eventLimitFromQuery: () => 50,
    platform: "linux",
  };
  return state;
}

function post(state: World, url: string, body: unknown = {}): Promise<{ kind: string; status?: number; data?: unknown }> {
  return handleUiRequest(state.deps, {
    method: "POST",
    url,
    headers: { host: "127.0.0.1:4173", [UI_TOKEN_HEADER]: TOKEN },
    readJsonBody: () => Promise.resolve(body),
    readRawBody: () => Promise.resolve(""),
  });
}

function get(state: World, url: string): Promise<{ kind: string; status?: number; data?: unknown }> {
  return handleUiRequest(state.deps, {
    method: "GET",
    url,
    headers: { host: "127.0.0.1:4173", [UI_TOKEN_HEADER]: TOKEN },
    readJsonBody: () => Promise.resolve(null),
    readRawBody: () => Promise.resolve(""),
  });
}

function called(state: World, name: string): Recorded | undefined {
  return state.calls.find((entry) => entry.name === name);
}

test("`/tasks/resume` grąžina `{ loop }` — klientas skaito BŪTENT šį raktą", async () => {
  const state = world();
  const response = await post(state, "/tasks/resume");

  assert.equal(response.status, 200);
  // Be voko `result.status` kliente yra `undefined`, ir nepavykęs paleidimas atrodo kaip sėkmė.
  assert.deepEqual(response.data, { loop: { status: "started", pid: 7 } });
});

test("`/tasks/stop` grąžina `{ loop, loop_control }` ir DRENUOJA slot'us", async () => {
  const state = world();
  const response = await post(state, "/tasks/stop");

  const data = response.data as { loop: { status: string }; loop_control: { slots: Record<string, unknown> } };
  assert.equal(data.loop.status, "stop-requested");
  // Be šito srautų valdiklis po „Stop" liktų rodyti `run`: snapshot'as prieštarautų vėliavai.
  assert.deepEqual(data.loop_control.slots, { w1: { mode: "drain" }, w2: { mode: "drain" } });
  assert.ok(called(state, "drain"));
});

test("`/tasks/stop`: valdiklio klaida NEPAVERČIA atsakymo 500 — vėliava jau įrašyta", async () => {
  const state = world();
  state.throwOn.set("drain", new Error("loop-control.json unreadable"));
  const response = await post(state, "/tasks/stop");

  assert.equal(response.status, 200);
  const data = response.data as { loop: { status: string }; loop_control: unknown };
  assert.equal(data.loop.status, "stop-requested");
  // `null` reiškia „valdiklio būsenos nežinome", ne „valdiklis tvarkoje".
  assert.equal(data.loop_control, null);
});

test("`/api/runtime/loop/start`: `workers` VIRSTA prašymu, valdiklis atstatomas, vokas pilnas", async () => {
  const state = world();
  const response = await post(state, "/api/runtime/loop/start", { workers: 2 });

  // Iki audito antro rato kūnas buvo IGNORUOJAMAS: operatoriaus „2 srautai" dingdavo tyliai.
  assert.deepEqual(called(state, "workers")?.payload, { requested: 2 });
  // Valdiklio atstatymas PRIVALO įvykti prieš procesą: likusi `drain` vėliava priverstų ką tik
  // paleistą loop'ą atsisakyti pirmo task'o.
  const order = state.calls.map((entry) => entry.name);
  assert.deepEqual(order, ["workers", "reset", "loop-start"]);

  const data = response.data as Record<string, unknown>;
  assert.ok("loop" in data && "worker_request" in data && "loop_control" in data);
});

test("`/api/runtime/loop/start`: `requested` yra svetimas laukas — 400, o ne tylus perrašymas", async () => {
  const state = world();
  const response = await post(state, "/api/runtime/loop/start", { workers: 1, requested: 2 });

  assert.equal(response.status, 400);
  assert.match(JSON.stringify(response.data), /requested/);
  // Nė vienas portas nekviestas: atmetimas įvyksta PRIEŠ rašymą.
  assert.equal(state.calls.length, 0);
});

test("`/api/runtime/workers` grąžina `{ worker_request }`, o netinkama reikšmė — 400", async () => {
  const state = world();
  assert.deepEqual(await post(state, "/api/runtime/workers", { requested: 2 }).then((r) => r.data), {
    worker_request: { requested: 2, source: "state" },
  });

  const invalid = world();
  invalid.throwOn.set("workers", new InvalidWorkerRequestError("requested must be an integer between 1 and 2"));
  const response = await post(invalid, "/api/runtime/workers", { requested: 9 });
  // Vartotojo klaida NIEKADA nėra 500: 500 nukreiptų operatorių ieškoti serverio gedimo.
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(response.data), /between 1 and 2/);
  assert.equal(invalid.errors.length, 0, "atpažinta vartotojo klaida žurnale yra triukšmas");
});

test("`/api/runtime/loop/slots/<id>`: netinkamas režimas — 400", async () => {
  const state = world();
  state.throwOn.set("slot", new InvalidLoopControlError("unknown slot mode: turbo"));
  const response = await post(state, "/api/runtime/loop/slots/w1", { mode: "turbo" });

  assert.equal(response.status, 400);
  assert.match(JSON.stringify(response.data), /turbo/);
});

test("`/api/policies/<grupė>/set` egzistuoja ir paduoda TIK kliento laukus", async () => {
  const state = world();
  const response = await post(state, "/api/policies/coding-principles/set", {
    setting_id: "dry",
    requested_value: "error",
    reason: "auditas",
  });

  assert.equal(response.status, 200);
  // Iki audito antro rato šio maršruto NEBUVO: kiekvienas politikų valdiklis gaudavo 404.
  assert.deepEqual(called(state, "propose")?.payload, {
    group: "coding-principles",
    input: { setting_id: "dry", requested_value: "error", reason: "auditas" },
  });
});

test("pasiūlymas be `setting_id` — 400, `reason` neprivalomas, o `routing` iš kliento NEPRIIMAMAS", async () => {
  const state = world();
  assert.equal((await post(state, "/api/policies/enforcement/set", { requested_value: true })).status, 400);
  assert.equal(state.calls.length, 0);

  // `reason` NUSTOJO būti privalomas (operatoriaus patvirtintas kontrakto pakeitimas, 2026-08-28):
  // trūkstamas virsta `""` dar maršrute, tad use-case'as visada gauna tris laukus — vienas
  // kontraktas vietoj „kartais be `reason`".
  const noReason = world();
  assert.equal((await post(noReason, "/api/policies/enforcement/set", { setting_id: "dry" })).status, 200);
  assert.deepEqual(called(noReason, "propose")?.payload, {
    group: "enforcement",
    input: { setting_id: "dry", requested_value: undefined, reason: "" },
  });

  // Suklastotas `routing` niekada nepasiekia use-case'o: maršrutas perduoda tik tris laukus, tad
  // human-review vartų prie `apply` apeiti neįmanoma.
  const forged = world();
  await post(forged, "/api/policies/architecture-style/set", {
    setting_id: "style",
    requested_value: "hexagonal",
    reason: "auditas",
    routing: "queue",
    old_value: "melas",
  });
  assert.deepEqual(called(forged, "propose")?.payload, {
    group: "architecture-style",
    input: { setting_id: "style", requested_value: "hexagonal", reason: "auditas" },
  });
});

test("sprendimo maršrutas: `{ proposals }` vokas, `actor` iš kliento NEPRIIMAMAS", async () => {
  const state = world();
  const response = await post(state, "/api/policies/proposals/approve", {
    policy_file: "vq/architecture/coding-principles.json",
    setting_id: "dry",
    reason: "auditas",
    actor: "piktavalis",
  });

  assert.deepEqual(response.data, { proposals: [] });
  assert.deepEqual(called(state, "decide")?.payload, {
    verb: "approve",
    input: { policy_file: "vq/architecture/coding-principles.json", setting_id: "dry", reason: "auditas" },
  });
});

// 2026-09-02 operatoriaus radinys „Patvirtinti neveikia": pasiūlymai nuo 2026-08-28 eina be
// priežasties, o klientas sprendimui siunčia PASIŪLYMO priežastį — tuščią. Sprendimo maršrutas
// jos reikalavo, tad kiekvienas toks pasiūlymas iš UI buvo nepatvirtinamas (400).
test("sprendimo maršrutas: tuščia ar trūkstama `reason` NĖRA 400 — sprendimas eina su `\"\"`", async () => {
  const empty = world();
  const response = await post(empty, "/api/policies/proposals/approve", {
    policy_file: "vq/architecture/coding-principles.json",
    setting_id: "dry",
    reason: "",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(called(empty, "decide")?.payload, {
    verb: "approve",
    input: { policy_file: "vq/architecture/coding-principles.json", setting_id: "dry", reason: "" },
  });

  const missing = world();
  await post(missing, "/api/policies/proposals/reject", {
    policy_file: "vq/architecture/coding-principles.json",
    setting_id: "dry",
  });
  assert.deepEqual(called(missing, "decide")?.payload, {
    verb: "reject",
    input: { policy_file: "vq/architecture/coding-principles.json", setting_id: "dry", reason: "" },
  });

  // Objektas be `setting_id` toliau atmetamas: sprendimas be nustatymo neturi ko spręsti.
  const noSetting = world();
  const rejected = await post(noSetting, "/api/policies/proposals/approve", {
    policy_file: "vq/architecture/coding-principles.json",
  });
  assert.equal(rejected.status, 400);
  assert.equal(called(noSetting, "decide"), undefined);
});

test("governance klaidos gauna SAVO statusą: 400 / 409 / 403", async () => {
  const body = { policy_file: "vq/architecture/coding-principles.json", setting_id: "dry", reason: "auditas" };
  const cases: [Error, number][] = [
    [new UnsupportedPolicyFileError("vq/nezinomas.json"), 400],
    [new ProposalNotApprovedError("vq/architecture/coding-principles.json", "dry"), 409],
    [new HumanReviewApprovalRequiredError("vq/architecture/coding-principles.json", "dry", "/marker"), 403],
  ];

  for (const [error, status] of cases) {
    const state = world();
    state.throwOn.set("decide", error);
    const response = await post(state, "/api/policies/proposals/apply", body);
    assert.equal(response.status, status, `${error.name} privalo duoti ${status}`);
    // 403 čia yra atsisakymas suteikti teisę, ne būsenos konfliktas: pasiūlymas maršrutizuotas į
    // human-review, o UI nėra tas žmogus.
    assert.equal(state.errors.length, 0);
  }
});

// Pasiūlymo maršrutas naudoja TĄ PATĮ `mapPolicyDecisionError`, tad jo statusų aibė turi būti
// pin'inama atskirai: iki 2026-08-31 audito P1 pataisos jis pro save praleisdavo tik registro ir
// schemos klaidas, ir no-op sėkmingai grįždavo 200 su beprasmiu žurnalo įrašu.
test("pasiūlymo maršruto klaidos: no-op — 409, netinkama reikšmė — 400", async () => {
  const noOp = new ProposalNoOpError("vq/architecture/architecture-style.json", "style", "layered");
  const cases: [Error, number][] = [
    [noOp, 409],
    [new UnsupportedPolicyFileError("vq/nezinomas.json"), 400],
  ];

  for (const [error, status] of cases) {
    const state = world();
    state.throwOn.set("propose", error);
    const response = await post(state, "/api/policies/architecture-style/set", {
      setting_id: "style",
      requested_value: "layered",
      reason: "auditas",
    });
    assert.equal(response.status, status, `${error.name} privalo duoti ${status}`);
    // 409 čia yra būsenos konfliktas, ne įvesties forma: `"layered"` yra teisėta reikšmė ir ta
    // pati užklausa taps priimtina, vos tik dabartinė reikšmė pasikeis.
    assert.deepEqual(response.data, { error: error.message });
    assert.equal(state.errors.length, 0);
  }
});

test("neatpažinta sprendimo klaida yra 500 BE detalių, bet SU žurnalo eilute", async () => {
  const state = world();
  state.throwOn.set("decide", new Error("D:/vq/state/policy/decisions.jsonl locked"));
  const response = await post(state, "/api/policies/proposals/reject", {
    policy_file: "vq/architecture/coding-principles.json",
    setting_id: "dry",
    reason: "auditas",
  });

  assert.equal(response.status, 500);
  assert.doesNotMatch(JSON.stringify(response), /decisions\.jsonl/);
  assert.equal(state.errors.some((line) => line.includes("decisions.jsonl")), true);
});

test("`?fresh=1` pasiekia patikimumo analitiką — tai Atnaujinti mygtuko prasmė", async () => {
  const cached = world();
  await get(cached, "/api/reliability-analytics");
  assert.deepEqual(called(cached, "reliability")?.payload, { fresh: false });

  const fresh = world();
  await get(fresh, "/api/reliability-analytics?fresh=1");
  assert.deepEqual(called(fresh, "reliability")?.payload, { fresh: true });
});

test("`/api/token-usage` query pasiekia portą nepakeista", async () => {
  const state = world();
  await get(state, "/api/token-usage?model=sonnet&phase=implementation&limit=50&offset=10");

  assert.equal(called(state, "token-usage")?.payload, "model=sonnet&phase=implementation&limit=50&offset=10");
});
