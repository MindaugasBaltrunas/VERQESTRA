import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPolicyProposals, fetchWaves, resumeLoop, startLoopWithWorkers, stopLoop } from "./api";

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
 * `assertOk` keturios šakos (žr. `./api.ts`): JSON su `error`, JSON be `error`, ne-JSON kūnas ir
 * tuščias kūnas. Dengiama per `fetchWaves()`, nes tai vienintelis GET kelias be papildomo voko
 * patikros (kitaip `assertOk` klaida būtų maskuojama vėlesnės `require*` patikros).
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
