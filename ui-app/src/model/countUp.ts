/**
 * Skaičiaus „prisukimo" reikšmė vienai animacijos akimirkai. Gryna funkcija be laikrodžio: laiką
 * paduoda kviečiantysis (`useCountUp`), todėl elgesį galima patikrinti testu be `requestAnimationFrame`.
 *
 * Kubinis `ease-out`: pradžia greita, pabaiga rami — skaičius nustoja judėti prieš tai, kai akis
 * spėja jį perskaityti.
 */
export function countUpValue(from: number, to: number, elapsedMs: number, durationMs: number): number {
  // Bloga įvestis niekada nevirsta `NaN` ekrane — grąžinama galutinė reikšmė, tarsi animacija būtų baigta.
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(elapsedMs) || !Number.isFinite(durationMs)) {
    return to;
  }
  if (durationMs <= 0) return to;

  const t = Math.min(1, Math.max(0, elapsedMs / durationMs));
  if (t >= 1) return to;
  const eased = 1 - (1 - t) ** 3;
  return from + (to - from) * eased;
}
