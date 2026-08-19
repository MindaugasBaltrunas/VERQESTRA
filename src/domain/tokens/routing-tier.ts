/**
 * Provider-neutralus maršrutavimo pakopų kontraktas.
 *
 * Šiame faile SĄMONINGAI nėra nė vieno provider'io modelio vardo. Pakopa atsako
 * į klausimą „kiek pajėgumo verta šiam darbui", o kuris konkretus modelis tą
 * pakopą įgyvendina — provider adapterio (infrastructure sluoksnio) atsakomybė.
 * Įrašius čia provider vardą, modelių kartos pasikeitimas arba antras provideris
 * vėl reikštų domeno taisyklių perrašinėjimą; būtent tai ši riba ir uždaro.
 * Domain sluoksniui architektūros politika draudžia bet kokias priklausomybes,
 * todėl failas neturi importų, IO ir laiko — vien gryna, deterministinė pakopų
 * aritmetika. Behaviour etalon: AG_loop domain/tokens/model-tier.ts (pervadinta
 * pagal WBR VQ-204 — vardas sako, KĄ pakopa daro, ne kuo ji įgyvendinta).
 *
 * `AUTO_ESCALATION_CEILING` yra 2026-07-22 incidento invariantas: aukščiausia
 * pakopa (`critical`) NIEKADA nepasiekiama automatine retry eskalacija. Tąkart
 * viena nesėkmė pakėlė užduotį į brangiausią pakopą (~$19 už vieną dispatch'ą)
 * be jokių vartų. Aukščiausia pakopa lieka pasiekiama tik EXPLICIT parinkimu
 * (supervisor/žmogus), o eskalacija jos niekada neįveda pati.
 */
export const ROUTING_TIERS = ["routine", "standard", "advanced", "critical"] as const;

export type RoutingTier = (typeof ROUTING_TIERS)[number];

/** Automatinės (retry) eskalacijos lubos — žr. failo antraštę. */
export const AUTO_ESCALATION_CEILING: RoutingTier = "advanced";

export function isRoutingTier(value: string): value is RoutingTier {
  return (ROUTING_TIERS as readonly string[]).includes(value);
}

/** Pakopos rangas: 0 = žemiausia, didesnis = brangesnė/pajėgesnė pakopa. */
export function routingTierRank(tier: RoutingTier): number {
  return ROUTING_TIERS.indexOf(tier);
}

/** `Array.prototype.sort` suderinamas palyginimas pagal rangą. */
export function compareRoutingTier(a: RoutingTier, b: RoutingTier): number {
  return routingTierRank(a) - routingTierRank(b);
}

/** Aukščiausia iš pateiktų pakopų; tuščias sąrašas → žemiausia pakopa. */
export function highestRoutingTier(tiers: readonly RoutingTier[]): RoutingTier {
  let highest: RoutingTier = ROUTING_TIERS[0];
  for (const tier of tiers) {
    if (routingTierRank(tier) > routingTierRank(highest)) {
      highest = tier;
    }
  }
  return highest;
}

/** Nuleidžia pakopą iki lubų; jau esanti po lubomis pakopa nekeičiama. */
export function clampRoutingTier(tier: RoutingTier, ceiling: RoutingTier): RoutingTier {
  return routingTierRank(tier) <= routingTierRank(ceiling) ? tier : ceiling;
}

/**
 * Kiekvienas nepavykęs bandymas pakelia pakopą vienu laipteliu virš bazės:
 * žemesnei pakopai suklydus, taisymą perima aukštesnė. Užsifiksuoja ties
 * `ceiling` (numatytai — {@link AUTO_ESCALATION_CEILING}); virš bazinės pakopos
 * niekada nekelia, nebent pati bazė jau yra virš lubų (tada explicit parinkimas
 * išlaikomas, bet eskalacija jo nedidina).
 *
 * Neigiami ir trupmeniniai bandymų skaičiai apkerpami (`max(0, floor(n))`).
 */
export function escalateRoutingTier(
  base: RoutingTier,
  failedAttempts: number,
  ceiling: RoutingTier = AUTO_ESCALATION_CEILING,
): RoutingTier {
  const baseIndex = routingTierRank(base);
  const ceilingIndex = Math.max(baseIndex, routingTierRank(ceiling));
  const escalatedIndex = Math.min(baseIndex + Math.max(0, Math.floor(failedAttempts)), ceilingIndex);
  return ROUTING_TIERS[escalatedIndex] ?? AUTO_ESCALATION_CEILING;
}
