import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Ar vartotojas prašo mažiau judesio.
 *
 * Numatytoji reikšmė be `matchMedia` (SSR, senas jsdom) yra `true` — animacijos nebuvimas yra
 * saugus, o animacija žmogui, kuris jos prašė nerodyti, jau yra klaida.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => window?.matchMedia?.(QUERY).matches ?? true);

  useEffect(() => {
    const mql = window?.matchMedia?.(QUERY);
    if (!mql) return;
    setReduced(mql.matches);

    const handleChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    // Senesnės `MediaQueryList` realizacijos turi tik `addListener`; jei nėra nė vienos — prenumeratos
    // nėra, bet pradinė reikšmė vis tiek teisinga.
    if (mql.addEventListener) {
      mql.addEventListener("change", handleChange);
      return () => mql.removeEventListener("change", handleChange);
    }
    if (mql.addListener) {
      mql.addListener(handleChange);
      return () => mql.removeListener?.(handleChange);
    }
    return;
  }, []);

  return reduced;
}
