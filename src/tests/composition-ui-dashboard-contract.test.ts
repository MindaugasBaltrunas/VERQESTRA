// `/api/dashboard` SMOKE testas ant TIKRO serverio ir TIKRŲ adapterių (2026-08-23 UI paleidimo
// auditas, P0-3).
//
// Audito išvada buvo ne „kodas blogas", o „vartų nėra": 46 UI testų failai ir 393 testai buvo
// žali, nes kiekvienas kontrakto galas turėjo savo pramanytus duomenis. Nė vienas testas
// nepaleido serverio ir nepaklausė, KĄ jis realiai atiduoda naršyklei.
//
// Čia paleidžiamas visas kelias — `node:http` kiautas, gryna maršrutizavimo funkcija, realūs
// failų adapteriai — ir tikrinama forma, kurią gauna `ui-app`. Naršyklės čia nėra sąmoningai:
// ji šio repo toolchain'e neegzistuoja, o renderio pusę dengia `ui-app/src/App.test.tsx`.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { handleUiRequest } from "../interfaces/http/ui-router.js";
import { normalizeEventLimit } from "../interfaces/http/ui-waves-view.js";
import type { SseHub } from "../interfaces/http/sse-service.js";
import { createUiServer, listenUiServer } from "../composition/ui/server.js";
import { uiRouterPorts } from "../composition/ui/router-adapters.js";

/**
 * Laukai, kuriuos `ui-app/src/model/dashboardViewModel.ts` dereferencina BE saugiklio.
 *
 * Veidrodis: `ui-app/src/model/dashboardContract.ts`. Sąrašas dubliuojamas todėl, kad paketai
 * turi atskirus toolchain'us; abi pusės viena į kitą nurodo, kad pakeitimas viename be kito
 * neliktų nepastebėtas.
 */
const CLIENT_REQUIRED_FIELDS = [
  "root",
  "currentTaskId",
  "currentTaskFile",
  "claudeExit",
  "stableRef",
  "stopStatus",
  "decision",
  "supervisorResume",
  "claudeResume",
  "runtime",
  "claudeLogUpdatedAt",
  "claudeLogBytes",
  "workflowBuckets",
] as const;

const UI_TOKEN = "dashboard-contract-token";

const inertHub: SseHub = {
  addClient: () => Promise.resolve(),
  clientCount: () => 0,
  checkAndBroadcast: () => Promise.resolve(),
};

type Sandbox = { projectRoot: string; runtimeRoot: string; agRoot: string };

async function makeSandbox(): Promise<Sandbox> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "vq-ui-dashboard-"));
  const runtimeRoot = path.join(projectRoot, "vq");
  const agRoot = path.join(projectRoot, "AG");
  await mkdir(path.join(agRoot, "tasks", "queue"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "state"), { recursive: true });
  return { projectRoot, runtimeRoot, agRoot };
}

async function withDashboardServer(
  sandbox: Sandbox,
  run: (base: string, errors: string[]) => Promise<void>,
): Promise<void> {
  const errors: string[] = [];
  const ports = uiRouterPorts({ ...sandbox, logError: (message) => errors.push(message) });
  const server = createUiServer({
    route: (request) =>
      handleUiRequest(
        {
          ports,
          projectRoot: sandbox.projectRoot,
          uiToken: UI_TOKEN,
          eventLimitFromQuery: (query) => normalizeEventLimit(query.get("limit")),
        },
        {
          method: request.method,
          url: request.url,
          headers: request.headers,
          readJsonBody: () => Promise.resolve(null),
          readRawBody: () => Promise.resolve(request.body),
        },
      ),
    uiToken: UI_TOKEN,
    sse: inertHub,
    logError: (message) => errors.push(message),
  });
  const listening = await listenUiServer(server, 0);
  try {
    await run(`http://127.0.0.1:${listening.port}`, errors);
  } finally {
    await listening.close();
  }
}

function fetchDashboard(base: string): Promise<Response> {
  return fetch(`${base}/api/dashboard`, { headers: { "x-vq-ui-token": UI_TOKEN } });
}

test("GET /api/dashboard grąžina PILNĄ dashboard snapshot'ą, ne vieną jo bloką", async () => {
  const sandbox = await makeSandbox();
  try {
    await writeFile(path.join(sandbox.agRoot, "tasks", "queue", "0001-pirma.md"), "# 0001\n", "utf8");

    await withDashboardServer(sandbox, async (base) => {
      const response = await fetchDashboard(base);
      assert.equal(response.status, 200);
      const data = (await response.json()) as Record<string, unknown>;

      for (const field of CLIENT_REQUIRED_FIELDS) {
        assert.ok(field in data, `atsakyme trūksta '${field}' — klientas jį skaito be saugiklio`);
        assert.notEqual(data[field], undefined, `laukas '${field}' yra undefined`);
      }

      // Konkretus 2026-08-23 gedimas: `dashboardViewModel.adaptOverview` pirmuoju veiksmu skaito
      // `data.stopStatus.status`. Kai serveris grąžindavo `UiControlPlaneData`, čia buvo
      // `undefined`, ir visas React medis nulūždavo prieš pirmą renderį.
      assert.equal(typeof data["stopStatus"], "object");
      assert.notEqual(data["stopStatus"], null);

      // Control-plane yra ĮDĖTAS blokas, o ne pats atsakymas — tai ir buvo kontrakto nesutapimas.
      const controlPlane = data["controlPlane"] as Record<string, unknown> | undefined;
      assert.ok(controlPlane, "controlPlane privalo būti atsakymo VIDUJE");
      assert.ok(Array.isArray(controlPlane["human_review_tasks"]));
      assert.ok(Array.isArray(controlPlane["config_controls"]));
      // `loop_controls` ir `live_slots` PAŠALINTI 2026-08-24: pirmasis siuntė maršrutus, kuriuos
      // klientas turi savo `api.ts`, antrasis buvo miręs IR nešė absoliutų `worktree_path` į
      // naršyklę. Vartas laiko juos pašalintus — kitaip jie grįžtų kaip „naudingas kontekstas".
      assert.equal("loop_controls" in controlPlane, false);
      assert.equal("live_slots" in controlPlane, false);
      assert.equal("queueCounts" in data, false, "dublikatas `workflowBuckets[].totalCount`");
      // `envOverride` PAŠALINTAS 2026-08-24: jis visada lygus `source === "env"`, klientas
      // `canEdit` išveda iš `source`, ir jo neskaitė NIEKAS nė vienoje pusėje.
      const workerControl = data["workerControl"] as Record<string, unknown>;
      assert.equal("envOverride" in workerControl, false, "dublikatas `source === \"env\"`");
      assert.ok("source" in workerControl, "`source` yra vienintelis šio fakto pavidalas");
      assert.equal(JSON.stringify(data).includes("worktree_path"), false, "kelias į naršyklę neišeina");
      // Senoji (klaidinga) forma turėjo šiuos laukus ŠAKNYJE. Jei jie ten atsirastų dar kartą,
      // regresija būtų tiksliai ta pati.
      assert.equal(data["human_review_tasks"], undefined);
      assert.equal(data["config_controls"], undefined);

      const buckets = data["workflowBuckets"] as { name: string; totalCount: number }[];
      assert.equal(buckets.find((bucket) => bucket.name === "queue")?.totalCount, 1);

      // Tuščias `degraded` yra dalis kontrakto: švarioje projekto kopijoje nė vienas šaltinis
      // neturi kristi. Įvardytas sąrašas čia yra ir gedimo pranešimas, ir jo priežastis.
      assert.deepEqual(data["degraded"], []);
    });
  } finally {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  }
});

test("dashboard snapshot'as atspindi realią būseną iš vq/state", async () => {
  const sandbox = await makeSandbox();
  try {
    const stateDir = path.join(sandbox.runtimeRoot, "state");
    await mkdir(path.join(sandbox.agRoot, "tasks", "active"), { recursive: true });
    await writeFile(path.join(sandbox.agRoot, "tasks", "active", "0007-vykdoma.md"), "# 0007\n", "utf8");
    await writeFile(path.join(stateDir, "current-task-id"), "0007-vykdoma\n", "utf8");
    await writeFile(path.join(stateDir, "claude-last-exit-code"), "0\n", "utf8");
    await writeFile(path.join(stateDir, "stable-ref"), "abcdef1234567890\n", "utf8");
    await mkdir(path.join(sandbox.runtimeRoot, "supervisor"), { recursive: true });
    await writeFile(
      path.join(sandbox.runtimeRoot, "supervisor", "decision.json"),
      JSON.stringify({ verdict: "done", reason: "gates passed" }),
      "utf8",
    );

    await withDashboardServer(sandbox, async (base) => {
      const data = (await (await fetchDashboard(base)).json()) as Record<string, unknown>;

      assert.equal(data["currentTaskId"], "0007-vykdoma");
      assert.equal(data["currentTaskBucket"], "active");
      assert.equal(data["currentTaskState"], "active");
      assert.equal(data["claudeExit"], "0");
      assert.equal(data["stableRef"], "abcdef1234567890");
      assert.deepEqual(data["decision"], { verdict: "done", reason: "gates passed" });

      // Loop'as neregistruotas — savo įrašą valdančiam procesui tai reiškia „sustojęs", ne
      // „nežinia": kitaip UI užrakintų mygtuką „Paleisti ciklą" po kiekvieno švaraus sustojimo.
      const runtime = data["runtime"] as { name: string; status: string }[];
      assert.equal(runtime.find((entry) => entry.name === "AG loop")?.status, "stopped");
      assert.equal((data["loopControl"] as { loop: { status: string } }).loop.status, "stopped");
    });
  } finally {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  }
});

test("dashboard'as be token'o neatiduodamas", async () => {
  const sandbox = await makeSandbox();
  try {
    await withDashboardServer(sandbox, async (base) => {
      const response = await fetch(`${base}/api/dashboard`);
      assert.equal(response.status, 403);
      // Būsena į naršyklę be token'o neišeina jokia forma.
      assert.equal((await response.text()).includes("stopStatus"), false);
    });
  } finally {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  }
});
