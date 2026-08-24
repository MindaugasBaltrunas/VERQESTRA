import assert from "node:assert/strict";
import test from "node:test";
import { AgLoopUiHttpAdapter } from "../infrastructure/ag-loop-ui-http-adapter.js";
// SKAIDYMAS: etalone `projectDashboardPayload` gyveno adapteryje (596 eil.); VERQESTRA'oje
// projekcijos iškeltos į `ag-loop-ui-projections.ts`, tad testas importuoja iš ten. Adapteris
// jos NEreeksportuoja — reeksportas būtų dviguba durys į tą patį simbolį.
import { projectDashboardPayload } from "../infrastructure/ag-loop-ui-projections.js";

/**
 * NUKRYPIMAS (VERQESTRA vardai, ne elgesys): etalonas tikrino `ag-ui-token` meta žymą ir
 * `x-ag-ui-token` antraštę. VERQESTRA UI E6 metu abu pervadinti į `vq-ui-token` /
 * `x-vq-ui-token` (`src/interfaces/http/ui-security.ts`), tad tas pats pavadinimas naudojamas
 * ir čia — testas su etalono vardais tikrintų nebeegzistuojantį kontraktą.
 */
const UI_TOKEN_META_NAME = "vq-ui-token";
const UI_TOKEN_HEADER = "x-vq-ui-token";

test("dashboard projection drops mutation metadata, paths and raw logs", () => {
  const projected = projectDashboardPayload({
    root: "D:/secret/repo",
    currentTaskId: "123-safe-task",
    currentTaskState: "active",
    // Serverio forma, ne išgalvota: VERQESTRA UI siunčia `workflowBuckets[]`, o `queueCounts`
    // pašalintas 2026-08-24. Sena fikstūra tiekė būtent tą lauką, kurio serveris nebesiunčia —
    // dėl to telefone visi skaitikliai buvo nuliai, o abu paketų rinkiniai atskirai žali.
    // `injected` čia lieka kaip nežinomas bucket'as: projekcija privalo jo neišleisti.
    workflowBuckets: [
      { name: "queue", tasks: ["0042-a.md"], totalCount: 2 },
      { name: "failed", tasks: [], totalCount: 1 },
      { name: "injected", tasks: [], totalCount: 999 },
    ],
    runtime: [
      { name: "AG UI", status: "running", pid: 42 },
      { name: "D:/secret/process", status: "running" },
    ],
    claudeLog: "TOKEN=secret",
    controlPlane: {
      loop_controls: [{ endpoint: "/tasks/stop", method: "POST" }],
      human_review_tasks: [{ file: "AG/tasks/human-review/1.md", actions: ["approve"] }],
    },
  }, new Date("2026-07-26T10:00:00.000Z"));
  assert.deepEqual(projected.runtime, [{ name: "AG UI", status: "running" }]);
  assert.equal(projected.reviewCount, 1);
  assert.equal(projected.queueCounts["queue"], 2);
  assert.equal(projected.queueCounts["injected"], undefined);
  const wire = JSON.stringify(projected);
  assert.doesNotMatch(wire, /secret|loop_controls|endpoint|actions|pid/i);
});

test("adapter bootstraps an in-memory token and refreshes once after 403", async () => {
  // `exactOptionalPropertyTypes`: `token` čia yra „yra, bet gali būti neapibrėžtas", ne
  // „gali nebūti lauko" — todėl `| undefined`, o ne `?`.
  const calls: Array<{ url: string; method: string; token: string | undefined }> = [];
  let bootstrap = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      token: new Headers(init?.headers).get(UI_TOKEN_HEADER) ?? undefined,
    });
    if (new URL(url).pathname === "/") {
      bootstrap += 1;
      return new Response(
        `<meta name="${UI_TOKEN_META_NAME}" content="${bootstrap === 1 ? "a".repeat(43) : "b".repeat(43)}">`,
        { status: 200 },
      );
    }
    if (calls.filter((call) => new URL(call.url).pathname === "/api/dashboard").length === 1) {
      return new Response("forbidden", { status: 403 });
    }
    return Response.json({
      currentTaskId: null,
      currentTaskState: "none",
      workflowBuckets: [],
      runtime: [],
      controlPlane: { human_review_tasks: [] },
    });
  };
  const adapter = new AgLoopUiHttpAdapter("http://127.0.0.1:4173", fakeFetch);
  const dashboard = await adapter.dashboard();
  assert.equal(dashboard.availability, "online");
  assert.equal(bootstrap, 2);
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.equal(calls.at(-1)?.token, "b".repeat(43));
  assert.doesNotMatch(JSON.stringify(dashboard), /a{20}|b{20}/);
});

test("a redirected AG Loop UI is refused, and the adapter never leaves the loopback origin", async () => {
  // AGREAD-04. `redirect: "manual"` is what keeps a redirect a status code
  // instead of a second, unvalidated request to whatever origin the Location
  // header names — an AG UI that a local proxy has taken over could otherwise
  // send the in-memory UI token off-host. Every request must carry it, and a
  // 3xx must surface as a failure rather than as data.
  for (const status of [301, 302, 303, 307, 308]) {
    const requests: Array<{ url: string; redirect: string | undefined }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), redirect: init?.redirect });
      return new Response(null, {
        status,
        headers: { location: "http://attacker.example/api/dashboard" },
      });
    };
    const adapter = new AgLoopUiHttpAdapter("http://127.0.0.1:4173", fakeFetch);
    await assert.rejects(adapter.dashboard(), new RegExp(`bootstrap failed with status ${status}`));
    // Exactly the bootstrap request, and it did not follow the Location header.
    assert.equal(requests.length, 1, `status ${status} produced more than the bootstrap request`);
    assert.equal(requests[0]?.redirect, "manual", `status ${status} was fetched with redirects enabled`);
    assert.ok(
      requests.every((request) => new URL(request.url).host === "127.0.0.1:4173"),
      `status ${status} left the loopback origin`,
    );
  }
});

test("a redirected API read is refused after a successful bootstrap", async () => {
  // The bootstrap succeeding and the API read being redirected is the case a
  // bootstrap-only check would miss: by then the adapter holds a live UI token
  // and would attach it to the followed request.
  const requests: Array<{ url: string; redirect: string | undefined; token: string | undefined }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({
      url,
      redirect: init?.redirect,
      token: new Headers(init?.headers).get(UI_TOKEN_HEADER) ?? undefined,
    });
    if (new URL(url).pathname === "/") {
      return new Response(`<meta name="${UI_TOKEN_META_NAME}" content="${"c".repeat(43)}">`, { status: 200 });
    }
    return new Response(null, { status: 302, headers: { location: "http://attacker.example/api/dashboard" } });
  };
  const adapter = new AgLoopUiHttpAdapter("http://127.0.0.1:4173", fakeFetch);
  await assert.rejects(adapter.dashboard(), /read failed with status 302/);
  assert.ok(
    requests.every((request) => request.redirect === "manual"),
    "an AG UI request was made with redirects enabled",
  );
  assert.ok(
    requests.every((request) => new URL(request.url).host === "127.0.0.1:4173"),
    "the adapter left the loopback origin",
  );
  // A 3xx is not a 401/403, so it must not spend the one re-bootstrap either.
  assert.equal(requests.filter((request) => new URL(request.url).pathname === "/").length, 1);
});

test("adapter rejects non-loopback origins and invalid task buckets", async () => {
  assert.throws(() => new AgLoopUiHttpAdapter("https://example.com"), /loopback/);
  const adapter = new AgLoopUiHttpAdapter("http://localhost:4173", async () => {
    throw new Error("fetch must not be called");
  });
  await assert.rejects(() => adapter.taskBucket("../failed"), /Invalid AG Loop task bucket/);
});
