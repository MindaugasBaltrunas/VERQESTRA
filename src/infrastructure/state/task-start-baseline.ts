// Task'o starto bazės SKAITYMAS iš tų pačių dviejų vietų, į kurias rašo gamintojas.
//
// Gamintojas yra `composition/loop/coordinator-adapters` (`recordTaskStartStatus`): tą patį
// payload'ą jis rašo ir į bandymo namespace'ą, ir į globalų veidrodį
// `vq/state/task-start-status.json`. Iki 2026-08-25 skaitytojai žiūrėjo TIK į pirmąją vietą.
//
// Kodėl tai buvo tyli katastrofa: kiekvienas dispatch'as žurnale rašė
// `runtime attempt namespace unavailable … reason=no-runtime`, o `no-runtime` pačiame
// `attempt-resolution` kode aprašytas kaip „normali repo be vq/runtime būsena, NE klaida". Taigi
// skaitytojas normalioje būsenoje tyliai grąžindavo „bazės nėra", `taskEvidenceRangeArgs` uždarydavo
// įrodymų langą į `HEAD..HEAD`, ir `hasWorkEvidence` NIEKADA negalėjo tapti `true`. Pasekmė —
// kiekvienas `ALREADY_IMPLEMENTED` task'as garantuotai nusileisdavo į human-review (2026-08-25
// eilėje taip krito 004, 005 ir 008), nors darbas seniai buvo padarytas.
//
// Skaitytojas dabar seka gamintojo tvarką: bandymo namespace pirmas (jis tikslesnis — priklauso
// KONKREČIAM bandymui), globalus veidrodis antras. Langas nuo to nepraplatėja: kvietėjas vis tiek
// atmeta bazę, kurios `task_id` nesutampa, tad pasenęs veidrodis duoda lygiai tą patį tuščią langą
// kaip ir anksčiau. Praplatėja tik atvejis, kai bazė TIKRAI yra — tik ne toje vietoje, kurioje
// skaitytojas iki šiol vienintelėje ir žiūrėjo.

import path from "node:path";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";
import { tryParseJson } from "../../shared/json.js";
import type { AttemptResolutionPort } from "./attempt-resolution.js";

/** Bazės poaibis, kurio reikia įrodymų langui — daugiau laukų skaitytojai neliečia. */
export type TaskStartBaseline = {
  task_id?: string;
  base_head?: string;
};

export type ReadTaskStartBaselineInput = {
  taskId: string;
  /** vq runtime šaknis — globalaus veidrodžio kelias (`<runtimeRoot>/state/…`). */
  runtimeRoot: string;
  resolution: AttemptResolutionPort;
  /** Neblokuojantis įspėjimas, kai bandymo namespace krito dėl REALIOS degradacijos. */
  warn?: (line: string) => Promise<void>;
};

/** Globalus veidrodis; `undefined`, kai failo nėra arba jis nesiskaito (spėti draudžiama). */
async function readGlobalMirror(runtimeRoot: string): Promise<TaskStartBaseline | undefined> {
  const raw = await nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "state", "task-start-status.json"));
  if (raw === undefined) return undefined;
  const parsed = tryParseJson<TaskStartBaseline>(raw);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object") return undefined;
  return parsed.value;
}

/**
 * Bazė iš bandymo namespace'o, o jo nesant — iš globalaus veidrodžio.
 *
 * `disabled`/`no-runtime`/`not-created` yra normalios būsenos ir tyli; likusios reiškia realią
 * degradaciją ir yra matomos — bet nė viena jų nebeuždaro įrodymų lango, kol veidrodis yra.
 */
export async function readTaskStartBaseline(
  input: ReadTaskStartBaselineInput,
): Promise<TaskStartBaseline | undefined> {
  if (input.taskId.trim() === "") return undefined;

  const resolved = await input.resolution.resolveActiveAttempt(input.taskId);
  if (resolved.ok) {
    const read = await resolved.attempt.handle.readJson<TaskStartBaseline>("task-start-status");
    if (read.ok) return read.data;
  } else if (resolved.reason !== "disabled" && resolved.reason !== "no-runtime" && resolved.reason !== "not-created") {
    await input.warn?.(
      `WARNING: task-start baseline attempt read failed task=${input.taskId} reason=${resolved.reason} — using global mirror`,
    );
  }

  return await readGlobalMirror(input.runtimeRoot);
}
