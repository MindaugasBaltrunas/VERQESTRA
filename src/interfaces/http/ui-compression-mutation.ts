// Vienos kompresijos vėliavos perjungimas iš UI (VQ, 2026-08-26).
//
// Kodėl atskirai nuo vaizdo: skaitymas gniūžta švelniai, o rašymas — niekada. Konfigas valdo, KOKS
// kontekstas keliauja į vykdytoją, tad tyliai priimta neteisinga reikšmė būtų blogiau už atmestą
// užklausą.
//
// Dvi taisyklės, kurios yra šio modulio kontraktas:
//
//   1. VALIDUOJA DOMENAS, NE ŠIS FAILAS. Naujas objektas pervaromas per
//      `parseContextCompressionConfig` PRIEŠ rašymą, tad UI negali įrašyti nei nežinomo rakto, nei
//      canary ten, kur jis nepalaikomas. Antra validacijos kopija čia reikštų du skirtingus
//      atsakymus tam pačiam klausimui.
//   2. RAŠOMA VISA STRUKTŪRA. Perrašomas visas failas iš perskaityto ir pataisyto objekto, o ne
//      lopomas laukas: dalinis rašymas paliktų konfigą būsenoje, kurios validatorius nematė.

import {
  CONTEXT_COMPRESSION_CANARY,
  CONTEXT_COMPRESSION_FEATURES,
  parseContextCompressionConfig,
  type ContextCompressionConfig,
  type ContextCompressionFeature,
  type ContextCompressionFeatureValue,
} from "../../domain/policies/compression/features.js";

export class InvalidCompressionRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCompressionRequestError";
  }
}

/** `true` | `false` | `"canary"` iš HTTP kūno; bet kas kita — klaida, ne numatytoji reikšmė. */
export function parseFeatureValue(raw: unknown): ContextCompressionFeatureValue {
  if (raw === true || raw === false || raw === CONTEXT_COMPRESSION_CANARY) return raw;
  throw new InvalidCompressionRequestError(
    `value must be true, false or "${CONTEXT_COMPRESSION_CANARY}"`,
  );
}

export function parseFeatureKey(raw: string): ContextCompressionFeature {
  if ((CONTEXT_COMPRESSION_FEATURES as readonly string[]).includes(raw)) {
    return raw as ContextCompressionFeature;
  }
  throw new InvalidCompressionRequestError(
    `unknown feature: "${raw}" (known: ${CONTEXT_COMPRESSION_FEATURES.join(", ")})`,
  );
}

export type CompressionMutationPorts = {
  loadConfig(): Promise<ContextCompressionConfig>;
  writeConfig(serialized: string): Promise<void>;
};

/**
 * Įrašo vieną vėliavą ir grąžina jau VALIDUOTĄ naują konfigą.
 *
 * Grąžinamas visas objektas, o ne `void`: klientas po perjungimo turi matyti tą patį šaltinį, kurį
 * matys ir kitas dispatch'as — kitaip ekranas ir vykdytojas galėtų nesutarti dėl to, kas įjungta.
 */
export async function setCompressionFeature(
  ports: CompressionMutationPorts,
  featureKey: string,
  rawValue: unknown,
): Promise<ContextCompressionConfig> {
  const feature = parseFeatureKey(featureKey);
  const value = parseFeatureValue(rawValue);

  const current = await ports.loadConfig();
  const candidate: ContextCompressionConfig = {
    ...current,
    features: { ...current.features, [feature]: value },
  };

  // Vienintelis verdiktas: canary nepalaikymas, versijos riba ir raktų aibė tikrinami TEN, kur jie
  // apibrėžti. Klaida virsta 400-uku su domeno paaiškinimu, ne 500-uku.
  const validated = parseContextCompressionConfig(candidate);
  await ports.writeConfig(`${JSON.stringify(validated, null, 2)}\n`);
  return validated;
}
