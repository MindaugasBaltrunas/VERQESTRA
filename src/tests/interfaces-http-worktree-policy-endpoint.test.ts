// `POST /api/runtime/worktree-policy` maršrutas (088-ba-02).
//
// `setWorktreePolicyEnabled` elgesys (konfigo laukų pernešimas, `.gitignore` lietimas tik įjungiant)
// jau pin'intas `interfaces-http-worktree-policy.test.ts`. Čia tikrinamas TIK maršrutas:
//
//   1. Kūne priimamas LYGIAI vienas laukas — `enabled: boolean`. Kelias ar bet koks kitas laukas
//      yra 400, o ne tyliai praleistas: 200 su nepritaikytu `root` klientui yra melas.
//   2. Be surišto porto maršruto NĖRA (`undefined`), o ne tuščias „ok".
//   3. Netinkamas kūnas nepalieka NĖ VIENO rašymo — 400 turi būti bevaisis.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { handlePost } from "../interfaces/http/ui-router-mutations.js";
import type { UiRouteRequest, UiRouteResponse, UiRouterDeps, UiRouterPorts } from "../interfaces/http/ui-router-model.js";
import type { WorktreePolicyPorts } from "../interfaces/http/ui-worktree-policy.js";

const ROUTE = "/api/runtime/worktree-policy";
const ROOT = path.resolve("/repo");
const CONFIG_FILE = path.join(ROOT, "vq", "config", "worktree-policy.json");
const GITIGNORE_FILE = path.join(ROOT, ".gitignore");

type World = {
  deps: UiRouterDeps;
  files: Map<string, string>;
  writes: string[];
  reads: string[];
  errors: string[];
  logs: string[];
};

/** Nekviečiamas portas: netikėtas kvietimas turi kristi testu, o ne grąžinti tylų `undefined`. */
function unusedPort(name: string): () => never {
  return () => {
    throw new Error(`unexpected port call: ${name}`);
  };
}

function worktreePolicyWorld(options: { withPorts?: boolean; config?: string } = {}): World {
  const files = new Map<string, string>();
  files.set(CONFIG_FILE, options.config ?? '{\n  "enabled": false,\n  "root": ".ag/worktrees"\n}\n');
  const world: World = {
    files,
    writes: [],
    reads: [],
    errors: [],
    logs: [],
    deps: undefined as unknown as UiRouterDeps,
  };

  const worktreePolicy: WorktreePolicyPorts = {
    readConfigFile: (file) => {
      world.reads.push(`config:${file}`);
      const content = files.get(file);
      if (content === undefined) return Promise.reject(new Error(`ENOENT: ${file}`));
      return Promise.resolve(content);
    },
    writeConfigFile: (file, content) => {
      world.writes.push(`config:${file}`);
      files.set(file, content);
      return Promise.resolve();
    },
    readGitignore: (file) => {
      world.reads.push(`gitignore:${file}`);
      return Promise.resolve(files.get(file));
    },
    writeGitignore: (file, content) => {
      world.writes.push(`gitignore:${file}`);
      files.set(file, content);
      return Promise.resolve();
    },
    log: (message) => world.logs.push(message),
  };

  const ports: UiRouterPorts = {
    dashboardData: unusedPort("dashboardData"),
    listPolicyProposals: unusedPort("listPolicyProposals"),
    proposePolicyChange: unusedPort("proposePolicyChange"),
    decidePolicyProposal: unusedPort("decidePolicyProposal"),
    tokenUsage: unusedPort("tokenUsage"),
    logs: unusedPort("logs"),
    tokenAnalytics: unusedPort("tokenAnalytics"),
    reliabilityAnalytics: unusedPort("reliabilityAnalytics"),
    benchmarkReport: unusedPort("benchmarkReport"),
    compressionView: unusedPort("compressionView"),
    setCompressionFeature: unusedPort("setCompressionFeature"),
    workflowBuckets: unusedPort("workflowBuckets"),
    workflowBucketTasks: unusedPort("workflowBucketTasks"),
    wavesView: unusedPort("wavesView"),
    decideLearningRecommendation: unusedPort("decideLearningRecommendation"),
    openTaskBucketFolder: unusedPort("openTaskBucketFolder"),
    uploadQueueFiles: unusedPort("uploadQueueFiles"),
    ensureLoopRunning: unusedPort("ensureLoopRunning"),
    requestLoopStop: unusedPort("requestLoopStop"),
    drainAllSlots: unusedPort("drainAllSlots"),
    resetLoopControl: unusedPort("resetLoopControl"),
    setRequestedWorkers: unusedPort("setRequestedWorkers"),
    setSlotMode: unusedPort("setSlotMode"),
    applyTaskTriage: unusedPort("applyTaskTriage"),
    hasStaticAssets: () => false,
    logError: (message) => world.errors.push(message),
    ...(options.withPorts === false ? {} : { worktreePolicy }),
  };

  world.deps = {
    ports,
    projectRoot: ROOT,
    uiToken: "sesijos-token",
    eventLimitFromQuery: () => 50,
    platform: "linux",
  };
  return world;
}

function postBody(body: unknown): UiRouteRequest {
  return {
    method: "POST",
    url: ROUTE,
    headers: { host: "127.0.0.1:4173" },
    readJsonBody: () => Promise.resolve(body),
    readRawBody: () => Promise.resolve(JSON.stringify(body)),
  };
}

const jsonBody = (response: UiRouteResponse | undefined): unknown =>
  response?.kind === "json" ? response.data : undefined;

test("įjungimas: 200 su { enabled, gitignore_ok } ir įrašytu konfigu", async () => {
  const world = worktreePolicyWorld();

  const response = await handlePost(world.deps, ROUTE, postBody({ enabled: true }));

  assert.equal(response?.kind === "json" ? response.status : undefined, 200);
  assert.deepEqual(jsonBody(response), { enabled: true, gitignore_ok: true });
  assert.deepEqual(JSON.parse(world.files.get(CONFIG_FILE) ?? "{}"), {
    enabled: true,
    root: ".ag/worktrees",
  });
});

test("įjungimas: `.gitignore` gauna worktree eilutę, jei jos nebuvo", async () => {
  const world = worktreePolicyWorld();
  world.files.set(GITIGNORE_FILE, "node_modules/\n");

  await handlePost(world.deps, ROUTE, postBody({ enabled: true }));

  assert.ok(world.writes.includes(`gitignore:${GITIGNORE_FILE}`));
  assert.match(world.files.get(GITIGNORE_FILE) ?? "", /^node_modules\/\n/);
  assert.match(world.files.get(GITIGNORE_FILE) ?? "", /\.ag\/worktrees\/\n$/);
});

test("išjungimas: `.gitignore` neskaitomas ir nerašomas", async () => {
  const world = worktreePolicyWorld({ config: '{ "enabled": true }' });

  const response = await handlePost(world.deps, ROUTE, postBody({ enabled: false }));

  assert.deepEqual(jsonBody(response), { enabled: false, gitignore_ok: true });
  assert.deepEqual(
    world.reads.concat(world.writes).filter((entry) => entry.startsWith("gitignore:")),
    [],
  );
  assert.deepEqual(JSON.parse(world.files.get(CONFIG_FILE) ?? "{}"), { enabled: false });
});

test("be surišto porto maršruto NĖRA: `undefined`, ne tylus ok", async () => {
  const world = worktreePolicyWorld({ withPorts: false });

  const response = await handlePost(world.deps, ROUTE, postBody({ enabled: true }));

  assert.equal(response, undefined);
  assert.deepEqual(world.writes, []);
});

test("kelias kūne yra 400, ne tyliai praleistas laukas", async () => {
  const world = worktreePolicyWorld();

  const response = await handlePost(
    world.deps,
    ROUTE,
    postBody({ enabled: true, root: "C:/kitas/kelias" }),
  );

  assert.equal(response?.kind === "json" ? response.status : undefined, 400);
  assert.match(String((jsonBody(response) as { error?: string }).error), /unknown field: root/);
  assert.deepEqual(world.writes, [], "400 turi būti bevaisis");
});

test("netinkamas `enabled` tipas yra 400 be jokio rašymo", async () => {
  for (const body of [{ enabled: "true" }, { enabled: 1 }, {}, null, [], "enabled"]) {
    const world = worktreePolicyWorld();

    const response = await handlePost(world.deps, ROUTE, postBody(body));

    assert.equal(response?.kind === "json" ? response.status : undefined, 400, JSON.stringify(body));
    assert.deepEqual(world.writes, [], JSON.stringify(body));
  }
});

test("sugadintas konfigas yra 500 su žurnalo eilute, ne 400", async () => {
  const world = worktreePolicyWorld({ config: "{ nevalidus json" });

  const response = await handlePost(world.deps, ROUTE, postBody({ enabled: true }));

  // 500 keliauja kaip ŽALIAS TEKSTAS (`INTERNAL_ERROR_RESPONSE`) — konfigo parse klaidos tekstas
  // klientui neišeina, jis lieka tik žurnale.
  assert.deepEqual(response, { kind: "text", status: 500, text: "Internal server error" });
  assert.equal(world.errors.length, 1);
  assert.deepEqual(world.writes, []);
});
