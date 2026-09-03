import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoot } from "../../view/AppRoot";

/**
 * PIRMO EKRANO smoke testas (2026-08-23 UI paleidimo auditas, P0-3).
 *
 * Auditas rado, kad 46 testų failai ir 393 testai buvo žali, o dashboard'as neatvaizduodavo net
 * pirmo ekrano: kiekvienas testas konstruodavo `DashboardData` PATS, tad niekas netikrino, kas
 * atsitinka su REALIU serverio atsakymu. Čia mountinamas visas medis (`AppRoot` → `I18nProvider`
 * → `DashboardPage`) su `fetch` stub'u, grąžinančiu tikslią `/api/dashboard` wire formą.
 *
 * Testas turi dvi puses, ir abi būtinos:
 *   1. TEISINGA forma privalo duoti matomą dashboard'ą;
 *   2. SENOJI (klaidinga) forma — `UiControlPlaneData` vietoj `DashboardData` — privalo duoti
 *      matomą KLAIDĄ, o ne tuščią ekraną. Būtent antrasis atvejis ir buvo P0.
 */

/** Serverio `interfaces/http/ui-dashboard-view.ts#UiDashboardData` wire forma. */
const DASHBOARD_PAYLOAD = {
  root: "D:/VERQESTRA",
  currentTaskId: "0042-pavyzdys",
  currentTaskFile: "AG/tasks/active/0042-pavyzdys.md",
  currentTaskBucket: "active",
  currentTaskState: "active",
  claudeExit: "0",
  stableRef: "abcdef1234567890",
  stopStatus: { status: "done", reason: "gates passed", task_id: "0042-pavyzdys" },
  stopStatusSource: "attempt",
  stopStatusCorrupted: false,
  decision: { verdict: "done", reason: "gates passed" },
  supervisorResume: {},
  claudeResume: { updated_at: "2026-08-23T09:00:00.000Z" },
  runtime: [
    { name: "AG UI", pid: 1234, status: "running" },
    { name: "AG loop", status: "stopped", detail: "ui-loop.pid not recorded" },
    { name: "User Claude terminal", status: "unknown", detail: "user-claude.pid not recorded" },
  ],
  claudeLogUpdatedAt: "2026-08-23T09:00:00.000Z",
  claudeLogBytes: 4096,
  claudeLogSource: "legacy",
  workflowBuckets: [
    { name: "queue", tasks: ["0043-kita.md"], totalCount: 1 },
    { name: "active", tasks: ["0042-pavyzdys.md"], totalCount: 1 },
    { name: "human-review", tasks: [], totalCount: 0 },
    { name: "done", tasks: [], totalCount: 0 },
  ],
  queueCounts: { queue: 1, active: 1, "human-review": 0, done: 0 },
  statusFiles: [],
  controlPlane: {
    config_controls: [],
    loop_controls: [
      { id: "resume", label: "Resume loop", endpoint: "/tasks/resume", method: "POST" },
      { id: "stop", label: "Request loop stop", endpoint: "/tasks/stop", method: "POST" },
    ],
    human_review_tasks: [],
    learning_recommendations: [],
    learning_summary: {
      records: 0,
      by_type: {},
      pending_recommendations: 0,
      approved_recommendations: 0,
      rejected_recommendations: 0,
    },
    policy_controls: [],
    live_slots: [],
  },
  workerControl: { requested: 1, source: "state", lastWave: null },
  loopControl: {
    loop: { status: "stopped", stopRequested: false },
    slots: [
      { worker_id: "w1", worker_index: 1, desired: "run", state: "idle", task_id: null, attempt: null, lastWave: null },
      { worker_id: "w2", worker_index: 2, desired: "run", state: "idle", task_id: null, attempt: null, lastWave: null },
    ],
  },
  degraded: [],
};

/**
 * Kaip `/api/dashboard` atrodė IKI pataisymo: control-plane dokumentas be nė vieno dashboard
 * lauko. `adaptOverview` iš jo skaito `data.stopStatus.status` — ir tai yra tikslus gedimas.
 */
const LEGACY_CONTROL_PLANE_PAYLOAD = {
  config_controls: [],
  loop_controls: [],
  human_review_tasks: [],
  learning_recommendations: [],
  learning_summary: {
    records: 0,
    by_type: {},
    pending_recommendations: 0,
    approved_recommendations: 0,
    rejected_recommendations: 0,
  },
  policy_controls: [],
};

/** Tuščios bangos: nė vieno slot'o, tad in-flight eilutės neturi būti. */
const EMPTY_WAVES = { events: [], leases: [], last_rejections: [], degraded: [] };

/** `interfaces/http/ui-waves-view.ts#UiWaveSlot` wire forma; `task_id` gali ateiti ir pilnu keliu. */
function runningSlot(workerId: string, taskId: string) {
  return {
    worker_id: workerId,
    task_id: taskId,
    state: "running",
    lease_status: "active",
    acquired_at: "2026-09-03T09:00:00.000Z",
    heartbeat_at: "2026-09-03T09:01:00.000Z",
    expires_at: "2026-09-03T09:10:00.000Z",
    lease_age_ms: 60_000,
    heartbeat_age_ms: 1_000,
    stale: false,
    has_worktree: true,
    last_failure: null,
  };
}

/** Abu srautai dirba: w1 pirminiame medyje, w2 worktree kopijoje (task failas dar `queue`). */
const LIVE_WAVES = {
  ...EMPTY_WAVES,
  slots: [runningSlot("w1", "0042-pavyzdys"), runningSlot("w2", "AG/tasks/queue/0043-kita.md")],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** `/api/dashboard` grąžina paduotą kūną; `/api/events` lieka neprisijungęs; kiti — tuščia. */
function stubFetch(dashboardBody: unknown, wavesBody: unknown = EMPTY_WAVES): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/dashboard")) return Promise.resolve(jsonResponse(dashboardBody));
      // SSE srautas testuose sąmoningai neprisijungia: hook'as tai parodo kaip `disconnected`,
      // ir tai neturi nuversti puslapio.
      if (url.includes("/api/events")) return Promise.reject(new Error("sse disabled in tests"));
      if (url.includes("/api/policies/proposals")) return Promise.resolve(jsonResponse({ proposals: [] }));
      if (url.includes("/api/waves")) return Promise.resolve(jsonResponse(wavesBody));
      return Promise.resolve(jsonResponse({}));
    }),
  );
}

describe("dashboard pirmas ekranas", () => {
  beforeEach(() => {
    // `requestAnimationFrame` jsdom'e yra, bet SSE hook'as jį naudoja per `useEffect` — cleanup'as
    // testų tarpe nepalieka pakibusio kadro.
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("teisingas serverio atsakymas atvaizduoja apžvalgą, o ne tuščią ekraną", async () => {
    stubFetch(DASHBOARD_PAYLOAD);
    render(<AppRoot />);

    // Numatytoji kalba yra `lt`, tad raktas „System overview" ekrane atrodo taip.
    expect(await screen.findByRole("heading", { name: "Sistemos apžvalga" })).toBeInTheDocument();
    // Apžvalgos metrikos ateina iš tų pačių laukų, kurie anksčiau būdavo `undefined`.
    await waitFor(() => expect(screen.getByText("0042-pavyzdys (active)")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("senoji control-plane forma duoda MATOMĄ klaidą, o ne tuščią ekraną", async () => {
    stubFetch(LEGACY_CONTROL_PLANE_PAYLOAD);
    render(<AppRoot />);

    const alert = await screen.findByRole("alert");
    // Žinutė privalo ĮVARDYTI trūkstamus laukus: „nepavyko" be jų operatoriui neduoda nieko.
    expect(alert.textContent).toContain("stopStatus");
    expect(alert.textContent).toContain("dashboard kontrakto");
  });

  // 2026-08-24 auditas: serveris degradavusį šaltinį ĮVARDIJA, bet klientas lauko neturėjo tipe,
  // tad trūkstamos panelės atrodydavo kaip „nieko nelaukia", o ne kaip gedimas.
  it("degradavęs šaltinis PAVADINAMAS ekrane", async () => {
    stubFetch({ ...DASHBOARD_PAYLOAD, controlPlane: undefined, degraded: ["control_plane"] });
    render(<AppRoot />);

    await waitFor(() =>
      expect(screen.getByText(/Kai kurių dashboard'o šaltinių nepavyko perskaityti/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/control_plane/)).toBeInTheDocument();
  });

  // 2026-09-03: worktree izoliacijoje `queue→active` perėjimas vyksta TIK slot'o kopijoje, tad
  // suvestinės `active` lieka 0, kol dirba abu srautai. Vienintelis gyvas įrodymas yra `/api/waves`.
  it("apžvalgos suvestinė ĮVARDIJA, kurį task'ą suka w1 ir w2", async () => {
    stubFetch(DASHBOARD_PAYLOAD, LIVE_WAVES);
    render(<AppRoot />);

    expect(await screen.findByText("Vykdoma worktree srautuose:")).toBeInTheDocument();
    // Pilnas kelias sunormuojamas iki tos pačios tapatybės, kurią neša kortelė.
    expect(screen.getByText("w1 → 0042-pavyzdys, w2 → 0043-kita")).toBeInTheDocument();
  });

  it("be gyvų slot'ų suvestinė atrodo kaip iki šiol — jokio „0 vykdoma“", async () => {
    stubFetch(DASHBOARD_PAYLOAD);
    render(<AppRoot />);

    expect(await screen.findByRole("heading", { name: "Sistemos apžvalga" })).toBeInTheDocument();
    expect(screen.queryByText("Vykdoma worktree srautuose:")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("`#/tasks` kortelėje sutampantis task id gauna „vykdomas (w1)“ ženklelį", async () => {
    window.location.hash = "#/tasks";
    stubFetch(DASHBOARD_PAYLOAD, LIVE_WAVES);
    render(<AppRoot />);

    await waitFor(() => expect(screen.getByText("vykdomas (w1)")).toBeInTheDocument());
    const items = screen.getAllByRole("listitem").map((item) => item.textContent ?? "");
    expect(items.some((text) => /0042.*vykdomas \(w1\)/.test(text))).toBe(true);
    expect(items.some((text) => /0043.*vykdomas \(w2\)/.test(text))).toBe(true);
    window.location.hash = "";
  });

  it("`#/learning` be control-plane bloko rodo ĮVARDYTĄ būseną, o ne tuščią lapą", async () => {
    window.location.hash = "#/learning";
    stubFetch({ ...DASHBOARD_PAYLOAD, controlPlane: undefined, degraded: ["control_plane"] });
    render(<AppRoot />);

    expect(await screen.findByText("Mokymosi duomenų nėra")).toBeInTheDocument();
    window.location.hash = "";
  });
});
