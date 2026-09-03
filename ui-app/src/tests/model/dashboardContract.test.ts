import { describe, expect, it } from "vitest";
import { DashboardContractError, dashboardContractViolations, parseDashboardData } from "../../model/dashboardContract";

/**
 * Wire kontrakto testai (2026-08-23 UI paleidimo auditas, P0-2).
 *
 * Serverio pusės veidrodis: `src/tests/composition-ui-dashboard-contract.test.ts`. Abu failai
 * pin'ina TĄ PATĮ privalomų laukų sąrašą; pakeitimas viename be kito privalo nudažyti kitą.
 */

const VALID = {
  root: "D:/VERQESTRA",
  currentTaskId: null,
  currentTaskFile: null,
  claudeExit: null,
  stableRef: null,
  stopStatus: {},
  decision: {},
  supervisorResume: {},
  claudeResume: {},
  runtime: [],
  claudeLogUpdatedAt: null,
  claudeLogBytes: null,
  workflowBuckets: [],
};

describe("dashboardContractViolations", () => {
  it("pilnas atsakymas neturi pažeidimų", () => {
    expect(dashboardContractViolations(VALID)).toEqual([]);
  });

  it("`null` yra galiojanti reikšmė, o `undefined` — ne", () => {
    // „Nėra einamojo task'o" ir „serveris lauko nesiuntė" yra DU skirtingi faktai; tik antrasis
    // yra kontrakto pažeidimas.
    expect(dashboardContractViolations({ ...VALID, currentTaskId: "0042" })).toEqual([]);
    expect(dashboardContractViolations({ ...VALID, currentTaskId: undefined })).toEqual(["currentTaskId"]);
  });

  it("senoji control-plane forma pažymima su KIEKVIENU trūkstamu lauku", () => {
    const legacy = {
      config_controls: [],
      loop_controls: [],
      human_review_tasks: [],
      learning_recommendations: [],
      policy_controls: [],
    };
    const missing = dashboardContractViolations(legacy);

    // Būtent `stopStatus` skaitomas pirmas (`adaptOverview`), tad be jo ekranas lieka tuščias.
    expect(missing).toContain("stopStatus");
    expect(missing).toContain("root");
    expect(missing).toContain("runtime");
    expect(missing).toContain("workflowBuckets");
  });

  it("ne objektas yra pažeidimas, o ne griuvimas", () => {
    expect(dashboardContractViolations(null)).toEqual(["<atsakymas nėra objektas>"]);
    expect(dashboardContractViolations([])).toEqual(["<atsakymas nėra objektas>"]);
    expect(dashboardContractViolations("labas")).toEqual(["<atsakymas nėra objektas>"]);
  });

  it("masyvas ten, kur laukiamas objektas, nepraeina", () => {
    expect(dashboardContractViolations({ ...VALID, stopStatus: [] })).toEqual(["stopStatus"]);
    expect(dashboardContractViolations({ ...VALID, runtime: {} })).toEqual(["runtime"]);
  });
});

describe("parseDashboardData", () => {
  it("teisingą atsakymą grąžina nepakeistą", () => {
    expect(parseDashboardData(VALID)).toBe(VALID);
  });

  it("klaida ĮVARDIJA trūkstamus laukus ir pasako, ką daryti", () => {
    try {
      parseDashboardData({ root: "x" });
      throw new Error("parseDashboardData privalėjo mesti");
    } catch (error) {
      expect(error).toBeInstanceOf(DashboardContractError);
      const contractError = error as DashboardContractError;
      expect(contractError.missing).toContain("stopStatus");
      // Sakinys turi turėti VEIKSMĄ: „nepavyko" be jo operatoriui neduoda nieko.
      expect(contractError.message).toContain("perkrauk");
    }
  });
});
