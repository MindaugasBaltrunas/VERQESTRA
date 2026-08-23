import type { DashboardData } from "./types";

/**
 * `GET /api/dashboard` atsakymo RUNTIME patikra.
 *
 * Kodėl ji egzistuoja (2026-08-23 UI paleidimo auditas): iki šios patikros `fetchDashboard`
 * atsakymą tiesiog pažymėdavo `as DashboardData`. Serveris tuo metu grąžindavo visai kitą
 * dokumentą (`UiControlPlaneData`), tad pirmas adapteris kreipdavosi į `data.stopStatus.status`,
 * gaudavo `TypeError: Cannot read properties of undefined`, ir React medis nulūždavo PRIEŠ pirmą
 * renderį. Operatorius matydavo tuščią ekraną be jokios žinutės — tyliausias įmanomas gedimas.
 *
 * `as` yra tik kompiliavimo laiko prielaida; wire kontraktas gyvena TIK čia. Todėl tikrinami
 * būtent tie laukai, kuriuos vaizdo modelis dereferencina BE saugiklio: jų trūkumas yra ne
 * kosmetika, o griuvimas.
 *
 * Patikra SĄMONINGAI paviršinė: gilus schemos validavimas kliente reikštų trečią to paties
 * kontrakto kopiją (serverio tipas, kliento tipas, schema), o šio audito radinys buvo ne blogas
 * lauko turinys, o VISIŠKAI kitas dokumentas.
 */

/** Laukai, be kurių `adaptOverview`/`adaptRuntime`/`adaptWorkflowBuckets` griūva. */
const REQUIRED_OBJECT_FIELDS = ["stopStatus", "decision", "supervisorResume", "claudeResume"] as const;
const REQUIRED_ARRAY_FIELDS = ["runtime", "workflowBuckets"] as const;
const REQUIRED_NULLABLE_TEXT_FIELDS = ["currentTaskId", "currentTaskFile", "claudeExit", "stableRef"] as const;

export class DashboardContractError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(
      `serverio atsakymas neatitinka dashboard kontrakto (trūksta: ${missing.join(", ")}) — ` +
        "perkrauk VERQESTRA UI serverį (sustabdyk ir paleisk iš naujo po `pnpm build`)",
    );
    this.name = "DashboardContractError";
    this.missing = missing;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trūkstamų/netinkamos formos laukų sąrašas. Tuščias sąrašas reiškia „forma tinka". */
export function dashboardContractViolations(value: unknown): string[] {
  if (!isRecord(value)) return ["<atsakymas nėra objektas>"];

  const missing: string[] = [];
  if (typeof value["root"] !== "string") missing.push("root");
  for (const field of REQUIRED_OBJECT_FIELDS) {
    if (!isRecord(value[field])) missing.push(field);
  }
  for (const field of REQUIRED_ARRAY_FIELDS) {
    if (!Array.isArray(value[field])) missing.push(field);
  }
  for (const field of REQUIRED_NULLABLE_TEXT_FIELDS) {
    const entry = value[field];
    // `null` yra GALIOJANTI reikšmė („nėra einamojo task'o"), o `undefined` — ne: pastarasis
    // reiškia, kad serveris lauko iš viso nesiuntė.
    if (entry !== null && typeof entry !== "string") missing.push(field);
  }
  return missing;
}

/** Patikrintas atsakymas arba `DashboardContractError` su ĮVARDYTAIS trūkstamais laukais. */
export function parseDashboardData(value: unknown): DashboardData {
  const missing = dashboardContractViolations(value);
  if (missing.length > 0) throw new DashboardContractError(missing);
  return value as DashboardData;
}
