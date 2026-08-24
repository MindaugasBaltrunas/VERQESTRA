import assert from "node:assert/strict";
import test from "node:test";
import { AgLoopUiHttpAdapter } from "../infrastructure/ag-loop-ui-http-adapter.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas): antra `ag-loop-read-models.test.ts` pusė.
 *
 * Ten — grynos projekcijos, kurioms nereikia nieko išorinio. Čia — ADAPTERIS prieš `fetch`
 * dublį: kokie keliai kviečiami ir kokiu metodu, kaip clampinamos ribos, ką daro SSE srautas
 * su sugadintu kadru, nutrūkusiu upstream'u ir atšaukimu.
 *
 * NUKRYPIMAS (VERQESTRA vardai, ne elgesys): bootstrap meta žyma yra `vq-ui-token`, ne
 * etalono `ag-ui-token` — VERQESTRA UI kontraktas pervadintas E6 metu
 * (`src/interfaces/http/ui-security.ts`).
 */

const UI_TOKEN_META_NAME = "vq-ui-token";

/**
 * Canaries planted in every upstream fixture below. Deliberately restated here
 * rather than shared with the projection suite: the two files must be able to
 * fail independently, and a shared fixture module is one more thing that can
 * drift out from under a proof.
 */
const SECRET_CANARY = "ghp_" + "0123456789abcdefghijklmnopqrstuvwx";
const PATH_CANARY = "D:/private/workspace/AG";
const POSIX_PATH_CANARY = "/home/operator/secrets";
const UI_TOKEN = "a".repeat(43);

function leakFree(value: unknown): void {
  const wire = JSON.stringify(value) ?? "";
  for (const canary of [SECRET_CANARY, PATH_CANARY, POSIX_PATH_CANARY, UI_TOKEN]) {
    assert.equal(wire.includes(canary), false, `${canary} reached the mobile DTO`);
  }
}

function bootstrapPage(): Response {
  return new Response(`<meta name="${UI_TOKEN_META_NAME}" content="${UI_TOKEN}">`, { status: 200 });
}

type UpstreamRoutes = Readonly<Record<string, unknown>>;

/** Fake AG Loop UI: bootstrap page plus a JSON answer per allowlisted path. */
function fakeAgUi(routes: UpstreamRoutes, calls: { method: string; path: string }[]): typeof fetch {
  return (async (input, init) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method ?? "GET", path: url.pathname + url.search });
    if (url.pathname === "/") {
      return bootstrapPage();
    }
    const payload = routes[url.pathname];
    if (payload === undefined) {
      return new Response("not found", { status: 404 });
    }
    return Response.json(payload);
  }) as typeof fetch;
}

test("every extended read is a GET against an allowlisted AG UI path", async () => {
  const calls: { method: string; path: string }[] = [];
  const adapter = new AgLoopUiHttpAdapter("http://127.0.0.1:4173", fakeAgUi({
    "/api/dashboard": {
      controlPlane: {
        policy_controls: [{ group: "dispatch", label: "Dispatch", controls: [] }],
        learning_summary: { records: 3 },
        learning_recommendations: [],
      },
    },
    "/api/logs": { lines: [`boot ${SECRET_CANARY}`], truncated: false },
    "/api/token-usage": { records: [{ ts: "2026-08-06T10:00:00.000Z", task_id: "1135" }] },
    "/api/token-analytics": { candidates: [], history: [] },
  }, calls));

  leakFree(await adapter.logs("claude", 50));
  leakFree(await adapter.tokenUsage(25));
  leakFree(await adapter.tokenAnalytics());
  leakFree(await adapter.policyControls());
  leakFree(await adapter.learning());

  assert.ok(calls.every((call) => call.method === "GET"), "the channel is read-only");
  assert.deepEqual(calls.map((call) => call.path), [
    "/",
    "/api/logs?log=claude&lines=50",
    "/api/token-usage?limit=25",
    "/api/token-analytics",
    "/api/dashboard",
    "/api/dashboard",
  ]);
});

test("task names travel as bare, redacted file names on every host platform", async () => {
  const adapter = new AgLoopUiHttpAdapter("http://127.0.0.1:4173", fakeAgUi({
    "/api/tasks": {
      tasks: [
        "D:\\private\\workspace\\AG\\tasks\\queue\\1135-read-only-proxy.md",
        "/home/operator/AG/tasks/queue/1136-followup.md",
        `1137-noisy${String.fromCharCode(0x1b)}[2J.md`,
      ],
      totalCount: 3,
    },
  }, []));
  const projected = await adapter.taskBucket("queue");
  assert.deepEqual(projected.tasks, [
    "1135-read-only-proxy.md",
    "1136-followup.md",
    "1137-noisy.md",
  ]);
  leakFree(projected);
});

test("out-of-range read bounds are clamped before they reach the AG Loop UI", async () => {
  const calls: { method: string; path: string }[] = [];
  const adapter = new AgLoopUiHttpAdapter("http://127.0.0.1:4173", fakeAgUi({
    "/api/logs": { lines: [] },
    "/api/token-usage": { records: [] },
  }, calls));
  await adapter.logs("claude", 100_000);
  await adapter.tokenUsage(100_000);
  assert.deepEqual(calls.slice(1).map((call) => call.path), [
    "/api/logs?log=claude&lines=200",
    "/api/token-usage?limit=500",
  ]);
});

test("task bucket projection keeps names only, never the host location they live at", async () => {
  const calls: { method: string; path: string }[] = [];
  const adapter = new AgLoopUiHttpAdapter("http://127.0.0.1:4173", fakeAgUi({
    "/api/tasks": {
      tasks: [
        `${PATH_CANARY}\\tasks\\queue\\1135-read-only-proxy.md`,
        `${POSIX_PATH_CANARY}/leaked.md`,
        `${SECRET_CANARY}.md`,
        42,
        ...Array.from({ length: 120 }, (_, index) => `bulk-${index}.md`),
      ],
      // Fields the AG Loop UI may add later, and a count that contradicts itself.
      totalCount: -5,
      root: PATH_CANARY,
      files: [`${PATH_CANARY}\\tasks\\queue\\1135-read-only-proxy.md`],
    },
  }, calls));

  const projected = await adapter.taskBucket("queue");

  assert.deepEqual(Object.keys(projected).sort(), ["bucket", "tasks", "totalCount"]);
  assert.equal(projected.bucket, "queue");
  assert.deepEqual(projected.tasks.slice(0, 3), [
    "1135-read-only-proxy.md",
    "leaked.md",
    "[REDACTED].md",
  ]);
  assert.equal(projected.tasks.length, 100, "the list a phone renders stays bounded");
  assert.equal(projected.totalCount, 100, "a hostile count degrades to what was actually sent");
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    "GET /",
    "GET /api/tasks?bucket=queue",
  ]);
  leakFree(projected);
});

test("an unknown log name never becomes an upstream request", async () => {
  const adapter = new AgLoopUiHttpAdapter("http://127.0.0.1:4173", async () => {
    throw new Error("fetch must not be called");
  });
  await assert.rejects(
    () => adapter.logs("../../etc/passwd" as never, 10),
    /Invalid AG Loop log name/,
  );
});

function sseResponse(frames: readonly string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(new TextEncoder().encode(frame));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function take<T>(source: AsyncIterable<T>, count: number): Promise<T[]> {
  const taken: T[] = [];
  for await (const item of source) {
    taken.push(item);
    if (taken.length === count) break;
  }
  return taken;
}

test("the activity stream sanitises frames, reports keepalives and reconnects", async () => {
  let connections = 0;
  const fetchImpl = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/") {
      return bootstrapPage();
    }
    connections += 1;
    return sseResponse([
      ": keepalive\n\n",
      `data: ${JSON.stringify({
        chain: ["coder"],
        currentActivity: `Bash(deploy ${SECRET_CANARY})`,
        mode: "inline",
        updatedAt: "2026-08-06T10:00:00.000Z",
        root: PATH_CANARY,
      })}\n\n`,
      "data: {not json}\n\n",
    ]);
  }) as typeof fetch;

  const abort = new AbortController();
  const adapter = new AgLoopUiHttpAdapter("http://127.0.0.1:4173", fetchImpl, 50, 1);
  const messages = await take(adapter.activityStream(abort.signal), 4);
  abort.abort();

  assert.equal(messages[0]?.type, "keepalive");
  assert.equal(messages[1]?.type, "activity");
  const activity = messages[1]?.type === "activity" ? messages[1].activity : undefined;
  assert.deepEqual(activity?.chain, ["coder"]);
  assert.match(activity?.currentActivity ?? "", /\[REDACTED\]/);
  leakFree(activity);
  // A malformed frame is skipped, the stream ends cleanly and is re-opened.
  assert.equal(messages[2]?.type, "keepalive");
  assert.ok(connections >= 2, "a clean upstream end must be reconnected");
});

test("the activity stream gives up after repeated upstream failures", async () => {
  const fetchImpl = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/") {
      return bootstrapPage();
    }
    return new Response("upstream is gone", { status: 500 });
  }) as typeof fetch;
  const abort = new AbortController();
  const adapter = new AgLoopUiHttpAdapter("http://127.0.0.1:4173", fetchImpl, 50, 1);
  // NUKRYPIMAS (VERQESTRA vardas, ne elgesys): etalone žinutė sakė „AG Loop UI". Šiame
  // adapteryje upstream yra VERQESTRA UI — todėl ir `vq-ui-token` — ir visos 12 klaidų žinučių
  // vadina jį taip nuosekliai. Testas seka kodą, o ne atvirkščiai: nuoseklus vardas yra
  // teisingas, o vienas išsišokęs „AG Loop UI" būtų buvęs migracijos likutis.
  await assert.rejects(
    () => take(adapter.activityStream(abort.signal), 50),
    /VERQESTRA UI activity stream is unavailable/,
  );
});

test("aborting the caller signal ends the activity stream without an error", async () => {
  const abort = new AbortController();
  const adapter = new AgLoopUiHttpAdapter("http://127.0.0.1:4173", (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/") {
      return bootstrapPage();
    }
    abort.abort();
    return sseResponse([]);
  }) as typeof fetch, 50, 1);
  const messages = await take(adapter.activityStream(abort.signal), 10);
  assert.deepEqual(messages, []);
});
