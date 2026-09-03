import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoot } from "../../view/AppRoot";

/**
 * Prieinamumo vartai (2026-08-24 UI audito ketvirtas ratas — originalaus audito rekomendacija 4).
 *
 * Abu tikrinami dalykai yra ne stiliaus klausimas, o kliūtis, kurią galima išmatuoti:
 *
 *   - WCAG 2.4.1 „Bypass Blocks": kiekviename maršrute prieš turinį stovi 9 navigacijos skirtukai
 *     ir 6 įrankių juostos mygtukai. Klaviatūra dirbančiam operatoriui tai 15 `Tab` paspaudimų
 *     iki KIEKVIENO ekrano.
 *   - WCAG 2.4.2 „Page Titled": SPA be antraštės atnaujinimo palieka vieną statinę antraštę
 *     visiems ekranams, tad naršyklės istorija ir kortelių juosta tampa neskaitomos.
 */

/** Serverio `interfaces/http/ui-dashboard-view.ts#UiDashboardData` wire forma (žr. `dashboardSmoke.test.tsx`). */
const DASHBOARD_PAYLOAD = {
  root: "D:/VERQESTRA",
  currentTaskId: null,
  currentTaskFile: null,
  currentTaskBucket: null,
  currentTaskState: null,
  claudeExit: "0",
  stableRef: "abcdef1234567890",
  stopStatus: { status: "done", reason: "gates passed", task_id: null },
  stopStatusSource: "attempt",
  stopStatusCorrupted: false,
  decision: { verdict: "done", reason: "gates passed" },
  supervisorResume: {},
  claudeResume: { updated_at: "2026-08-23T09:00:00.000Z" },
  runtime: [],
  claudeLogUpdatedAt: "2026-08-23T09:00:00.000Z",
  claudeLogBytes: 0,
  claudeLogSource: "legacy",
  workflowBuckets: [
    { name: "queue", tasks: [], totalCount: 0 },
    { name: "active", tasks: [], totalCount: 0 },
    { name: "human-review", tasks: [], totalCount: 0 },
    { name: "done", tasks: [], totalCount: 0 },
  ],
  queueCounts: { queue: 0, active: 0, "human-review": 0, done: 0 },
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

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/dashboard")) {
        return Promise.resolve(
          new Response(JSON.stringify(DASHBOARD_PAYLOAD), { status: 200, headers: { "content-type": "application/json" } }),
        );
      }
      // Srautas testuose sąmoningai neprisijungia; puslapis nuo to nenukenčia.
      if (url.includes("/api/events")) return Promise.reject(new Error("sse disabled in tests"));
      if (url.includes("/api/policies/proposals")) {
        return Promise.resolve(
          new Response(JSON.stringify({ proposals: [] }), { status: 200, headers: { "content-type": "application/json" } }),
        );
      }
      if (url.includes("/api/waves")) {
        return Promise.resolve(
          new Response(JSON.stringify({ events: [], leases: [], last_rejections: [], degraded: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }),
      );
    }),
  );
}

describe("prieinamumas: navigacijos praleidimas ir dokumento antraštė", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubFetch();
    window.location.hash = "";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.location.hash = "";
  });

  it("praleidimo mygtukas yra PIRMAS fokusuojamas elementas ir perkelia fokusą į `main`", async () => {
    const { container } = render(<AppRoot />);

    const skip = screen.getByRole("button", { name: "Pereiti prie turinio" });
    // „Pirmas Tab" tikrinamas per DOM tvarką: jsdom klaviatūros navigacijos neįgyvendina, tad
    // fokusuojamų elementų seka yra tiksliai tas pats faktas, tik be simuliacijos sluoksnio.
    const focusable = container.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    expect(focusable[0]).toBe(skip);

    fireEvent.click(skip);
    // Turinys gauna fokusą, tad kitas `Tab` tęsia NUO turinio, o ne nuo navigacijos pradžios.
    await waitFor(() => expect(document.querySelector("main")).toHaveFocus());
  });

  it("praleidimo mygtukas NEKEIČIA maršruto", async () => {
    render(<AppRoot />);

    fireEvent.click(screen.getByRole("button", { name: "Pereiti prie turinio" }));
    // Įprastas `<a href="#main-content">` šablonas čia perrašytų hash'ą, `readRoute` jo
    // neatpažintų, ir operatorius vietoj turinio atsidurtų „Apžvalgoje" — tyliai sulaužyta
    // navigacija vietoje prieinamumo pagerinimo.
    expect(window.location.hash).toBe("");
  });

  it("dokumento antraštė seka maršrutą", async () => {
    render(<AppRoot />);
    await waitFor(() => expect(document.title).toBe("Apžvalga — VERQESTRA"));

    window.location.hash = "/system";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await waitFor(() => expect(document.title).toBe("Sistema — VERQESTRA"));
  });

  it("kiekviename pagrindiniame maršrute yra lygiai vienas h1, ir jo tekstas yra maršruto pavadinimas, ne prekės ženklas", async () => {
    render(<AppRoot />);
    await waitFor(() => expect(document.title).toBe("Apžvalga — VERQESTRA"));

    const routes: Array<[string, string]> = [
      ["", "Sistemos apžvalga"],
      ["/tasks", "Užduotys"],
      ["/reviews", "Peržiūros"],
      ["/learning", "Mokymasis"],
      ["/system", "Sistema"],
    ];

    for (const [hash, expectedTitle] of routes) {
      window.location.hash = hash;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await waitFor(() => {
        const headings = screen.getAllByRole("heading", { level: 1 });
        expect(headings).toHaveLength(1);
        expect(headings[0]).toHaveTextContent(expectedTitle);
      });
    }
  });
});
