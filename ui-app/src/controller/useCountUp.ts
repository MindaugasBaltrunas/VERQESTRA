import { useEffect, useRef, useState } from "react";
import { countUpValue } from "../model/countUp";
import { useReducedMotion } from "./useReducedMotion";

/**
 * Skaičiaus „prisukimas" iki `target`. Matematika gyvena `model/countUp.ts` — čia lieka tik rAF
 * ciklas ir jo sutvarkymas.
 *
 * Prašant mažiau judesio (arba kai `requestAnimationFrame` nėra — jsdom) reikšmė nustatoma iš karto
 * ir joks kadras neplanuojamas: tuščias rAF ciklas fone būtų paslėptas side effect.
 */
export function useCountUp(target: number, durationMs = 420): number {
  const reducedMotion = useReducedMotion();
  const [value, setValue] = useState(target);
  // `ref` laiko TIK tai, kas matoma ekrane: nauja animacija pradedama nuo jos, o ne nuo nulio, kad
  // greitai kintantis `target` neverstų skaičiaus šokinėti atgal.
  const displayedRef = useRef(target);

  useEffect(() => {
    displayedRef.current = value;
  }, [value]);

  useEffect(() => {
    if (reducedMotion || typeof requestAnimationFrame !== "function") {
      displayedRef.current = target;
      setValue(target);
      return;
    }

    const from = displayedRef.current;
    if (from === target) return;

    const started = performance.now();
    let frame = requestAnimationFrame(function step(timestamp: number) {
      const next = countUpValue(from, target, timestamp - started, durationMs);
      setValue(next);
      if (next !== target) frame = requestAnimationFrame(step);
    });

    return () => cancelAnimationFrame(frame);
    // `value` sąmoningai NE priklausomybėse: jį keičia pati animacija, ir jos įtraukimas
    // perkrautų ciklą kiekviename kadre.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs, reducedMotion]);

  return value;
}
