// Klaida → HTTP atsakymas (etalonas: AG_loop interfaces/http/ui-server.ts `write*Error` blokas).
//
// GRYNAS atvaizdis, ne rašymas į srautą: statusas ir kūnas sprendžiami čia, o siuntimas lieka
// serveriui. Taip visos ribos (kas yra 400, kas 409, kas 500) tikrinamos be HTTP.
//
// Taisyklė, dėl kurios modulis egzistuoja: VARTOTOJO klaida NIEKADA nėra 500. Iki etalono
// 2026-08-06 audito netinkamas failo tipas, per didelis įkėlimas ir sugadintas JSON grįždavo kaip
// „Internal server error", tad dashboard'as rodydavo HTTP 500, o vartotojas nesužinodavo, kad
// problema jo faile.
//
// Antra taisyklė: klaidos ŽINUTĖ į klientą patenka tik tada, kai ji yra apie jo įvestį. Vidinės
// detalės (keliai, stack, lease ir savininko id su PID) lieka serverio pusėje.

import { ZodError } from "zod";
import { InvalidUploadError, UploadTooLargeError } from "./task-upload.js";
import {
  InvalidTaskReferenceError,
  TaskAuthorityError,
  TaskBucketConflictError,
  TaskNotFoundError,
} from "./ui-task-actions.js";
import { InvalidLoopControlError } from "../../application/scheduling/loop-control-store.js";
import { InvalidWorkerRequestError } from "../../application/scheduling/worker-request-store.js";
import { UnsupportedPolicyFileError } from "../../application/policy-governance/policy-file-registry.js";
import {
  HumanReviewApprovalRequiredError,
  ProposalCancelConflictError,
  ProposalNotApprovedError,
} from "../../application/policy-governance/policy-proposal-service.js";

export type HttpErrorResponse = {
  status: number;
  /** JSON kūnas; `undefined` reiškia plain-text atsakymą su `text`. */
  body?: { error: string } | undefined;
  text?: string | undefined;
};

/** Bendras 500: detalės NEATSKLEIDŽIAMOS, jos lieka serverio žurnale. */
export const INTERNAL_ERROR_RESPONSE: HttpErrorResponse = {
  status: 500,
  text: "Internal server error",
};

export const FORBIDDEN_TOKEN_RESPONSE: HttpErrorResponse = {
  status: 403,
  text: "Forbidden: invalid UI session token",
};

export const FORBIDDEN_HOST_RESPONSE: HttpErrorResponse = {
  status: 403,
  text: "Forbidden: invalid host",
};

function jsonError(status: number, message: string): HttpErrorResponse {
  return { status, body: { error: message } };
}

/**
 * Įkėlimo klaidos: netinkamas turinys — 400, per didelis — 413. Abi yra vartotojo klaidos, tad jų
 * žinutė perduodama: būtent ji pasako, kuris failas ir kodėl netiko.
 */
export function mapUploadError(error: unknown): HttpErrorResponse {
  if (error instanceof InvalidUploadError) return jsonError(400, error.message);
  if (error instanceof UploadTooLargeError) return jsonError(413, error.message);
  return INTERNAL_ERROR_RESPONSE;
}

/**
 * Triažo klaidos: netinkama nuoroda (400), nežinomas task'as (404), svetimas bucket'as arba gyvo
 * workerio laikoma nuosavybė (409).
 *
 * Nuosavybės klaidos ŽINUTĖ į klientą NEPERDUODAMA: joje yra lease ir savininko id (su PID).
 * Klientui pakanka žinoti, kad task'ą šiuo metu valdo workeris.
 */
export function mapTaskTriageError(error: unknown): HttpErrorResponse {
  if (error instanceof InvalidTaskReferenceError) return jsonError(400, error.message);
  if (error instanceof TaskNotFoundError) return jsonError(404, error.message);
  if (error instanceof TaskBucketConflictError) return jsonError(409, error.message);
  if (error instanceof TaskAuthorityError) return jsonError(409, "task is held by an active worker lease");
  return INTERNAL_ERROR_RESPONSE;
}

/** Kūno skaitymo klaidos: per didelis — 413, visa kita — 400. Žalias tekstas neperduodamas. */
export function mapJsonBodyError(tooLarge: boolean): HttpErrorResponse {
  return tooLarge ? jsonError(413, "request body is too large") : jsonError(400, "invalid JSON body");
}

export type PolicyErrorKind =
  | "unsupported-file"
  | "not-approved"
  | "cancel-conflict"
  | "human-review-required";

/**
 * Politikų governance klaidos. 403, o ne 409, žmogaus patvirtinimo atveju: tai ne būsenos
 * konfliktas, o atsisakymas suteikti teisę — pasiūlymas maršrutizuotas į human-review, o UI nėra
 * tas žmogus.
 *
 * `cancel-conflict` yra atskira rūšis nuo `not-approved`, nors statusas tas pats (409): abu remiasi
 * pasiūlymo BŪSENA, bet priešingomis kryptimis — `apply` reikalauja `approved`, o `cancel` jo kaip
 * tik neleidžia iš galutinės (`applied`/`rejected`/`cancelled`). Suplakti juos į vieną rūšį reikštų,
 * kad vėlesnis statuso pakeitimas vienam tyliai pakeistų ir kitą.
 */
export function mapPolicyError(kind: PolicyErrorKind | undefined, message: string): HttpErrorResponse {
  switch (kind) {
    case "unsupported-file":
      return jsonError(400, message);
    case "not-approved":
      return jsonError(409, message);
    case "cancel-conflict":
      return jsonError(409, message);
    case "human-review-required":
      return jsonError(403, message);
    default:
      return INTERNAL_ERROR_RESPONSE;
  }
}

/**
 * Governance klaidos klasė → `PolicyErrorKind`.
 *
 * Iki 2026-08-23 UI audito `mapPolicyError` neturėjo NĖ VIENO kvietėjo: politikų maršrutai buvo
 * prijungti prie žalio append-only žurnalo, tad kiekvienas approve/reject/apply grįždavo 500, o
 * human-review vartai net nebuvo pasiekiami. Klasių atpažinimas gyvena čia, kad HTTP statusas
 * ir domain klaida turėtų VIENĄ susiejimo vietą.
 */
export function mapPolicyDecisionError(error: unknown): HttpErrorResponse {
  if (error instanceof UnsupportedPolicyFileError) return mapPolicyError("unsupported-file", error.message);
  if (error instanceof ProposalNotApprovedError) return mapPolicyError("not-approved", error.message);
  if (error instanceof ProposalCancelConflictError) return mapPolicyError("cancel-conflict", error.message);
  if (error instanceof HumanReviewApprovalRequiredError) return mapPolicyError("human-review-required", error.message);
  // NUKRYPIMAS nuo etalono, griežtinantis: etalone schemos klaida krisdavo į bendrą 500. Bet
  // `requested_value: "error"` ten, kur leidžiami tik `advisory|warn|block`, yra VARTOTOJO
  // klaida — ta pati klasė, kurią įvardija šio modulio pirmoji taisyklė. 500 nukreiptų
  // operatorių ieškoti serverio gedimo vietoje netinkamos reikšmės.
  if (error instanceof ZodError) {
    return jsonError(400, error.issues.map((issue) => issue.message).join("; ") || "invalid policy value");
  }
  return INTERNAL_ERROR_RESPONSE;
}

/**
 * Runtime valdiklių įvesties klaidos: `requested` ne 1–2, nežinomas slot'as, netinkamas režimas.
 *
 * Visos jos yra VARTOTOJO klaidos, tad 400 su serverio paaiškinimu. Iki šio atvaizdžio jos
 * krisdavo į bendrą 500 („Internal server error"), ir operatorius matydavo serverio gedimą ten,
 * kur realiai buvo netinkama reikšmė.
 */
export function mapRuntimeControlError(error: unknown): HttpErrorResponse {
  if (error instanceof InvalidWorkerRequestError) return jsonError(400, error.message);
  if (error instanceof InvalidLoopControlError) return jsonError(400, error.message);
  return INTERNAL_ERROR_RESPONSE;
}
