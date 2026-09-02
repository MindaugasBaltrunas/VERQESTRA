// Loop'o CIKLAS — išorinis ratas aplink bangos planuoklį (etalonas: AG_loop
// orchestrator/loop/loop-runner.ts).
//
// Ciklas nieko nevykdo pats: jis nusprendžia, KADA imti naują darbą ir KADA sustoti. Visa jo
// vertė yra sustojimo taškuose, ir kiekvienas jų pasirinktas dėl konkretaus praradimo:
//
//   - STOP tikrinamas DUKART — rato pradžioje ir dar kartą prieš pat dispatch'ą. Tarp jų telpa
//     bangos planavimas, grafo importas ir `git status`, kurie trunka sekundes: operatoriaus
//     „stop", paspaustas būtent tame lange, be antro varto būtų pastebėtas tik po VISO kito
//     task'o. Vėliava SUVARTOJAMA, todėl jos suvartojimas įsimenamas — kitaip papildymo vartas
//     ją suvalgytų, ir išorinis ratas jos nebepamatytų;
//   - ŠVARUS MEDIS tikrinamas prieš KIEKVIENĄ naują task'ą, ne tik starte: ankstesnio task'o
//     palikti necommit'inti failai užterštų kito task'o sesiją — vykdytojas „taisytų" svetimus
//     sulūžusius testus, o geras darbas būtų atsuktas. Task'as NEJUDINAMAS: lieka eilėje;
//   - FANTOMAS nesustabdo visos eilės. Tai ne operatoriaus sprendimas ir ne task'o baigtis, o
//     sugedęs vieno slot'o izoliacijos įrodymas: task'as pažymimas nevykdytinu (failas lieka
//     eilėje žmogui), o loop'as tęsia nepriklausomas šakas;
//   - INFRASTRUKTŪROS slot baigtis nutraukia visą bėgimą tuo pačiu exit kodu, kuriuo jį nutrauktų
//     in-process kelias. Pirminio medžio slot'as tą daro pats: `run-coordinator-terminal#stopRun`
//     meta `WorkflowInfrastructureError`, kuris pro `runSlotTask` ir `dispatchWaveSlots` iškyla
//     iki `main.ts` ribos. Vaiko procesas mesti negali — jo vienintelė kalba yra exit kodas, tad
//     antrą metimo galą stato ŠIS ratas. Be jo usage limitas (75) vaiko slot'e virsdavo
//     „WAVE SLOT ENDED NONZERO … CONTINUING QUEUE" eilute, ir loop'as tuo pačiu gedimu sudegindavo
//     likusią eilę (2026-09-01: 20 task'ų į human-review per 14 min).
//
// `return`, o ne `continue`, ten kur būsena nepasikeitė: nedispatch'inus nė vieno slot'o kitas
// ratas duotų tą patį rezultatą — karštas ratas vietoj sustojimo.

import { formatWaveBlockedReason } from "./apply-ready-set-gates.js";
import { WorkflowInfrastructureError } from "../../shared/errors.js";
import { dispatchWaveSlots, planWaveDispatch, waveSelectionForSlot } from "./wave-dispatch.js";
import { resolveSlotMode, type LoopControlState } from "./loop-control-store.js";
import type { SlotRefillHold } from "./slot-refill.js";
import type { WaveDispatchSlot } from "./wave-dispatch-model.js";
import type { WaveScheduler, WaveSelection } from "./wave-scheduler-contract.js";
import type { EmptyQueueAction } from "./loop-empty-queue.js";

/** Nutrūkęs task'as, kurį reikia tęsti pirmiau už eilę. */
export type ResumableTask = { bucket: string; file: string };

/**
 * Slot'o vykdymo baigtis, kurioje INFRASTRUKTŪRA atskirta nuo task'o verdikto.
 *
 * `boolean` liko kaip pilnavertė forma sąmoningai: pirminio medžio slot'as infrastruktūrą praneša
 * METIMU, ne reikšme, tad jam trečio varianto niekada neprireiks. Struktūrinę baigtį duoda tik tas
 * kelias, kuriame gedimas ateina kaip vaiko exit kodas ir kitaip būtų neatskiriamas nuo
 * `task-failed` (`slot-task-runner` → `runChild`).
 */
export type SlotRunOutcome =
  | { kind: "succeeded" }
  | { kind: "task-failed" }
  | { kind: "infrastructure"; exitCode: number };

export type LoopCyclePorts = {
  scheduler: WaveScheduler;
  /** Absoliutus task failo kelias; kelio aritmetika lieka kompozicijoje (tas pats portas kaip planuoklyje). */
  absolutePath: (relativeFile: string) => string;
  log: (message: string) => Promise<void>;
  /** Operatoriui matoma išvestis. Sustojimo priežastis privalo pasiekti terminalą, ne tik žurnalą. */
  out: (message: string) => void;
  recordEvent: (event: { run_id: string; wave_id: string; graph_hash: string; event: string; task_id?: string; reason?: string }) => Promise<void>;

  /** Prieš startą: mirusių savininkų lease'ai ir jų paliktos kopijos. Grąžina žurnalo eilutes. */
  reapDeadLeases: () => Promise<string[]>;
  reapOrphanWorktrees: () => Promise<string[]>;
  /** Eilės valymas prieš imant darbą (išgalvoti mazgai, be įrodymų sintezuoti task'ai). */
  reclaimQueue: () => Promise<string[]>;

  /** Stop vėliava, kurią skaitymas SUVARTOJA. */
  consumeStopRequest: () => Promise<boolean>;
  readLoopControl: () => Promise<LoopControlState>;
  productTreeDirtyEntries: () => Promise<{ path: string }[]>;

  selectNextResumableTask: () => Promise<ResumableTask | undefined>;
  /** `true`, kai tęsimas baigėsi sėkmingai. */
  resumeTask: (task: ResumableTask) => Promise<boolean>;
  /** Ar šis nutrūkęs task'as yra sistemos remonto užduotis (jai kelias kitas). */
  isAuditRepairTask: (task: ResumableTask) => boolean;
  processAuditRepairTask: () => Promise<void>;

  handleEmptyQueue: (bootstrapAttempted: boolean) => Promise<EmptyQueueAction>;
  /**
   * Slot'o vykdymas. `boolean` (`true` = sėkmė) ir `SlotRunOutcome` yra ta pati baigtis dviem
   * tikslumais: pirmoji forma sako TIK „pavyko / nepavyko", antroji dar atskiria infrastruktūrą.
   * Abi priimamos, nes tikslumo turi tiek, kiek jo turi vykdymo kelias — o ne tiek, kiek reikia
   * tipui: pirminio medžio kelias infrastruktūrą meta, tad jam `boolean` yra pilnas atsakymas.
   */
  runSlotTask: (slot: WaveDispatchSlot) => Promise<boolean | SlotRunOutcome>;
};

/**
 * Kaip loop'as baigėsi. Vienintelis skirtumas, kurį mato automatika:
 *
 *   `finished` — loop'as padarė, ko buvo prašomas: eilė ištuštinta arba operatorius sustabdė.
 *                Įvykdytas „stop" yra SĖKMĖ, ne gedimas — prašymas buvo išgirstas.
 *   `blocked`  — loop'as sustojo palikęs darbą ir be žmogaus veiksmo toliau nejudės.
 *
 * `reason` čia yra ne tik diagnostika: jis daro kiekvieną naują sustojimo kelią sąmoningu
 * pasirinkimu. Naujas `return` be `reason` neužsikompiliuos, tad kelias negali tyliai atsirasti
 * su numatytu „viskas gerai" — būtent taip `wave-exhausted` ir gyveno kaip exit 0.
 *
 * Infrastruktūros nutraukimo čia NĖRA sąmoningai: jis nėra loop'o verdiktas apie eilę, o aplinkos
 * gedimas, kurio exit kodas (75, 124, 74 …) privalo pasiekti tėvą nepakeistas. Todėl jis lieka
 * `WorkflowInfrastructureError` metimu — vienas kelias abiem medžiams, be antros konvencijos.
 */
export type LoopCycleOutcome =
  | { kind: "finished"; reason: "queue-empty" | "stop-requested" }
  | { kind: "blocked"; reason: "wave-exhausted" | "dirty-tree" | "no-slot-dispatched" };

export async function runLoopCycle(ports: LoopCyclePorts): Promise<LoopCycleOutcome> {
  // Bootstrap bandomas DAUGIAUSIAI kartą per bėgimą: po jo eilė ištuštėja iš naujo, ir be šio
  // skląsčio loop'as bootstrap'intų amžinai, niekada nepasiekdamas galutinio audito.
  let bootstrapAttempted = false;
  // Papildymo vartas stop vėliavą suvartoja bangos viduryje — be įsiminimo išorinis ratas jos
  // nebepamatytų ir suktųsi toliau.
  let stopRequested = false;

  for (const line of await ports.reapDeadLeases()) await ports.log(line);
  // TIK po lease reaper'io: mirusio worker'io `held` lease jau atlaisvintas, tad jo palikta kopija
  // nebeatrodo „gyva" ir nebus praleista.
  for (const line of await ports.reapOrphanWorktrees()) await ports.log(line);
  for (const line of await ports.reclaimQueue()) await ports.log(line);

  const stop = async (message: string, out: string): Promise<void> => {
    await ports.log(message);
    ports.out(out);
  };

  for (;;) {
    if (stopRequested || (await ports.consumeStopRequest())) {
      await stop("LOOP STOP REQUESTED VIA UI; EXITING BETWEEN TASKS", "AG loop stopped by UI request\n");
      return { kind: "finished", reason: "stop-requested" };
    }

    // Nutrūkęs darbas pirmiau už eilę: jo attempt'as jau egzistuoja, ir naujo task'o paleidimas
    // paliktų jį amžinai kaboti.
    const interrupted = await ports.selectNextResumableTask();
    if (interrupted !== undefined) {
      await ports.log(`RESUME INTERRUPTED TASK: bucket=${interrupted.bucket} file=${interrupted.file}`);
      if (ports.isAuditRepairTask(interrupted)) {
        await ports.processAuditRepairTask();
        continue;
      }
      if (!(await ports.resumeTask(interrupted))) await ports.log("RESUMED TASK ENDED NONZERO; CONTINUING QUEUE");
      continue;
    }

    const selection = await ports.scheduler.nextTask();
    if (selection.kind === "empty") {
      const action = await ports.handleEmptyQueue(bootstrapAttempted);
      bootstrapAttempted = true;
      if (action === "continue") continue;
      return { kind: "finished", reason: "queue-empty" };
    }

    if (selection.kind === "exhausted") {
      // Eilėje dar yra task'ų, bet nė vienas nėra ready. Blokuoti priklausiniai SĄMONINGAI lieka
      // eilėje — jų perkėlimas į vykdomą būseną yra būtent tai, ką planuoklis draudžia.
      const reasons = selection.detail ?? formatWaveBlockedReason(selection.reason, selection.plan.blocked);
      await stop(
        `LOOP STOP: wave ${selection.plan.wave_id} has no runnable task: ${reasons}`,
        `AG loop sustabdytas: banga ${selection.plan.wave_id} neturi vykdytinu tasku.\nPriezastys: ${reasons}.\n`,
      );
      return { kind: "blocked", reason: "wave-exhausted" };
    }

    const dirty = await ports.productTreeDirtyEntries();
    if (dirty.length > 0) {
      const preview = dirty
        .slice(0, 5)
        .map((entry) => entry.path)
        .join(", ");
      await stop(
        `LOOP STOP: dirty product tree before next queue task (${dirty.length} file(s)): ${preview}`,
        `AG loop sustabdytas: darbiniame medyje liko ${dirty.length} necommit'intu produkto failu (${preview}).\n` +
          "Sutvarkyk (commit/atstatyk) ir paleisk loop'a is naujo — kitas task'as nebus dispatch'inamas i uztersta medi.\n",
      );
      return { kind: "blocked", reason: "dirty-tree" };
    }

    // Operatoriaus valdiklio vartas stovi PRIEŠ `beginTask` sąmoningai: po jo task'as jau turėtų
    // įrašą ledger'yje ir attempt'ą, kurį kažkas privalėtų užverti — o čia dar nieko nepradėta,
    // tad „nedispatch'inta" yra pilna ir sąžininga būsena.
    const dispatchPlan = planWaveDispatch(selection, await ports.readLoopControl(), ports.absolutePath);

    for (const slot of dispatchPlan.withheld) {
      // Fantomas ir drain'as yra SKIRTINGI faktai: pirmas reiškia sugedusį plano įrodymą, antras —
      // operatoriaus valią. Vienas žodis abiem paslėptų, ką reikia taisyti.
      await ports.log(
        slot.phantom === true
          ? `WAVE SLOT NOT DISPATCHED: slot=${slot.worker_id} task=${slot.task_id} reason=${slot.reason}`
          : `LOOP DRAIN: slot=${slot.worker_id} ${slot.mode === undefined ? `reason=${slot.reason}` : `mode=${slot.mode}`}` +
            ` task=${slot.task_id} not dispatched`,
      );
      await ports.recordEvent({
        run_id: ports.scheduler.runId,
        wave_id: selection.plan.wave_id,
        graph_hash: selection.plan.graph_hash,
        event: slot.phantom === true ? "loop_slot_phantom" : "loop_slot_drained",
        task_id: slot.task_id,
        reason: slot.reason,
      });
    }

    if (dispatchPlan.halted) {
      const phantoms = dispatchPlan.withheld.filter((slot) => slot.phantom === true);
      if (phantoms.length === dispatchPlan.withheld.length && phantoms.length > 0) {
        // Sustabdyti visą eilę dėl fantomo būtų per plati bausmė. `continue` čia nėra karštas
        // ratas: blokuotas task'as į kitos bangos ready set'ą nebepatenka, tad kiekviena iteracija
        // arba juda prie kito darbo, arba baigiasi bangos blokada.
        for (const slot of phantoms) await ports.scheduler.blockUnrunnableTask(slot.task_id, slot.reason);
        continue;
      }

      const first = dispatchPlan.withheld.at(0);
      // Valdiklio režimas ir izoliacijos trūkumas yra skirtingi faktai, tad „operatoriaus
      // nustatytas" negali būti sakomas apie abu.
      const cause =
        first?.mode === undefined ? `nedispatch'intas: ${first?.reason ?? "unknown"}` : `operatoriaus nustatytas i "${first.mode}"`;
      const phantomHint = dispatchPlan.withheld.some((slot) => slot.phantom === true)
        ? "Bangos planas isdave slot'a be galiojancio izoliacijos irodymo:\n" +
          "sutvarkyk lease busena arba task'o scope ir paleisk loop'a is naujo.\n"
        : "";
      await stop(
        `LOOP STOP: no slot dispatched (${cause})`,
        `AG loop sustabdytas: slot'as ${first?.worker_id ?? "w1"} ${cause}.\n` +
          `Task'as ${first?.task_id ?? selection.task.task_id} liko eileje ir nebuvo dispatch'intas.\n` +
          phantomHint,
      );
      return { kind: "blocked", reason: "no-slot-dispatched" };
    }

    if (await ports.consumeStopRequest()) {
      await stop("LOOP STOP REQUESTED VIA UI; EXITING BEFORE NEXT DISPATCH", "AG loop stopped by UI request\n");
      return { kind: "finished", reason: "stop-requested" };
    }

    // Papildyti slot'ai gimsta UŽ bangos plano ribų, tad jų pasirinkimas neatkuriamas iš
    // `selection` — jį pagamino papildymo sprendimas, ir tik jis neša teisingą leidimo autoritetą.
    const refilled = new Map<string, Extract<WaveSelection, { kind: "task" }>>();

    /**
     * Šios bangos infrastruktūros baigtys. Du įrašai, nes atsakomi du skirtingi klausimai:
     * `infrastructureTasks` — „ar ŠIS slot'as krito dėl aplinkos" (nulemia, kurios eilutės
     * nerašomos), o `infrastructureAbort` — „kuo baigiasi bėgimas".
     *
     * Laimi PIRMA pastebėta baigtis: būtent ji sustabdė papildymą, tad ji ir yra bėgimo
     * nutraukimo priežastis. Vėlesnė jau krinta į bangą, kuri nutraukiama, ir kodo keisti
     * nebegali — kitaip tas pats gedimas duotų skirtingą exit kodą priklausomai nuo to, kuris
     * lane'as baigė greičiau.
     */
    const infrastructureTasks = new Set<string>();
    let infrastructureAbort: { slot: WaveDispatchSlot; exitCode: number } | undefined;

    const results = await dispatchWaveSlots(dispatchPlan.dispatch, {
      beginTask: (slot) => ports.scheduler.beginTask(refilled.get(slot.task_id) ?? waveSelectionForSlot(selection, slot)),
      runTask: async (slot) => {
        const outcome = await ports.runSlotTask(slot);
        if (typeof outcome === "boolean") return outcome;
        if (outcome.kind !== "infrastructure") return outcome.kind === "succeeded";
        infrastructureTasks.add(slot.task_id);
        infrastructureAbort ??= { slot, exitCode: outcome.exitCode };
        await ports.log(
          `WAVE SLOT INFRASTRUCTURE EXIT: slot=${slot.worker_id} task=${slot.task_id} exit=${outcome.exitCode}`,
        );
        // `false` yra SĄMONINGAS: baigties apskaita (`recordOutcome` → `wave-outcome`) ir toliau
        // mato terminalinę nesėkmę, tad banga užsidaro, lease'ai atlaisvinami ir integracija
        // sprendžiama kaip visada. Kur ta nesėkmė NĖRA task'o kaltė — parkavimo klausimas —
        // sprendžia `worker-integration`, ne šis ratas.
        return false;
      },
      recordOutcome: (taskId, ok) => ports.scheduler.recordOutcome(taskId, ok),
      refill: async (freed) => {
        if (!stopRequested && (await ports.consumeStopRequest())) stopRequested = true;
        const mode = resolveSlotMode(await ports.readLoopControl(), freed.worker_id);
        // Laikymo prasmė skiriasi: `stop` liečia VISĄ loop'ą, o `drain`/`abort` — būtent šį
        // slot'ą. Nė vienas jų nenutraukia jau vykdomo bandymo; jie tik neduoda naujo darbo.
        //
        // Infrastruktūra laikoma `stop-requested` rūšimi, ne nauja: apimtis ta pati — visas
        // loop'as, o ne šis slot'as — ir naujas `kind` reikštų tą patį faktą dviem vardais tiems
        // patiems vartams. Kodėl laikoma, matyti iš `detail`; naujo darbo aplinkoje, kuri ką tik
        // nužudė vaiką, duoti nėra ko: kitas slot'as žūtų ta pačia sekunde ir ta pačia priežastimi.
        const hold: SlotRefillHold = infrastructureAbort !== undefined
          ? { kind: "stop-requested", detail: "loop-infrastructure.abort" }
          : stopRequested
          ? { kind: "stop-requested", detail: "loop-stop.requested" }
          : mode === "run"
            ? { kind: "none" }
            : { kind: "slot-drained", detail: `${freed.worker_id}:${mode}` };
        const refill = await ports.scheduler.refillSlot(freed.worker_id, hold);
        if (refill === undefined) return undefined;
        refilled.set(refill.slot.task_id, refill.selection);
        return refill.slot;
      },
      onLaneError: async (slot, error) => {
        await ports.log(
          `WAVE SLOT FAILED: slot=${slot.worker_id} task=${slot.task_id} error=${error instanceof Error ? error.message : String(error)}`,
        );
      },
    });

    for (const result of results) {
      if (result.ok) continue;
      // Atšauktas slot'as jau turi savo eilutę ir nėra žlugęs: task'ą iš eilės išėmė kitas
      // mechanizmas be jokio bandymo, tad „ENDED NONZERO" apie jį būtų klaidingas signalas.
      if (ports.scheduler.isSlotWithdrawn(result.slot.task_id)) continue;
      // Infrastruktūros slot'as savo eilutę jau turi, o „CONTINUING QUEUE" apie jį būtų MELAS:
      // eilė kaip tik nebetęsiama. Būtent ši eilutė ir buvo vienintelis vaiko infra baigties
      // pėdsakas, kol jos semantika skyrėsi nuo in-process kelio.
      if (infrastructureTasks.has(result.slot.task_id)) continue;
      await ports.log(
        results.length > 1
          ? `WAVE SLOT ENDED NONZERO: slot=${result.slot.worker_id} task=${result.slot.task_id}; CONTINUING QUEUE`
          : "TASK ENDED NONZERO; CONTINUING QUEUE",
      );
    }

    if (infrastructureAbort !== undefined) {
      const { slot, exitCode } = infrastructureAbort;
      // Metama TIK po `dispatchWaveSlots`: kiti lane'ai iki čia jau baigti ir užfiksuoti, tad
      // nutraukimas nepalieka nė vieno neprižiūrimo vaiko — ta pati taisyklė, kuria pats
      // dispatch'as atideda metančio lane'o klaidą.
      //
      // Eilutės ir žinutės forma sutampa su `run-coordinator-terminal#stopRun`: viena baigtis
      // negali turėti dviejų vardų žurnale vien dėl to, kuriame medyje ji įvyko. Vėliavos
      // (`taskReturnedToQueue`, `taskPreservedForResume`) lieka numatytos SĄMONINGAI — šis ratas
      // task failų nejudina, o vaiko slot'o failo likimą sprendžia `worker-integration`.
      await stop(
        `LOOP ABORT (infrastruktura): stage=wave-slot exit=${exitCode} task=${slot.task_id}` +
          ` slot=${slot.worker_id} refill=held`,
        `AG loop nutrauktas: slot'as ${slot.worker_id} (task ${slot.task_id}) baigesi infrastrukturos gedimu` +
          ` (exit ${exitCode}).\n` +
          "Banga daugiau neuzpildoma. Sutvarkyk aplinka (pvz. palauk usage limito atsistatymo) ir paleisk loop'a is naujo.\n",
      );
      throw new WorkflowInfrastructureError(
        `wave-slot infrastructure failure exit=${exitCode} task=${slot.task_id} slot=${slot.worker_id}`,
        { exitCode },
      );
    }
  }
}
