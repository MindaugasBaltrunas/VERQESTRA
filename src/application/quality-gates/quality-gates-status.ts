// Quality-gates būsenos kontraktas ir jos failo kelio taisyklė (etalono
// policy/quality-gates-status.ts, WBR VQ-305). Kontraktas gyvena application sluoksnyje,
// kad ir vartų vykdytojas (gamintojas), ir hooks/on-stop (vartotojas, E5) galėtų jį
// naudoti be importų krypties pažeidimo.
import path from "node:path";
import type { QualityScope } from "../policy-governance/quality-policy.js";

export type QualityGateResult = {
  name: string;
  command: string;
  exit_code: number;
  stdout: string;
  stderr: string;
};

export type QualityGatesStatus = {
  passed: boolean;
  exit_code: number;
  has_commands: boolean;
  scope: QualityScope;
  commands: string[];
  skipped: string[];
  failed_gates: string[];
  results: QualityGateResult[];
  message?: string;
  updated_at: string;
};

/** `vq/state/quality-gates-status.json` — mašininis vartų verdikto failas. */
export function qualityGatesStatusPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "quality-gates-status.json");
}

/** `logs/checks-last.log` atitikmuo — žmogui skirtas vartų log'as runtime šaknyje. */
export function checksLogPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "logs", "checks-last.log");
}
