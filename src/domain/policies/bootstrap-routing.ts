// Tuščios eilės bootstrap maršrutizavimo GRYNOS taisyklės (etalonas: AG_loop
// policy/bootstrap-routing.ts 1:1). Deterministinės: jokio IO, laikrodžio ar atsitiktinumo.
//
// Vartų prasmė: bootstrap gamina spec'ą ir eilės task'us iš README bei .mmd įrodymų. Kai tų
// įrodymų nėra, jie prieštarauja, arba stack'o parinkimas nepatikimas — kelias eina į žmogaus
// peržiūrą, o ne į sintezę. Sugeneruoti task'ai be įrodymų būtų išgalvoti reikalavimai.

import type { StackDecisionConfidence } from "./stack-decision.js";

/** README/.mmd įvesties būsena; `readmeMmdConflict` nustato kvietėjas — čia tik maršrutas. */
export type BootstrapInputState = {
  /** README.md egzistuoja ir turi netuščią turinį. */
  hasReadme: boolean;
  /** Rastų `AG/architecture/source/*.mmd` failų kiekis. */
  mmdSourceCount: number;
  /** README ir .mmd aprašo dviprasmišką ar prieštaringą projekto intenciją. */
  readmeMmdConflict: boolean;
};

export type BootstrapStackConfidenceInput = {
  confidence: StackDecisionConfidence;
  /**
   * Kvietėjas padavė PILNAI eksplicitinį stack pasirinkimą (kalba + framework +
   * architektūros stilius). Toks pasirinkimas `deriveStackDecision` viduje yra autoritetas,
   * tad čia jis niekada neperžiūrimas vien dėl confidence reikšmės.
   */
  explicitStackChoiceProvided: boolean;
  /**
   * Paties StackDecision `humanReviewRequired` vėliava (rizikos/deployment užuominos, aukštas
   * sudėtingumas, beveik lygios alternatyvos arba eksplicitinio ir išvestinio pasirinkimo
   * konfliktas). Ji maršrutizuoja į žmogaus peržiūrą VISADA, nepriklausomai nuo
   * `explicitStackChoiceProvided`: pilnai eksplicitinis pasirinkimas praleidžia tik žemo
   * confidence trigerį, bet ne realų rizikos signalą.
   */
  humanReviewRequired: boolean;
};

export type BootstrapRoutingRoute = "synthesize" | "human-review";

export type BootstrapRoutingDecision = {
  route: BootstrapRoutingRoute;
  reason: string;
};

export function evaluateBootstrapRouting(
  input: BootstrapInputState,
  stack: BootstrapStackConfidenceInput,
): BootstrapRoutingDecision {
  const reasons: string[] = [];

  if (!input.hasReadme) {
    reasons.push("README.md is missing");
  }
  if (input.mmdSourceCount === 0) {
    reasons.push("no Mermaid (.mmd) architecture source was found");
  }
  if (input.readmeMmdConflict) {
    reasons.push("README and .mmd architecture signals conflict");
  }
  if (!stack.explicitStackChoiceProvided && stack.confidence === "low") {
    reasons.push("auto stack selection confidence is low");
  }
  if (stack.humanReviewRequired) {
    reasons.push("stack decision requires human review");
  }

  if (reasons.length > 0) {
    return { route: "human-review", reason: reasons.join("; ") };
  }

  return {
    route: "synthesize",
    reason: "README and .mmd input present and consistent; stack selection confidence is sufficient",
  };
}
