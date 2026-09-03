import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchBenchmarkReport,
  fetchCompression,
  fetchPolicyProposals,
  fetchTokenAnalytics,
  fetchTokenUsage,
  fetchWaves,
  fetchWorkflowTasks,
  REQUEST_TIMEOUT_MS,
  resumeLoop,
  setRequestedWorkers,
  startLoopWithWorkers,
  stopLoop,
  uploadTaskFiles,
} from "../../model/api";

/**
 * ATSAKYMŲ VOKŲ testai (2026-08-23 UI audito antras ratas).
 *
 * Serverio pusės veidrodis: `src/tests/interfaces-http-router-contracts.test.ts`. Auditas rado
 * keturis maršrutus, kuriuose serveris grąžindavo ŽALIĄ rezultatą be voko. Klientas tada
 * skaitydavo `undefined` ir elgdavosi taip, tarsi viskas pavyko: „paleista" po nepavykusio
 * paleidimo, o politikų panelė amžinai „Įkeliama…". Šie testai pin'ina, kad tokia forma nuo
 * šiol duoda MATOMĄ klaidą.
 */

function stubFetch(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })),
    ),
  );
}

function stubFetchWithText(body: string, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(body, { status, headers: { "content-type": "text/plain" } }))),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ciklo valdymo vokas", () => {
  it("`{ loop }` išpakuojamas", async () => {
    stubFetch({ loop: { status: "started", pid: 7 } });
    expect(await resumeLoop()).toEqual({ status: "started", pid: 7 });
  });

  it("žalias rezultatas be voko meta ĮVARDYTĄ klaidą, o ne apsimeta sėkme", async () => {
    // Būtent šitą serveris grąžindavo iki pataisymo.
    stubFetch({ status: "started", pid: 7 });
    await expect(resumeLoop()).rejects.toThrow(/'loop' bloko/);
  });

  it("stop ir start eina per tą pačią patikrą", async () => {
    stubFetch({ loop: { status: "stop-requested", pid: 7 }, loop_control: { slots: {} } });
    expect(await stopLoop()).toEqual({ status: "stop-requested", pid: 7 });

    stubFetch({ worker_request: { requested: 2 } });
    await expect(startLoopWithWorkers(2)).rejects.toThrow(/'loop' bloko/);
  });

  it("`loop: null` nėra rezultatas", async () => {
    stubFetch({ loop: null });
    await expect(stopLoop()).rejects.toThrow(/'loop' bloko/);
  });
});

describe("politikų pasiūlymų vokas", () => {
  it("`{ proposals }` išpakuojamas", async () => {
    stubFetch({ proposals: [] });
    expect(await fetchPolicyProposals()).toEqual({ proposals: [] });
  });

  it("žalias sąrašas be voko meta klaidą vietoj amžino „Įkeliama…“", async () => {
    stubFetch([{ policy_file: "vq/architecture/coding-principles.json" }]);
    await expect(fetchPolicyProposals()).rejects.toThrow(/'proposals' sąrašo/);
  });
});

/**
 * Bendras struktūrinės patikros primityvas (task 029): `/api/compression` ir
 * `/api/benchmark/report` iki šiol kirto HTTP ribą su `as`, be jokios runtime patikros.
 */
describe("kompresijos atsakymo struktūrinė patikra", () => {
  const validCompression = {
    version: 1,
    canary: { percent: 10, salt: "abc" },
    features: [],
    telemetry: { sample_count: 0, exceeded_count: 0, ir_compared_count: 0, ir_smaller_count: 0 },
    decision: { pressure: { level: "none" }, recommendations: [] },
    degraded: [],
  };

  it("teisingas atsakymas praeina nepakeistas", async () => {
    stubFetch(validCompression);
    expect(await fetchCompression()).toEqual(validCompression);
  });

  it("trūkstamas laukas meta klaidą su maršrutu ir lauko vardu", async () => {
    const { decision, ...withoutDecision } = validCompression;
    void decision;
    stubFetch(withoutDecision);
    await expect(fetchCompression()).rejects.toThrow(/\/api\/compression.*decision/s);
  });

  it("giliai įdėtas trūkstamas laukas ('decision.pressure') irgi įvardijamas", async () => {
    stubFetch({ ...validCompression, decision: { recommendations: [] } });
    await expect(fetchCompression()).rejects.toThrow(/decision\.pressure/);
  });

  it("`null` vietoj objekto meta klaidą, o ne praslysta kaip `undefined`", async () => {
    stubFetch(null);
    await expect(fetchCompression()).rejects.toThrow(/\/api\/compression/);
  });

  it("masyvas vietoj objekto meta klaidą", async () => {
    stubFetch([]);
    await expect(fetchCompression()).rejects.toThrow(/\/api\/compression/);
  });
});

describe("benchmark ataskaitos atsakymo struktūrinė patikra", () => {
  const validReport = {
    state: "missing",
    reason: "nėra ataskaitos",
    source: { path: "AG/benchmark/report.json", command: "pnpm report:benchmark" },
    freshness: {},
  };

  it("teisingas atsakymas praeina nepakeistas", async () => {
    stubFetch(validReport);
    expect(await fetchBenchmarkReport()).toEqual(validReport);
  });

  it("trūkstamas 'source' laukas meta klaidą su maršrutu ir lauko vardu", async () => {
    const { source, ...withoutSource } = validReport;
    void source;
    stubFetch(withoutSource);
    await expect(fetchBenchmarkReport()).rejects.toThrow(/\/api\/benchmark\/report.*source/s);
  });

  it("`null` vietoj objekto meta klaidą, o ne praslysta kaip `undefined`", async () => {
    stubFetch(null);
    await expect(fetchBenchmarkReport()).rejects.toThrow(/\/api\/benchmark\/report/);
  });

  it("masyvas vietoj objekto meta klaidą", async () => {
    stubFetch([]);
    await expect(fetchBenchmarkReport()).rejects.toThrow(/\/api\/benchmark\/report/);
  });
});

/**
 * `assertOk` keturios šakos (žr. `./api.ts`): JSON su `error`, JSON be `error`, ne-JSON kūnas ir
 * tuščias kūnas. Dengiama per `fetchWaves()`: visi stub'ai grąžina ne-200 statusą, tad `assertOk`
 * meta klaidą PRIEŠ pasiekiant `requireContractFields` — voko patikra jos nemaskuoja.
 */
describe("assertOk klaidos žinutė", () => {
  it("JSON kūnas su `error` lauku: žinutėje statusas ir paaiškinimas", async () => {
    stubFetch({ error: "waves snapshot unreadable" }, 503);
    await expect(fetchWaves()).rejects.toThrow("HTTP 503: waves snapshot unreadable");
  });

  it("JSON kūnas be `error` lauko: žinutėje statusas ir visas JSON kūnas kaip tekstas", async () => {
    stubFetch({ foo: "bar" }, 500);
    await expect(fetchWaves()).rejects.toThrow(`HTTP 500: ${JSON.stringify({ foo: "bar" })}`);
  });

  it("ne-JSON kūnas: žinutėje statusas ir tas tekstas", async () => {
    stubFetchWithText("internal server error", 500);
    await expect(fetchWaves()).rejects.toThrow("HTTP 500: internal server error");
  });

  it("tuščias kūnas: žinutėje TIK statusas, be dvitaškio", async () => {
    stubFetchWithText("", 500);
    await expect(fetchWaves()).rejects.toThrow("HTTP 500");
    await expect(fetchWaves()).rejects.toThrow(/^HTTP 500$/);
  });

  it("labai ilgas error tekstas apkertamas ties 300 simbolių", async () => {
    const longError = "x".repeat(400);
    stubFetch({ error: longError }, 500);
    await expect(fetchWaves()).rejects.toThrow(`HTTP 500: ${"x".repeat(300)}`);
  });
});

/**
 * Vartas (task 030): `as` per HTTP ribą nėra kontraktas. `fetchDashboard` išimtis leidžiama, nes
 * jos `as Promise<unknown>` tik nuima tipą prieš `parseDashboardData` — pati patikra vyksta
 * runtime'e, ne kompiliavimo metu.
 */
describe("HTTP ribos vartas: joks klientas nepažymi konkretaus tipo be runtime patikros", () => {
  it("`api.ts` neturi `response.json() as <konkretus tipas>` arba `r.json() as <konkretus tipas>`", () => {
    const apiPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "model", "api.ts");
    const source = readFileSync(apiPath, "utf8");
    const offendingLines = source
      .split("\n")
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => /\b(?:response|r)\.json\(\)\s*as\s+(?!Promise<unknown>)/.test(line))
      .map(({ line, number }) => `${number}: ${line}`);
    expect(offendingLines).toEqual([]);
  });
});

/**
 * 2026-08-27 UI auditas: `fetchWaves` iki šio pataisymo žymėjo atsakymą `as UiWavesView` be
 * jokios runtime patikros — atsakymas be `degraded`/`leases` numušdavo `WavesPanel` `TypeError`
 * klaida PRIEŠ pirmą renderį. Dabar trūkstamas laukas meta ĮVARDYTĄ klaidą (ne throw'ą per visą
 * komponentų medį — kontroleris ją pagauna ir paverčia klaidos būsena).
 */
describe("bangų atsakymo struktūrinė patikra", () => {
  const validWaves = { events: [], leases: [], last_rejections: [], degraded: [] };

  it("teisingas atsakymas praeina nepakeistas", async () => {
    stubFetch(validWaves);
    expect(await fetchWaves()).toEqual(validWaves);
  });

  it("trūkstamas 'leases' laukas meta klaidą su maršrutu ir lauko vardu", async () => {
    const { leases, ...withoutLeases } = validWaves;
    void leases;
    stubFetch(withoutLeases);
    await expect(fetchWaves()).rejects.toThrow(/\/api\/waves.*leases/s);
  });

  it("trūkstamas 'degraded' laukas meta klaidą su maršrutu ir lauko vardu", async () => {
    const { degraded, ...withoutDegraded } = validWaves;
    void degraded;
    stubFetch(withoutDegraded);
    await expect(fetchWaves()).rejects.toThrow(/\/api\/waves.*degraded/s);
  });
});

describe("workflow bucket atsakymo struktūrinė patikra", () => {
  const validBucket = { name: "queue", tasks: ["001-a.md"] };

  it("teisingas atsakymas praeina nepakeistas", async () => {
    stubFetch(validBucket);
    expect(await fetchWorkflowTasks("queue")).toEqual(validBucket);
  });

  it("trūkstamas 'tasks' laukas meta klaidą su maršrutu ir lauko vardu", async () => {
    const { tasks, ...withoutTasks } = validBucket;
    void tasks;
    stubFetch(withoutTasks);
    await expect(fetchWorkflowTasks("queue")).rejects.toThrow(/\/api\/tasks.*tasks/s);
  });
});

describe("failų įkėlimo atsakymo struktūrinė patikra", () => {
  // `uploadTaskFiles` skaito tik `f.name`/`f.text()` — šis minimalus stub'as jais apsiriboja, kad
  // testas nepriklausytų nuo jsdom `File`/`Blob` implementacijos smulkmenų.
  function fakeTaskFile(name: string, content: string): File {
    return { name, text: () => Promise.resolve(content) } as unknown as File;
  }

  const validUpload = { saved: ["001-a.md"], loop: { status: "started", pid: 7 } };

  it("teisingas atsakymas praeina nepakeistas", async () => {
    stubFetch(validUpload);
    expect(await uploadTaskFiles([fakeTaskFile("task.md", "turinys")])).toEqual(validUpload);
  });

  it("trūkstamas 'loop' laukas meta klaidą su maršrutu ir lauko vardu", async () => {
    const { loop, ...withoutLoop } = validUpload;
    void loop;
    stubFetch(withoutLoop);
    await expect(uploadTaskFiles([fakeTaskFile("task.md", "turinys")])).rejects.toThrow(
      /\/tasks\/queue\/upload.*loop/s,
    );
  });
});

describe("worker request atsakymo struktūrinė patikra", () => {
  const validWorkerRequest = { worker_request: { requested: 2, source: "state" } };

  it("teisingas atsakymas praeina nepakeistas", async () => {
    stubFetch(validWorkerRequest);
    expect(await setRequestedWorkers(2)).toEqual(validWorkerRequest);
  });

  it("giliai įdėtas trūkstamas laukas ('worker_request.requested') irgi įvardijamas", async () => {
    stubFetch({ worker_request: { source: "state" } });
    await expect(setRequestedWorkers(2)).rejects.toThrow(/\/api\/runtime\/workers.*worker_request\.requested/s);
  });
});

describe("token usage atsakymo struktūrinė patikra", () => {
  const validTokenUsage = { records: [] };

  it("teisingas atsakymas praeina nepakeistas", async () => {
    stubFetch(validTokenUsage);
    expect(await fetchTokenUsage({})).toEqual(validTokenUsage);
  });

  it("trūkstamas 'records' laukas meta klaidą su maršrutu ir lauko vardu", async () => {
    stubFetch({});
    await expect(fetchTokenUsage({})).rejects.toThrow(/\/api\/token-usage.*records/s);
  });
});

describe("token analytics atsakymo struktūrinė patikra", () => {
  const validTokenAnalytics = { groups: [], candidates: [], history: [] };

  it("teisingas atsakymas praeina nepakeistas", async () => {
    stubFetch(validTokenAnalytics);
    expect(await fetchTokenAnalytics()).toEqual(validTokenAnalytics);
  });

  it("trūkstamas 'history' laukas meta klaidą su maršrutu ir lauko vardu", async () => {
    const { history, ...withoutHistory } = validTokenAnalytics;
    void history;
    stubFetch(withoutHistory);
    await expect(fetchTokenAnalytics()).rejects.toThrow(/\/api\/token-analytics.*history/s);
  });
});

/**
 * 2026-08-28: `REQUEST_TIMEOUT_MS` buvo lygus pollingo periodui (30s), tad lėtam serveriui
 * užklausa dar nebūdavo nutraukta, kai startuodavo kita — `requestSequence` tyliai mesdavo
 * rezultatus. Timeout privalo likti aiškiai mažesnis už trumpiausią pollingo periodą.
 */
describe("užklausos timeout riba", () => {
  it("REQUEST_TIMEOUT_MS yra mažesnis už trumpiausią pollingo periodą (30s)", () => {
    expect(REQUEST_TIMEOUT_MS).toBeLessThan(30_000);
  });

  it("AbortSignal nutraukia užklausą su timeout klaida", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      ),
    );

    const pending = fetchWaves();
    const assertion = expect(pending).rejects.toThrow(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await assertion;
  });
});
