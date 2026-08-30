// Preserved-ref sutaikinimas (task 083-a-02): `refs/verqestra/preserved/<sha>` (žr.
// `rollback-scope.ts` `preserveTaskScope`) kartais lieka be `vq/state/rollback-preserved/<task>.json`
// įrašo — ankstesnis darbas (`rollback-stable.ts` `recordPreservedTaskScope`) rašo įrašą TIK
// preserve metu, o bet koks jo praradimas (kopijos worktree dingimas, ranka trintas failas,
// senesnė versija be rašymo) palieka ref'ą beveidį: retencija (`preserved-ref-retention.ts`) jo
// net nemato per `.json` katalogą, tad jis kaupiasi amžinai.
//
// Šis modulis skaito TIK: ref'ų sąrašą, esamus `.json` įrašus ir patį preserved commit'ą
// (žinutę, tėvą, diff'ą, datą). Jei komito žinutėje yra `task=<id>` žyma (ta pati gramatika kaip
// AG žurnalo eilučių `task=` laukuose, žr. `preserved-ref-retention.ts` logLine), metaduomenys
// atkuriami ir įrašomas naujas `.json` TA PAČIA forma, kurią skaito `preserved-ref-retention.ts`
// (`PreservedRefRecord`). Jei žymos nėra, arba nėra kuo saugiai parašyti (taikinio failas jau
// užimtas kito įrašo, tėvo ar datos nepavyksta nustatyti), ref'as pažymimas `unattributed` —
// kandidatas tolesnei retencijai, kuri sprendžia patį trynimą (šis modulis nieko netrina).
//
// Esamas įrašas NIEKADA neperrašomas: ref, kuris jau turi savo `.json` (bet kuriuo pavadinimu),
// lieka `attributed` ir visiškai neliečiamas — jam net nereikia skaityti paties commit'o.

import path from "node:path";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";
import { run } from "../process/run-process.js";
import { gitResolveCommit } from "./git-client.js";
import { PRESERVED_REF_PREFIX } from "./rollback-scope.js";
import type { PreservedRefRecord } from "./preserved-ref-retention.js";

const PRESERVED_REF_RECORD_DIRNAME = "rollback-preserved";

/** `task=<id>` — ta pati gramatika kaip visose AG žurnalo `task=` eilutėse. */
const TASK_ID_PATTERN = /\btask=([^\s,;)]+)/i;

/** Grynas parse'as: komito žinutė → task id, arba `undefined`, jei žymos nėra. */
export function parseTaskIdFromCommitMessage(message: string): string | undefined {
  const candidate = TASK_ID_PATTERN.exec(message)?.[1]?.trim();
  return candidate ? candidate : undefined;
}

export type PreservedRefReconcileOutcome =
  | { status: "attributed"; ref: string; taskId: string }
  | { status: "restored"; ref: string; taskId: string; recordPath: string }
  | { status: "unattributed"; ref: string; reason: string };

export type PreservedRefReconcileResult = {
  attributed: PreservedRefReconcileOutcome[];
  restored: PreservedRefReconcileOutcome[];
  unattributed: PreservedRefReconcileOutcome[];
};

export type PreservedRefReconcilePorts = {
  agLog(line: string): Promise<void>;
};

export type PreservedRefReconcileOptions = {
  runtimeRoot?: string;
};

async function git(root: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return await run("git", ["-C", root, ...args]);
}

async function listPreservedRefs(root: string): Promise<string[]> {
  const result = await git(root, ["for-each-ref", "--format=%(refname)", PRESERVED_REF_PREFIX]);
  if (result.code !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function readCommitMessage(root: string, commit: string): Promise<string | undefined> {
  const result = await git(root, ["log", "-1", "--format=%B", commit]);
  return result.code === 0 ? result.stdout : undefined;
}

async function readCommitDate(root: string, commit: string): Promise<string | undefined> {
  const result = await git(root, ["log", "-1", "--format=%cI", commit]);
  const date = result.code === 0 ? result.stdout.trim() : "";
  return date ? date : undefined;
}

async function readCommitParent(root: string, commit: string): Promise<string | undefined> {
  const result = await git(root, ["rev-parse", "--verify", `${commit}^1`]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

async function readDiffPaths(root: string, baseRef: string, commit: string): Promise<string[]> {
  const result = await git(root, ["diff", "--name-only", baseRef, commit]);
  if (result.code !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Ref → jo įrašo task_id, tik ref'ams, kurie JAU turi `.json` (bet kokiu failo vardu). */
async function existingRecordRefs(runtimeRoot: string): Promise<Map<string, string>> {
  const dir = path.join(runtimeRoot, "state", PRESERVED_REF_RECORD_DIRNAME);
  const names = (await nodeFsAdapter.listFiles(dir)).filter((name) => name.endsWith(".json"));
  const refs = new Map<string, string>();

  for (const name of names) {
    const raw = await nodeFsAdapter.readTextFileIfExists(path.join(dir, name));
    if (raw === undefined) continue;
    try {
      const parsed = JSON.parse(raw) as Partial<PreservedRefRecord>;
      if (typeof parsed.ref === "string" && typeof parsed.task_id === "string") {
        refs.set(parsed.ref, parsed.task_id);
      }
    } catch {
      continue; // korumpuotas įrašas — retencija jį jau ignoruoja, sutaikinimui nesvarbu.
    }
  }

  return refs;
}

function recordPathFor(runtimeRoot: string, taskId: string): string {
  return path.join(runtimeRoot, "state", PRESERVED_REF_RECORD_DIRNAME, `${taskId}.json`);
}

type PreservedRefReconcileAttempt = Extract<PreservedRefReconcileOutcome, { status: "restored" | "unattributed" }>;

async function reconcileOneRef(root: string, runtimeRoot: string, ref: string): Promise<PreservedRefReconcileAttempt> {
  const commit = await gitResolveCommit(ref, root);
  if (!commit) return { status: "unattributed", ref, reason: "ref-unresolvable" };

  const message = await readCommitMessage(root, commit);
  const taskId = message === undefined ? undefined : parseTaskIdFromCommitMessage(message);
  if (!taskId) return { status: "unattributed", ref, reason: "task-id-not-found" };

  const targetPath = recordPathFor(runtimeRoot, taskId);
  if (await nodeFsAdapter.exists(targetPath)) {
    return { status: "unattributed", ref, reason: `record-path-exists:${targetPath}` };
  }

  const baseRef = await readCommitParent(root, commit);
  if (!baseRef) return { status: "unattributed", ref, reason: "no-parent-commit" };

  const recordedAt = await readCommitDate(root, commit);
  if (!recordedAt) return { status: "unattributed", ref, reason: "commit-date-unresolvable" };

  const paths = await readDiffPaths(root, baseRef, commit);
  const record: PreservedRefRecord = { task_id: taskId, ref, commit, base_ref: baseRef, paths, recorded_at: recordedAt };
  await nodeFsAdapter.writeTextFile(targetPath, JSON.stringify(record, null, 2));

  return { status: "restored", ref, taskId, recordPath: targetPath };
}

/**
 * Peržiūri visus `refs/verqestra/preserved/*` ir sutaiko juos su `vq/state/rollback-preserved/`
 * įrašais. Ref'as su esamu įrašu (bet kuriuo pavadinimu) lieka `attributed` ir neliečiamas; be
 * įrašo — bandoma atkurti metaduomenis iš paties preserved commit'o; nepavykus — `unattributed`,
 * su log eilute, kad operatorius (ar vėlesnė retencijos užduotis) matytų kandidatą.
 */
export async function reconcilePreservedRefs(
  projectRoot: string,
  ports: PreservedRefReconcilePorts,
  options: PreservedRefReconcileOptions = {},
): Promise<PreservedRefReconcileResult> {
  const root = path.resolve(projectRoot);
  const runtimeRoot = options.runtimeRoot ?? path.join(root, "vq");

  const [refs, recorded] = await Promise.all([listPreservedRefs(root), existingRecordRefs(runtimeRoot)]);

  const attributed: PreservedRefReconcileOutcome[] = [];
  const restored: PreservedRefReconcileOutcome[] = [];
  const unattributed: PreservedRefReconcileOutcome[] = [];

  for (const ref of refs) {
    const knownTaskId = recorded.get(ref);
    if (knownTaskId !== undefined) {
      attributed.push({ status: "attributed", ref, taskId: knownTaskId });
      continue;
    }

    const outcome = await reconcileOneRef(root, runtimeRoot, ref);
    if (outcome.status === "restored") {
      restored.push(outcome);
      await ports.agLog(`PRESERVED REF RECONCILED: ${ref} task=${outcome.taskId} record=${outcome.recordPath}`);
    } else {
      unattributed.push(outcome);
      await ports.agLog(`PRESERVED REF UNATTRIBUTED: ${ref} reason=${outcome.reason} — candidate for retention`);
    }
  }

  return { attributed, restored, unattributed };
}
