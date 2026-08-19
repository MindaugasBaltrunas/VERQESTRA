// Bendri skaičių helper'iai. Perkelta iš AG_loop domain/metrics/accepted-change.ts (WBR
// VQ-204: round2 → shared) — apvalinimo taisyklė yra bendra, ne metrikos domeno detalė.

/** Apvalina iki 2 skaičių po kablelio (ataskaitų / delta laukų forma). */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
