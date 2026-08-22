/**
 * Įstato reikšmes į JAU IŠVERSTĄ šabloną, kad sakinio tvarka priklausytų nuo kalbos, o ne nuo JSX.
 *
 * Funkcija gyveno `RuntimePanel.tsx` viduje. Kai tą patį šabloną prireikė penkiems komponentams,
 * kopija kiekviename faile reikštų penkis kelius, kuriais formatavimas gali nutolti; be to
 * `reduce` komponente yra logikos ženklas, kurio vaizdo sluoksnyje neturi būti.
 */
export function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.split(`{${key}}`).join(String(value)),
    template,
  );
}
