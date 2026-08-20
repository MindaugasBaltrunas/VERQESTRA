/** Construction and lookup rules for mutable state owned by one task run. */
import type { TaskRunPorts } from "./run-coordinator-ports.js";

/**
 * Vieno task vykdymo būsena ir jos lokalių failų nuosavybė.
 */
export type TaskRunState = {
  /** Failo vardas su `.md` — juo task'as judinamas tarp bucket'ų. */
  readonly taskName: string;
  readonly taskId: string;
  readonly baseHead: string | undefined;
  readonly knownTaskFiles: ReadonlySet<string>;
  activeFile: string;
  delegatedFile: string;
  errorFile: string;
  fingerprint: string;
  lastQualityGateExitCode?: number;
  /**
   * „Cheap finish paruošimas šiame run'e jau bandytas" (trečias vieno karto saugiklis šalia
   * durablios žymės ir retry skaitiklio inkremento). Keliama PRIEŠ paruošimą, tad nepavykęs
   * paruošimas antro bandymo tame pačiame run'e nebegauna.
   *
   * Nuosavybė: `run-coordinator.ts` cheap finish kelias.
   */
  cheapFinishArmed?: boolean;
  /**
   * „Cheap finish dispatch'as REALIAI įvyko" — vykdytojas buvo paleistas (arba pats atmetė
   * kvietimą), t. y. sesijos rezultatas egzistuoja.
   *
   * Ši vėliava, o ne {@link cheapFinishArmed}, valdo abu semantinius sprendimus: `cheap_finish_failed=1`
   * parkavimą verifikacijos cikle ir `rollback-stable` slopinimą terminaliniame perėjime. Vetuotas
   * PRIEŠ vykdytoją dispatch'as jos NEKELIA — sesijos nebuvo, tad ir „cheap finish nepavyko" nėra
   * ką teigti, o įprastas repair kelias lieka teisingas.
   *
   * Nuosavybė: `run-coordinator.ts` cheap finish kelias.
   */
  cheapFinishUsed?: boolean;
  /**
   * Task kūno kopija, paimta run'o pradžioje (etalono task 0000-1): kai terminalinio perėjimo
   * metu failo nebėra NĖ VIENAME žinomame kelyje (paralelinė integracija ar repair jį ištrynė),
   * terminalinė kopija atkuriama iš šio turinio, vietoje `Unique move source file does not exist`
   * metimo, kuris užmušdavo visą run'ą exit 2.
   */
  readonly taskBodySnapshot: string | undefined;
  remember(filePath: string): string;
  /** Pirmas egzistuojantis iš [active, error, delegated]; kitaip `activeFile`. */
  resolveCurrentTaskFile(): Promise<string>;
};

export async function createTaskRunState(
  taskFile: string,
  ports: TaskRunPorts,
  options: { interrupted?: boolean } = {},
): Promise<TaskRunState> {
  const taskName = taskFileBasename(taskFile);
  const knownTaskFiles = new Set<string>([taskFile]);
  // Snapshot'as imamas čia, kol failas garantuotai egzistuoja; neperskaitomas failas run'o
  // nestabdo — atkūrimo saugiklis tada tiesiog neturi turinio ir perėjimas meta kaip iki šiol.
  let taskBodySnapshot: string | undefined;
  try {
    taskBodySnapshot = await ports.tasks.readTaskBody(taskFile);
  } catch {
    taskBodySnapshot = undefined;
  }
  const state: TaskRunState = {
    taskName,
    taskId: ports.tasks.taskIdOf(taskFile),
    baseHead: await ports.git.head(),
    knownTaskFiles,
    taskBodySnapshot,
    activeFile: ports.tasks.bucketPath("active", taskName),
    delegatedFile: ports.tasks.bucketPath("delegated", taskName),
    errorFile: ports.tasks.bucketPath("error", taskName),
    fingerprint: await ports.tasks.fingerprint(taskFile),
    remember(filePath: string): string {
      knownTaskFiles.add(filePath);
      return filePath;
    },
    async resolveCurrentTaskFile(): Promise<string> {
      for (const candidate of [state.activeFile, state.errorFile, state.delegatedFile]) {
        if (await ports.tasks.exists(candidate)) {
          return candidate;
        }
      }
      return state.activeFile;
    },
  };

  if (options.interrupted) {
    const bucket = ports.tasks.bucketOf(taskFile);
    if (bucket === "active") {
      state.activeFile = taskFile;
    } else if (bucket === "delegated") {
      state.delegatedFile = taskFile;
    } else if (bucket === "error") {
      state.errorFile = taskFile;
    }
  }

  return state;
}

/** `path.basename` be `node:path` importo — application sluoksnis neliečia Node FS API. */
export function taskFileBasename(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, "");
  const cut = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return cut === -1 ? normalized : normalized.slice(cut + 1);
}
