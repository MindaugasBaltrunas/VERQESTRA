// `vq/supervisor/decision.json` nuosavybės taisyklė — VIENA vieta dviem skaitytojams.
//
// Iki 2026-09-05 taisyklė gyveno dviem kopijomis, ir jos nesutapo: dispatch'as lygino
// case-insensitive ir trūkstamą `task_id` laikė svetimu, koordinatorius lygino case-sensitive
// ir trūkstamą `task_id` laikė savu. Tas pats ranka redaguotas ar legacy failas vienam
// skaitytojui buvo svetimas, kitam — savas, o iš to plaukiantis verdiktas priklausė nuo to,
// kuris kelias jį perskaitė (041-a incidentas jau kartą vertė `corrupted` į `foreign`).
//
// Sujungiant laimi GRIEŽTESNĖ — dispatch'o — pusė: kryptis visada griežtinanti. Preflight'as
// `task_id` rašo visada, tad jo nebuvimas reiškia ne mūsų rašytą failą, o ne „bet kurio task'o"
// sprendimą.

/** Nuosavybės verdiktas: savas sprendimas, svetimo task'o sprendimas, arba be tapatybės. */
export type DecisionOwnership = "own" | "foreign" | "missing";

/**
 * Sprendimo nuosavybė iš rasto `task_id` ir laukiamo task'o id.
 *
 * `decisionTaskId` yra `unknown` SĄMONINGAI: abu kvietėjai jį gauna iš JSON'o per cast'ą, tad
 * ne-eilutė yra pasiekiama runtime būsena. Priimant `string | undefined`, `typeof` sargyba
 * liktų dviejose kopijose — t. y. taisyklė būtų sujungta tik iš dalies.
 *
 * Palyginimas: `trim` + `toLowerCase` abiem pusėms. Tuščias po `trim` (arba ne-eilutė) yra
 * `missing`, ne `foreign` — kvietėjas turi galėti įvardyti gedimą tiksliai, net jei vartas
 * abiem atvejais tas pats.
 */
export function decisionOwnership(input: { decisionTaskId: unknown; taskId: string }): DecisionOwnership {
  const owner = typeof input.decisionTaskId === "string" ? input.decisionTaskId.trim() : "";
  if (owner === "") return "missing";
  return owner.toLowerCase() === input.taskId.trim().toLowerCase() ? "own" : "foreign";
}
