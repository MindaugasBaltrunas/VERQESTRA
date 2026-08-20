// Vienkartinis istorinio auto-OpenSpec backlog'o suderinimas (etalonas: interfaces/cli/
// openspec-reconcile/index.ts logikos pusė, task 0030; WBR VQ-501 3/5-b — taisyklė keliama
// į application, CLI rendinimas lieka interfaces).
//
// Etalono task 0029 uždarė ŠAKNĮ: kiekvienas užbaigtas taskas pats archyvuoja savo `auto-*`
// change'ą. Ši funkcija yra tos pačios `archiveAutoOpenSpecChangeOnDone` taisyklės BATCH
// režimas iki-0029 skolai: jokio LLM sprendimo per punktą, jokios naujos archyvavimo
// logikos — „pereik visus done task'us ir leisk 0029 taisyklei suveikti". Uždarymo semantika
// (tasks.md žymėjimas PIRMA, perkėlimas PO TO; ambiguous ir susidūrimai nieko nerašo)
// automatiškai ta pati, kokia veikia gyvame loop'e.
//
// Vardiniai (ne `auto-`) change'ai NELIEČIAMI net kai done taskas juos mini — saugiklį
// įgyvendina extractAutoChangeSlugs, o čia jų atviri punktai tik SUSKAIČIUOJAMI į ataskaitą,
// kad likutis būtų matomas žmogui, o ne aklai uždarytas.

import path from "node:path";
import { taskFileStem } from "../../domain/tasks/identity.js";
import {
  archiveAutoOpenSpecChangeOnDone,
  markTasksComplete,
  resolveAutoChangeForTask,
  type OpenSpecArchiveFsPort,
} from "./openspec-archive.js";

/** Reconcile FS portas: archyvavimo portas + katalogų enumeracija (etalono readdir-catch). */
export type OpenSpecReconcileFsPort = OpenSpecArchiveFsPort & {
  /** Poaplankių vardai; `[]` kai katalogo nėra. */
  listSubdirectories(absoluteDir: string): Promise<string[]>;
  /** Failų vardai kataloge; `[]` kai katalogo nėra. */
  listFiles(absoluteDir: string): Promise<string[]>;
};

/** Kanoninė change nuoroda — ta pati forma, kurią grąžina autogen'as ir 0029 archyvavimas. */
function changeRef(slug: string): string {
  return `openspec/changes/${slug}`;
}

export type OpenSpecReconcileReport = {
  /** `reconciled` — nė vieno likučio ir nė vienos klaidos; kitaip `partial`. */
  status: "reconciled" | "partial";
  dry_run: boolean;
  /** Peržiūrėtų `AG/tasks/done/*.md` failų skaičius. */
  scanned_done_tasks: number;
  /** Aktyvūs `auto-*` change'ai PRIEŠ suderinimą. */
  active_auto_changes_before: number;
  /** Change'ai, kuriuos šis paleidimas perkėlė (arba dry-run režimu perkeltų) į archyvą. */
  archived: { change: string; task: string; marked_task_lines?: number }[];
  /** Done taskai, kurių change'as jau buvo archyve — no-op, bet naudinga matyti. */
  already_archived: string[];
  /** Aktyvūs `auto-*` change'ai, kuriems neatsirado done atitikmens — lieka žmogui. */
  unmatched_auto_changes: string[];
  /** Nieko nerašančios baigtys, kurioms reikia operatoriaus (`ambiguous`, susidūrimas archyve). */
  errors: { task: string; reason: string; change?: string; candidates?: string[] }[];
  /** Vardiniai change'ai su atvirais punktais — TIK informacija, niekada neuždaroma. */
  named_changes_open: { change: string; open_items: number }[];
};

async function listChangeDirs(fs: OpenSpecReconcileFsPort, agRootDir: string): Promise<string[]> {
  const names = await fs.listSubdirectories(path.join(agRootDir, "openspec", "changes"));
  return names.filter((name) => name !== "archive" && name !== "_template").sort();
}

async function listDoneTaskFiles(fs: OpenSpecReconcileFsPort, agRootDir: string): Promise<string[]> {
  const names = await fs.listFiles(path.join(agRootDir, "tasks", "done"));
  return names.filter((name) => name.toLowerCase().endsWith(".md")).sort();
}

/**
 * Nepažymėtų checklist punktų skaičius change'o `tasks.md` faile.
 *
 * Skaičiuojama per `markTasksComplete`, o ne per savą regex'ą, kad ataskaitos skaičius
 * remtųsi TIKSLIAI ta pačia taisykle, kuria archyvavimas žymi punktus (įskaitant fenced
 * code blokų praleidimą) — kitaip „liko N atvirų" ir „pažymėta M" galėtų nesutapti.
 */
async function countOpenChecklistItems(fs: OpenSpecReconcileFsPort, changeDir: string): Promise<number> {
  const text = await fs.readTextFileIfExists(path.join(changeDir, "tasks.md"));
  return text === undefined ? 0 : markTasksComplete(text).marked;
}

/**
 * Suderina istorinį auto-change backlog'ą su `AG/tasks/done` turiniu.
 *
 * Kryptis SĄMONINGAI eina nuo done task'ų prie change'ų, o ne atvirkščiai: taip visą
 * atitikimo sprendimą priima ta pati `resolveAutoChangeForTask` taisyklė, kurią naudoja
 * gyvas užbaigimo kelias. Atvirkštinė kryptis (nuo change slug'o spėti task'ą) reikalautų
 * naujos, niekur kitur negaliojančios euristikos ir galėtų archyvuoti kitos generacijos,
 * dar neužbaigtą darbą — AG task numeriai tarp generacijų kartojasi.
 *
 * Idempotentiška pagal konstrukciją: antrame paleidime tie patys change'ai jau yra archyve,
 * tad `archiveAutoOpenSpecChangeOnDone` grąžina `already-archived` ir nieko nerašo.
 */
export async function reconcileAutoOpenSpecBacklog(
  fs: OpenSpecReconcileFsPort,
  agRootDir: string,
  options: { dryRun?: boolean } = {},
): Promise<OpenSpecReconcileReport> {
  const dryRun = options.dryRun === true;
  const changesRoot = path.join(agRootDir, "openspec", "changes");
  const changeDirs = await listChangeDirs(fs, agRootDir);
  const activeAuto = new Set(changeDirs.filter((name) => name.startsWith("auto-")));
  const namedChanges = changeDirs.filter((name) => !name.startsWith("auto-"));

  const doneFiles = await listDoneTaskFiles(fs, agRootDir);
  const report: OpenSpecReconcileReport = {
    status: "reconciled",
    dry_run: dryRun,
    scanned_done_tasks: doneFiles.length,
    active_auto_changes_before: activeAuto.size,
    archived: [],
    already_archived: [],
    unmatched_auto_changes: [],
    errors: [],
    named_changes_open: [],
  };

  for (const fileName of doneFiles) {
    const taskId = taskFileStem(fileName);
    const doneFile = path.join(agRootDir, "tasks", "done", fileName);

    if (dryRun) {
      // Dry-run NIEKADA nekviečia archyvavimo: planas skaičiuojamas ta pačia atitikimo
      // taisykle, bet be vieno rašymo į diską.
      const doneText = (await fs.readTextFileIfExists(doneFile)) ?? "";
      const match = await resolveAutoChangeForTask(fs, agRootDir, taskId, doneText);
      if (match.kind === "ambiguous") {
        report.errors.push({ task: taskId, reason: "ambiguous", candidates: match.slugs });
        continue;
      }
      if (match.kind === "none" || !activeAuto.has(match.slug)) continue;
      activeAuto.delete(match.slug);
      report.archived.push({ change: changeRef(match.slug), task: taskId });
      continue;
    }

    const outcome = await archiveAutoOpenSpecChangeOnDone(fs, agRootDir, taskId, doneFile);
    switch (outcome.action) {
      case "archived":
        activeAuto.delete(path.basename(outcome.changeDir));
        report.archived.push({
          change: outcome.changeDir,
          task: taskId,
          marked_task_lines: outcome.markedTaskLines,
        });
        break;
      case "already-archived":
        report.already_archived.push(outcome.changeDir);
        break;
      case "error":
        report.errors.push(
          outcome.changeDir === undefined
            ? { task: taskId, reason: outcome.reason }
            : { task: taskId, reason: outcome.reason, change: outcome.changeDir },
        );
        break;
      case "no-change":
        // `missing` yra numatytoji daugumos done task'ų baigtis (jie neturi auto change'o) —
        // ne klaida. `ambiguous` reiškia realų neapsisprendimą ir keliauja į ataskaitą.
        if (outcome.reason === "ambiguous") {
          report.errors.push(
            outcome.candidates === undefined
              ? { task: taskId, reason: "ambiguous" }
              : { task: taskId, reason: "ambiguous", candidates: outcome.candidates },
          );
        }
        break;
    }
  }

  report.unmatched_auto_changes = [...activeAuto].sort().map(changeRef);
  for (const name of namedChanges) {
    const openItems = await countOpenChecklistItems(fs, path.join(changesRoot, name));
    if (openItems > 0) report.named_changes_open.push({ change: changeRef(name), open_items: openItems });
  }
  if (report.unmatched_auto_changes.length > 0 || report.errors.length > 0) report.status = "partial";
  return report;
}
