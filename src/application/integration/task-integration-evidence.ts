// Vieno task'o integracijos įrodymų surinkimas (spec IVER-2/IVER-3, design §11).
// Behaviour etalon: AG_loop application/integration/task-integration-evidence.ts (1:1).
//
// `contract-diff.ts` yra GRYNAS: revizijų turinį jam paduoda kvietėjas. Šis modulis yra
// trūkstama grandis vieno task'o keliui: iš task'o `baseHead..HEAD` pakeistų kelių jis
// surenka abiejų revizijų turinį per įleistą skaitytuvą ir grąžina
// `EvaluateIntegrationRiskInput`.
//
// KETURIOS savybės, kurios čia yra taisyklė: (1) modulis NEVYKDO git — revizijų turinį
// paduoda `ContractRevisionReader`; (2) nepateiktas turinys niekada nevirsta „suderinama";
// (3) apkarpymas yra PASKELBIAMAS — virš `maxContentPaths` likę keliai lieka
// `changedPaths` ir virsta `unverified`; (4) nežinomybė neišranda įrodymų — bangos vartų
// raportas, konfliktai ir modulių žemėlapis vieno task'o kelyje paliekami neužpildyti.

import { diffContracts } from "./contract-diff.js";
import { isContractBearingPath } from "./contract-paths.js";
import type { ContractSourceFile } from "./contract-model.js";
import type { EvaluateIntegrationRiskInput } from "./evaluate-integration-risk.js";

/**
 * Failo būklė vienoje revizijoje.
 *
 * `present: false` reiškia „failo toje revizijoje NEBUVO" (teisėtas pridėjimas ar
 * pašalinimas). `present: true` be `text` reiškia „failas buvo, bet turinys neprieinamas"
 * — tai virsta `unverified`. Šis skirtumas yra būtent tas, kurį `contract-diff.ts`
 * traktuoja skirtingai.
 */
export type ContractRevisionFile = { present: boolean; text?: string };

export type ContractRevisionReader = (ref: string, filePath: string) => Promise<ContractRevisionFile>;

/**
 * Kiek kelių turinio skaitoma iš abiejų revizijų. Riba yra kainos, ne teisingumo:
 * kiekvienas kelias kainuoja du revizijų skaitymus. Virš ribos likę keliai NEDINGSTA —
 * jie lieka `changedPaths` ir tampa `unverified`, t. y. griežtesne, ne švelnesne puse.
 */
export const MAX_INTEGRATION_EVIDENCE_CONTENT_PATHS = 60;

export type CollectTaskIntegrationEvidenceInput = {
  /** Task'o pradžios revizija (`TaskRunState.baseHead`). */
  baseRef: string;
  /** Dabartinė revizija; kanoniniame kelyje tai `HEAD`. */
  headRef: string;
  /** `baseRef..headRef` pakeisti produkto keliai. */
  changedPaths: readonly string[];
  readFile: ContractRevisionReader;
  maxContentPaths?: number;
};

export type TaskIntegrationEvidence = {
  evidence: EvaluateIntegrationRiskInput;
  /** Kontraktus galintys nešti pakeisti keliai (rūšiuoti, be dublikatų). */
  contractPaths: string[];
  /** Keliai, kurių turinys sąmoningai neskaitytas dėl `maxContentPaths` ribos. */
  contentTruncatedPaths: string[];
};

export async function collectTaskIntegrationEvidence(
  input: CollectTaskIntegrationEvidenceInput,
): Promise<TaskIntegrationEvidence> {
  const contractPaths = [
    ...new Set(
      input.changedPaths
        .map((filePath) => (filePath ?? "").replace(/\\/g, "/").replace(/^\.\//, "").trim())
        .filter((filePath) => filePath.length > 0 && isContractBearingPath(filePath)),
    ),
  ].sort();

  const limit = input.maxContentPaths ?? MAX_INTEGRATION_EVIDENCE_CONTENT_PATHS;
  const readPaths = contractPaths.slice(0, Math.max(0, limit));
  const contentTruncatedPaths = contractPaths.slice(readPaths.length);

  const before: ContractSourceFile[] = [];
  const after: ContractSourceFile[] = [];
  for (const filePath of readPaths) {
    const [baseFile, headFile] = await Promise.all([
      input.readFile(input.baseRef, filePath),
      input.readFile(input.headRef, filePath),
    ]);
    if (baseFile.present) before.push({ path: filePath, ...(baseFile.text === undefined ? {} : { text: baseFile.text }) });
    if (headFile.present) after.push({ path: filePath, ...(headFile.text === undefined ? {} : { text: headFile.text }) });
  }

  return {
    evidence: {
      contractDiff: diffContracts({ before, after, changedPaths: contractPaths }),
      // gates / conflicts / modulesByPath: vieno task'o kelyje jų nėra — žr. savybę 4.
    },
    contractPaths,
    contentTruncatedPaths,
  };
}

/**
 * Viena eilutė, apibendrinanti įrodymų apimtį. Ji keliauja į task žurnalo įrašą, kad
 * diagnose ir final-audit matytų, KOKIA apimtimi verdiktas priimtas, o ne tik patį verdiktą.
 */
export function summarizeTaskIntegrationEvidence(collected: TaskIntegrationEvidence): string {
  const diff = collected.evidence.contractDiff;
  const parts = [
    `paths=${collected.contractPaths.length}`,
    `contracts=${diff.entries.length}`,
    `blocking=${diff.blocking.length}`,
    `unverified=${diff.unverified_paths.length}`,
    `diff=${diff.diff_hash}`,
  ];
  if (collected.contentTruncatedPaths.length > 0) {
    parts.push(`content_truncated=${collected.contentTruncatedPaths.length}`);
  }
  return parts.join(" ");
}
