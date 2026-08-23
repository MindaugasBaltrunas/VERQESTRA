// VQ-503 (5/5-d) testai — dashboard'o maršrutizatorius. Svarbiausia, ką jie pin'ina: VARTŲ TVARKA
// (loopback → tapatybė → API token'as → mutacijų token'as), tapatybės maršrutas be token'o neša TIK
// fingerprint'ą, POST be token'o neįvyksta NIEKADA, įkėlimo sėkmė nevirsta 500 dėl loop'o, o
// nežinomas `/api/**` kelias grąžina JSON 404, ne HTML.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  handleUiRequest,
  type UiRouteRequest,
  type UiRouteResponse,
  type UiRouterDeps,
  type UiRouterPorts,
} from "../interfaces/http/ui-router.js";
import { UI_IDENTITY_ROUTE, UI_IDENTITY_SERVICE, projectFingerprint } from "../interfaces/http/ui-port-rules.js";
import { UI_TOKEN_HEADER } from "../interfaces/http/ui-security.js";
import { InvalidUploadError } from "../interfaces/http/task-upload.js";
import { TaskNotFoundError } from "../interfaces/http/ui-task-actions.js";
import { UnknownTaskBucketError } from "../interfaces/http/workflow-buckets.js";

const ROOT = path.resolve("/repo");
const TOKEN = "sesijos-token";

type RouterWorld = {
  deps: UiRouterDeps;
  calls: string[];
  errors: string[];
  failures: Map<string, Error>;
  hasStatic: boolean;
  uploadResult: string[];
  loopResult: unknown;
  folderOpened: boolean;
};

function routerWorld(): RouterWorld {
  const world: RouterWorld = {
    calls: [],
    errors: [],
    failures: new Map<string, Error>(),
    hasStatic: true,
    uploadResult: ["0042.md"],
    loopResult: { status: "started", pid: 42 },
    folderOpened: true,
    deps: undefined as unknown as UiRouterDeps,
  };

  const record = <T>(name: string, value: T): Promise<T> => {
    world.calls.push(name);
    const failure = world.failures.get(name);
    return failure ? Promise.reject(failure) : Promise.resolve(value);
  };

  const ports: UiRouterPorts = {
    dashboardData: (token) => record("dashboard", { token }),
    listPolicyProposals: () => record("proposals", { proposals: [] }),
    proposePolicyChange: (group, input) => record(`propose:${group}`, { proposal: { group, ...input } }),
    decidePolicyProposal: (verb, input) => record(`decide:${verb}`, { verb, input }),
    tokenUsage: (query) => record("token-usage", { model: query.get("model") }),
    tokenAnalytics: () => record("token-analytics", {}),
    reliabilityAnalytics: (fresh) => record(`reliability:${fresh ? "fresh" : "cached"}`, {}),
    benchmarkReport: () => record("benchmark", {}),
    workflowBuckets: () => record("tasks", []),
    workflowBucketTasks: (bucket) =>
      bucket === "queue"
        ? record(`tasks:${bucket}`, { name: bucket, tasks: [], totalCount: 0 })
        : Promise.reject(new UnknownTaskBucketError(`Unknown task bucket: ${bucket}`)),
    wavesView: (limit) => record("waves", { limit }),
    decideLearningRecommendation: (id, decision) => record("learning", { id, decision }),
    openTaskBucketFolder: (bucket) => record(`folder:${bucket}`, world.folderOpened),
    uploadQueueFiles: () => record("upload", world.uploadResult),
    ensureLoopRunning: () => record("loop-start", world.loopResult),
    requestLoopStop: () => record("loop-stop", { status: "stop-requested" }),
    drainAllSlots: () => record("drain", { slots: { w1: { mode: "drain" }, w2: { mode: "drain" } } }),
    resetLoopControl: () => record("reset-control", { slots: { w1: { mode: "run" }, w2: { mode: "run" } } }),
    setRequestedWorkers: (body) => record("workers", body),
    setSlotMode: (workerId, body) => record(`slot:${workerId}`, body),
    applyTaskTriage: (action, reference) => record(`triage:${action}`, { action, reference }),
    hasStaticAssets: () => world.hasStatic,
    logError: (message) => world.errors.push(message),
  };

  world.deps = {
    ports,
    projectRoot: ROOT,
    uiToken: TOKEN,
    eventLimitFromQuery: (query) => Number.parseInt(query.get("limit") ?? "50", 10),
    platform: "linux",
  };
  return world;
}

function request(over: Partial<UiRouteRequest> & { url: string }): UiRouteRequest {
  return {
    method: "GET",
    headers: { host: "127.0.0.1:4173", [UI_TOKEN_HEADER]: TOKEN },
    readJsonBody: () => Promise.resolve({}),
    readRawBody: () => Promise.resolve("{}"),
    ...over,
  };
}

const jsonBody = (response: UiRouteResponse): unknown => (response.kind === "json" ? response.data : undefined);

test("vartų tvarka: svetimas Host atmetamas PRIEŠ viską, net tapatybės maršrute", async () => {
  const world = routerWorld();
  const response = await handleUiRequest(
    world.deps,
    request({ url: UI_IDENTITY_ROUTE, headers: { host: "evil.example.com" } }),
  );

  assert.deepEqual(response, { kind: "text", status: 403, text: "Forbidden: invalid host" });
  assert.deepEqual(world.calls, []);
});

test("tapatybės maršrutas: be token'o, bet TIK su fingerprint'u", async () => {
  const world = routerWorld();
  const response = await handleUiRequest(
    world.deps,
    request({ url: UI_IDENTITY_ROUTE, headers: { host: "127.0.0.1" } }),
  );

  assert.deepEqual(jsonBody(response), {
    schema_version: 1,
    service: UI_IDENTITY_SERVICE,
    project_fingerprint: projectFingerprint(ROOT, "linux"),
  });
  // Klausiantysis yra KITO projekto orkestratorius — token'o jis pagal apibrėžimą neturi.
});

test("API skaitymai be token'o duoda 403, su token'u — duomenis", async () => {
  const world = routerWorld();
  const forbidden = await handleUiRequest(
    world.deps,
    request({ url: "/api/dashboard", headers: { host: "127.0.0.1" } }),
  );
  assert.equal(forbidden.kind === "text" ? forbidden.status : 0, 403);
  assert.deepEqual(world.calls, []);

  const allowed = await handleUiRequest(world.deps, request({ url: "/api/dashboard" }));
  assert.deepEqual(jsonBody(allowed), { token: TOKEN });
});

test("skaitymo maršrutai: query parametrai perduodami, klaida virsta 500 be detalių", async () => {
  const world = routerWorld();

  const usage = await handleUiRequest(world.deps, request({ url: "/api/token-usage?model=opus" }));
  assert.deepEqual(jsonBody(usage), { model: "opus" });

  const waves = await handleUiRequest(world.deps, request({ url: "/api/waves?limit=7" }));
  assert.deepEqual(jsonBody(waves), { limit: 7 });

  world.failures.set("benchmark", new Error("EACCES /repo/vq/state/benchmark.json"));
  const failed = await handleUiRequest(world.deps, request({ url: "/api/benchmark/report" }));
  assert.deepEqual(failed, { kind: "text", status: 500, text: "Internal server error" });
  // Detalės lieka serverio žurnale, o ne kliento ekrane.
  assert.match(world.errors.join("\n"), /EACCES/);

  const sse = await handleUiRequest(world.deps, request({ url: "/api/events" }));
  assert.deepEqual(sse, { kind: "sse" });
});

test("POST be token'o NEĮVYKSTA niekada — net ne-`/api` kelyje", async () => {
  const world = routerWorld();
  const response = await handleUiRequest(
    world.deps,
    request({ method: "POST", url: "/tasks/resume", headers: { host: "127.0.0.1" } }),
  );

  assert.equal(response.kind === "text" ? response.status : 0, 403);
  assert.deepEqual(world.calls, [], "mutacija neįvyko");
});

test("įkėlimas: failai jau eilėje, tad loop'o klaida NEPAVERČIA atsakymo 500", async () => {
  const world = routerWorld();
  world.failures.set("loop-start", new Error("spawn nepavyko"));

  const response = await handleUiRequest(
    world.deps,
    request({ method: "POST", url: "/tasks/queue/upload", readRawBody: () => Promise.resolve("{}") }),
  );

  assert.equal(response.kind === "json" ? response.status : 0, 201);
  const body = jsonBody(response) as { saved: string[]; loop: { status: string } };
  assert.deepEqual(body.saved, ["0042.md"]);
  assert.equal(body.loop.status, "failed");
});

test("įkėlimo klaida yra VARTOTOJO klaida: 400, ne 500", async () => {
  const world = routerWorld();
  world.failures.set("upload", new InvalidUploadError("Only Markdown files are allowed: a.txt"));

  const response = await handleUiRequest(world.deps, request({ method: "POST", url: "/tasks/queue/upload" }));
  assert.deepEqual(response, {
    kind: "json",
    status: 400,
    data: { error: "Only Markdown files are allowed: a.txt" },
  });
  assert.equal(world.calls.includes("loop-start"), false, "nepavykęs įkėlimas loop'o nepaleidžia");
});

test("mutacijos su kūnu: per didelis kūnas yra 413, sugadintas — 400", async () => {
  const world = routerWorld();
  const tooLarge = Object.assign(new Error("body too large"), { name: "RequestBodyTooLargeError" });

  const large = await handleUiRequest(
    world.deps,
    request({ method: "POST", url: "/api/runtime/workers", readJsonBody: () => Promise.reject(tooLarge) }),
  );
  assert.equal(large.kind === "json" ? large.status : 0, 413);

  const broken = await handleUiRequest(
    world.deps,
    request({ method: "POST", url: "/api/runtime/workers", readJsonBody: () => Promise.reject(new Error("bad json")) }),
  );
  assert.equal(broken.kind === "json" ? broken.status : 0, 400);
  assert.deepEqual(world.calls, [], "netinkamas kūnas saugyklos neliečia");
});

test("parametrizuoti maršrutai: slot'as, triažas, learning ir katalogas", async () => {
  const world = routerWorld();

  await handleUiRequest(
    world.deps,
    request({ method: "POST", url: "/api/runtime/loop/slots/w1", readJsonBody: () => Promise.resolve({ mode: "drain" }) }),
  );
  assert.equal(world.calls.includes("slot:w1"), true);

  const triage = await handleUiRequest(
    world.deps,
    request({ method: "POST", url: "/api/tasks/requeue/0042.md" }),
  );
  assert.deepEqual(jsonBody(triage), { action: "requeue", reference: "0042.md" });

  const learning = await handleUiRequest(
    world.deps,
    request({ method: "POST", url: "/learning/approve/rec-1" }),
  );
  assert.deepEqual(jsonBody(learning), { record: { id: "rec-1", decision: "approved" } });

  const folder = await handleUiRequest(world.deps, request({ method: "POST", url: "/folders/open/done" }));
  assert.deepEqual(folder, { kind: "empty", status: 204 });

  // Nežinomas bucket'as — 404, o ne bandymas atidaryti laisvos formos kelią.
  world.folderOpened = false;
  const unknown = await handleUiRequest(world.deps, request({ method: "POST", url: "/folders/open/..%2Fsecrets" }));
  assert.deepEqual(unknown, { kind: "empty", status: 404 });
});

test("triažo klaida atvaizduojama, o ne virsta 500", async () => {
  const world = routerWorld();
  world.failures.set("triage:complete", new TaskNotFoundError("task '0042.md' was not found in any task bucket"));

  const response = await handleUiRequest(world.deps, request({ method: "POST", url: "/api/tasks/complete/0042" }));
  assert.equal(response.kind === "json" ? response.status : 0, 404);
});

test("nežinomas kelias: `/api/**` duoda JSON 404, o statinis — dist arba tuščią 404", async () => {
  const world = routerWorld();

  const api = await handleUiRequest(world.deps, request({ url: "/api/nera" }));
  assert.deepEqual(api, { kind: "json", status: 404, data: { error: "not found" } });

  const asset = await handleUiRequest(world.deps, request({ url: "/assets/app.js" }));
  assert.deepEqual(asset, { kind: "static", urlPath: "/assets/app.js" });

  world.hasStatic = false;
  const missing = await handleUiRequest(world.deps, request({ url: "/" }));
  assert.deepEqual(missing, { kind: "empty", status: 404 });
});

// Etalono (ir ui-app `fetchWorkflowTasks`) kontraktas: iki 2026-08-23 `bucket` parametras buvo
// ignoruojamas ir klientas vietoje vieno bucket'o objekto gaudavo visų bucket'ų masyvą.
test("/api/tasks: be parametro — apžvalga, ?bucket= — vieno bucket'o sąrašas, nežinomas — 400", async () => {
  const world = routerWorld();

  const overview = await handleUiRequest(world.deps, request({ url: "/api/tasks" }));
  assert.deepEqual(jsonBody(overview), []);
  assert.ok(world.calls.includes("tasks"));

  const single = await handleUiRequest(world.deps, request({ url: "/api/tasks?bucket=queue" }));
  assert.deepEqual(jsonBody(single), { name: "queue", tasks: [], totalCount: 0 });

  const unknown = await handleUiRequest(world.deps, request({ url: "/api/tasks?bucket=nope" }));
  assert.deepEqual(unknown, { kind: "json", status: 400, data: { error: "invalid task bucket" } });
});
