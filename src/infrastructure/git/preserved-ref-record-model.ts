// Preserved-ref įrašo forma ir task id gramatika — bendra gamintojui (`rollback-scope.ts`),
// sutaikinimui (`preserved-ref-reconcile.ts`) ir retencijai (`preserved-ref-retention.ts`).
//
// Atskiras modelio failas yra būtinybė, ne tvarkymasis: 197 sujungė visus tris kelius
// (gamintojas rašo `task=<id>`, retencija kviečia sutaikinimą), tad be šios viršūnės
// `rollback-scope ↔ preserved-ref-reconcile ↔ preserved-ref-retention` sudarytų ciklą, kurį
// architecture-gates vartas gaudo net type-only briaunoms. Šis failas neimportuoja nieko.

/** `vq/state/<dirname>/<task-id>.json` — vienintelis preserved įrašų katalogas. */
export const PRESERVED_REF_RECORD_DIRNAME = "rollback-preserved";

export type PreservedRefRecord = {
  task_id: string;
  ref: string;
  commit: string;
  base_ref: string;
  paths: string[];
  recorded_at: string;
  /** `false` — recovery review baigėsi be atkūrimo; ref lieka vienintelis darbo pėdsakas. */
  recovered?: boolean;
};

/**
 * Task id kelią sudaro TIK šie simboliai, nes jis tampa failo vardu
 * (`rollback-preserved/<id>.json`) ir keliauja per commit'o žinutę kaip `task=<id>`.
 */
const PRESERVED_REF_TASK_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Ta pati patikra abiejose pusėse — gamintojas be jos įrašytų žymą, kurios sutaikinimas
 * negalėtų saugiai paversti keliu; sutaikinimas be jos rašytų failą pagal svetimo commit'o
 * kontroliuojamą eilutę. Sanitizacija čia yra ATMETIMAS, ne simbolių šalinimas: nukirptas id
 * nebeatitiktų žymos, ir įrašas atsidurtų po neteisingu task'u.
 */
export function isPreservedRefTaskId(taskId: string): boolean {
  return PRESERVED_REF_TASK_ID_PATTERN.test(taskId);
}
