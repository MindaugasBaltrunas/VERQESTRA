/**
 * Kanoninio task vykdymo koordinatoriaus vidiniai kontraktai (VQ-304 2/3).
 *
 * Etalone šie tipai gyveno pačiame `run-coordinator.ts`; VERQESTRA juos iškelia į atskirą
 * -model failą, nes koordinatorius skaidomas pagal 500 eil. gate — terminal/cheap-finish/
 * integration moduliai dalijasi šiais tipais, o tipų kėlimas į atskirą failą neleidžia
 * atsirasti importų ciklams (gate'as draudžia ciklus net type-only).
 */
import type {
  AlreadyImplementedVia,
  InterruptedTaskBucket,
  IntegrationRunRequest,
  IntegrationRunResult,
  TaskDecision,
} from "./run-coordinator-ports.js";

/**
 * Cheap finish bandymo baigtis verifikacijos ciklui:
 *   `not-armed` — cheap finish netaikomas, kvietėjas tęsia įprastą kelią;
 *   `dispatched` — dispatch'as praėjo, ciklas suka dar vieną verifikacijos ratą;
 *   `terminal`   — dispatch'as baigėsi terminaliai (human-review), rezultatas jau pritaikytas.
 */
export type CheapFinishOutcome = { kind: "not-armed" } | { kind: "dispatched" } | { kind: "terminal"; result: boolean };

/**
 * Etalono task 0045 — ką integracijos vartai palieka daryti done keliui.
 *
 * `proceed` yra VIENINTELIS kelias į `applyTerminal({ kind: "done" })`: nei `parked`, nei
 * `infrastructure` niekada nevirsta tyliu patvirtinimu.
 */
export type IntegrationGateOutcome =
  | { kind: "proceed" }
  | { kind: "parked" }
  | { kind: "infrastructure"; exitCode: number; detail: string };

export type TerminalTransition =
  | { kind: "human-review"; reason: string }
  | { kind: "retry-limit-human-review" }
  | { kind: "rollback-human-review"; decision: TaskDecision }
  | { kind: "done" }
  | { kind: "done-already-implemented"; via: AlreadyImplementedVia }
  | { kind: "duplicate"; queuedFile: string };

export type RunCoordinator = {
  /** queue -> active -> preflight -> delegate -> dispatch -> verify/repair ciklas. */
  start(queuedFile: string): Promise<boolean>;
  /** Nutrūkusio vykdymo tęsimas iš `active` | `delegated` | `error`. */
  resume(bucket: InterruptedTaskBucket, taskFile: string): Promise<boolean>;
  /**
   * IVER-3: rizika pagrįsta integracijos peržiūra ir siauras integracijos repair'as.
   * Terminalinis human-review perėjimas eina per tą patį `applyTerminal` sprendėją, kaip ir
   * kiekvienas kitas — integracija negauna savo lygiagretaus terminalinio kelio.
   */
  reviewIntegration(request: IntegrationRunRequest): Promise<IntegrationRunResult>;
  /**
   * Infrastruktūros abort: preserve-vs-requeue + `WorkflowInfrastructureError`.
   *
   * `detail` yra neprivalomas, trumpas gedimo identifikatorius (pvz.
   * `config=vq/config/agents.json`): jis įterpiamas ir į abort'o log eilutę, ir į klaidos
   * žinutę, kurią operatoriui parodo loop'as, kad būtų matyti, KĄ taisyti prieš restartą.
   * Be jo abort'o tekstas lieka baitas-į-baitą toks pat kaip iki etalono task 0032.
   */
  stop(stage: string, exitCode: number, detail?: string): Promise<never>;
};

export type RunCoordinatorOptions = {
  preflightCmd?: string;
  diagnoseCmd?: string;
};
