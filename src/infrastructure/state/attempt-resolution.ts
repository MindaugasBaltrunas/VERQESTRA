// Attempt rezoliucijos PORTAS ir jo vartotojų adapteriai (etalonai: AG_loop
// runtime/attempt-identity.ts + loop/resume-checkpoint.ts kontrakto pusė).
//
// PILNAS resolveActiveAttempt (env/wave-snapshot/resume-checkpoint evidencija +
// retry-counts aritmetika) gyvena etalono orchestrator/loop — jis migruoja kartu su loop
// kompozicija (E5). Telemetrijos rašytojams (token-usage, stop-bridge) reikia tik
// KONTRAKTO: „duok šio task'o aktyvų attempt handle arba įvardytą priežastį, kodėl ne".

import type { RuntimeAttemptHandle } from "../persistence/runtime-artifact-store.js";
import type { RuntimeAttemptManifest } from "../persistence/runtime-attempt-schema.js";
import type { AttemptIdentityPort } from "../../application/context-pack/metrics.js";

/** `AG_RUNTIME_ARTIFACTS` kill switch — įjungta, nebent aiškiai 0/false/off. */
export function runtimeArtifactsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["AG_RUNTIME_ARTIFACTS"]?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

export type AttemptResolutionFailure =
  /** Kill switch OFF. */
  | "disabled"
  /** Nėra iš ko išvesti run_id — normali repo be vq/runtime būsena, NE klaida. */
  | "no-runtime"
  /** runtime-paths atmetė segmentą. */
  | "invalid-identity"
  /** `create:false`, o attempt'as dar neegzistuoja. */
  | "not-created"
  /** Katalogas priklauso kitam run/worker/task — NIEKADA nerašoma. */
  | "identity-mismatch"
  /** Saugyklos IO/schemos klaida. */
  | "store";

export type ResolvedRuntimeAttempt = {
  handle: RuntimeAttemptHandle;
  manifest: RuntimeAttemptManifest;
};

export type AttemptResolutionResult =
  | { ok: true; attempt: ResolvedRuntimeAttempt }
  | { ok: false; reason: AttemptResolutionFailure; errors: string[] };

/**
 * Aktyvaus attempt'o rezoliucija. Telemetrijos kvietėjai VISADA `create:false` semantika —
 * telemetrija niekada nesukuria namespace'o (etalono attempt-identity taisyklė).
 */
export type AttemptResolutionPort = {
  resolveActiveAttempt(taskId: string, env?: NodeJS.ProcessEnv): Promise<AttemptResolutionResult>;
};

/** Fiksuotas „niekada nerandu" resolveris — kompozicijoms be runtime namespace'o ir testams. */
export const noRuntimeAttemptResolution: AttemptResolutionPort = {
  resolveActiveAttempt: () => Promise.resolve({ ok: false, reason: "no-runtime", errors: [] }),
};

export type RuntimeAttemptIdentity = {
  run_id: string;
  worker_id: string;
  runtime_attempt_id: string;
};

/**
 * Tapatybės laukai, paruošti merginti į telemetrijos įrašą. Kai attempt'as
 * neišsprendžiamas — tuščias objektas: laukai lieka `undefined`, o ne `null`/tuščia
 * eilutė, kad senos ir naujos be-manifesto eilutės liktų neatskiriamos.
 */
export function runtimeAttemptIdentityFields(
  attempt: ResolvedRuntimeAttempt | undefined,
): Partial<RuntimeAttemptIdentity> {
  if (!attempt) return {};
  return {
    run_id: attempt.manifest.run_id,
    worker_id: attempt.manifest.worker_id,
    runtime_attempt_id: attempt.manifest.attempt_id,
  };
}

/**
 * Context-pack telemetrijos `AttemptIdentityPort` (task 0045) tiekėjas: ta pati tapatybė
 * kaip token-usage rašytojo — context-size ir usage eilutės iš TO PATIES bandymo neša tą
 * patį run_id/worker_id/runtime_attempt_id.
 */
export function attemptIdentityAdapter(resolution: AttemptResolutionPort): AttemptIdentityPort {
  return {
    async identityFields(taskId: string) {
      const resolved = await resolution.resolveActiveAttempt(taskId);
      return runtimeAttemptIdentityFields(resolved.ok ? resolved.attempt : undefined);
    },
  };
}
