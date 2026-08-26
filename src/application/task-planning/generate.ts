// OpenSpec/spec task planavimo use-case: išsprendžia aktyvų task planą, atrenderina po
// vieną queue task failą kiekvienai implementacijos eilutei ir praleidžia jau
// egzistuojančius failus. Elgesio etalonas: AG_loop application/task-planning/generate.ts.
// Gauna jau parsintus options — CLI komandai lieka tik argumentų parsinimas.

import path from "node:path";
import { taskBuckets } from "../../domain/tasks/buckets.js";
import { taskNumberFromFilename, taskSlug } from "../../domain/tasks/identity.js";
import { loadEnforcementPolicy } from "../policy-governance/architecture-policies.js";
import type { PolicyConfigFileSystemPort } from "../policy-governance/ports.js";
import { parseSpecTaskLines } from "./spec-task-lines.js";
import { renderQueueTask } from "./queue-task.js";
import { findActiveSpec, findOpenSpecTaskPlan, type TaskPlanningFsPort } from "./spec-source.js";

export type TaskGeneratePorts = {
  fs: TaskPlanningFsPort & PolicyConfigFileSystemPort & {
    makeDirectory(absoluteDir: string): Promise<void>;
    /** Rašymas `wx` semantika: `created` arba `exists` (jau esamas failas NEperrašomas). */
    writeFileExclusive(absolutePath: string, content: string): Promise<"created" | "exists">;
    /** Failų vardai; `[]` kai katalogo nėra. */
    listFiles(absoluteDir: string): Promise<string[]>;
  };
};

export type TaskGenerateOptions = {
  openspecChangeId?: string;
  startIndex: number;
};

export type TaskGenerateResult = {
  specId: string;
  tasksPath: string;
  created: string[];
  /**
   * Istoriškai žymėjo failus, praleistus dėl `writeFileExclusive` "exists" atsakymo — bet tai
   * tyliai prarasdavo taskLine turinį (numeris likdavo svetimo task'o). Nuo pertikrinimo su
   * ribotu retry (žr. `MAX_ASSIGNMENT_ATTEMPTS`) kolizija visada arba išsprendžiama pasirenkant
   * kitą numerį, arba meta klaidą — šis laukas sėkmingame kelyje praktiškai visada `[]`. Laukas
   * paliktas tipe, nes CLI jį spausdina, ne todėl, kad jis dar žymi prarastą turinį.
   */
  skipped: string[];
};

/**
 * DUP-14 etalono taisyklė: `--start` yra kvietėjo užuomina, niekada nevedama iš disko
 * vien pati — naujas numeris imamas kaip max(start, realus cross-bucket maksimumas + 1),
 * kad negeneruotų kolizijos su numeriu, jau užimtu BET KURIAME AG/tasks/* bucket'e.
 */
export async function nextAvailableTaskNumber(
  ports: TaskGeneratePorts,
  projectRoot: string,
): Promise<number> {
  let max = 0;
  for (const bucket of taskBuckets) {
    const files = await ports.fs.listFiles(path.join(projectRoot, "AG", "tasks", bucket));
    for (const file of files) {
      const number = taskNumberFromFilename(file);
      if (number !== undefined && number > max) max = number;
    }
  }
  return max + 1;
}

/**
 * Ribojam retry, kiek `taskGenerate` bando kitą numerį tai pačiai `taskLine`, kai pasirinktas
 * numeris pasirodo užimtas. Riba absorbuoja tiek vidinę to paties run kaskadą (kai kelios šio
 * run'o eilutės susikerta viena su kita), tiek 1-2 realius konkurentus, bet neleidžia begalinio
 * skenavimo sugadintoje bucket būsenoje — tada geriau aiški klaida, nei begalinė kilpa.
 */
const MAX_ASSIGNMENT_ATTEMPTS = 10;

/** Ar `candidate` jau užimtas KURIAME NORS `AG/tasks/*` bucket'e. */
async function isTaskNumberInUse(
  ports: TaskGeneratePorts,
  projectRoot: string,
  candidate: number,
): Promise<boolean> {
  for (const bucket of taskBuckets) {
    const files = await ports.fs.listFiles(path.join(projectRoot, "AG", "tasks", bucket));
    for (const file of files) {
      if (taskNumberFromFilename(file) === candidate) return true;
    }
  }
  return false;
}

export async function taskGenerate(
  ports: TaskGeneratePorts,
  options: TaskGenerateOptions,
  projectRoot = process.cwd(),
  runtimeRoot?: string,
): Promise<TaskGenerateResult> {
  const root = path.resolve(projectRoot);
  const vqRoot = runtimeRoot ?? path.join(root, "vq");
  const activeSpec = options.openspecChangeId
    ? await findOpenSpecTaskPlan(ports.fs, root, options.openspecChangeId)
    : await findActiveSpec(ports.fs, root);
  const tasksPath = path.join(activeSpec.changeDir, "tasks.md");
  const tasksText = await ports.fs.readTextFileIfExists(tasksPath);
  if (tasksText === undefined) {
    throw new Error(`Active spec task plan missing: ${tasksPath}`);
  }

  const taskLines = parseSpecTaskLines(tasksText, {
    requireCheckbox: options.openspecChangeId !== undefined,
  }).filter((taskLine) => !taskLine.complete);
  if (taskLines.length === 0) {
    throw new Error(`No implementation task lines found in ${tasksPath}`);
  }

  const enforcement = await loadEnforcementPolicy(ports.fs, vqRoot);
  const queueDir = path.join(root, "AG", "tasks", "queue");
  await ports.fs.makeDirectory(queueDir);

  const result: TaskGenerateResult = {
    specId: activeSpec.id,
    tasksPath: activeSpec.relativeTasksPath,
    created: [],
    skipped: [],
  };

  const startIndex = Math.max(options.startIndex, await nextAvailableTaskNumber(ports, root));

  // Kiekviena taskLine turi SAVO augantį numerį, kuris juda tik pirmyn prieš savo paties
  // rašymą — jau sėkmingai parašyti kitų taskLine failai niekada nekeičiami/nepervadinami.
  for (const taskLine of taskLines) {
    let taskNumber = startIndex + taskLine.index - 1;
    let attempts = 0;

    for (;;) {
      attempts += 1;

      // Pertikriname PRIEŠ kiekvieną writeFileExclusive bandymą: startIndex buvo parinktas
      // vieną kartą prieš ciklą, tad lygiagretus taskGenerate kvietimas (arba šio paties run
      // kaskada) galėjo tą numerį jau užimti.
      const inUse = await isTaskNumberInUse(ports, root, taskNumber);
      let written: "created" | "exists" = "exists";
      if (!inUse) {
        const fileName = `${String(taskNumber).padStart(3, "0")}-${taskSlug(taskLine.title)}.md`;
        const filePath = path.join(queueDir, fileName);
        const relativePath = path.relative(root, filePath).replace(/\\/g, "/");
        const content = renderQueueTask(taskLine, activeSpec.relativeSpecPath, result.tasksPath, enforcement);

        written = await ports.fs.writeFileExclusive(filePath, content);
        if (written === "created") {
          result.created.push(relativePath);
          break;
        }
        // TOCTOU: pertikrinimas aukščiau numerį rodė laisvą, bet writeFileExclusive vis tiek
        // rado failą — kitas procesas spėjo jį parašyti tarp patikros ir rašymo. Tai irgi
        // kolizija, ne prarastas turinys: bandome kitą numerį, NEpridedame prie `skipped`.
      }

      // `taskNumber` čia yra kandidatas, kuris KĄ TIK buvo faktiškai patikrintas (inUse arba
      // TOCTOU exists) ir pralaimėjo — pranešime jis lieka teisingas net paskutiniame bandyme,
      // nes riba tikrinama PRIEŠ pereinant prie kito kandidato, o ne po jo parinkimo.
      if (attempts >= MAX_ASSIGNMENT_ATTEMPTS) {
        throw new Error(`Task number ${taskNumber} still colliding after ${attempts} attempts`);
      }
      taskNumber += 1;
    }
  }

  return result;
}
