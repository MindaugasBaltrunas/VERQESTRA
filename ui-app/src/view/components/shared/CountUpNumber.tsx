import { memo } from "react";
import { useCountUp } from "../../../controller/useCountUp";

type Props = { value: number };

/**
 * Skaičius, kuris keisdamasis „prisisuka" iki naujos reikšmės.
 *
 * `tabular-nums` čia yra ne grožis, o sąlyga: kintamo pločio skaitmenys animacijos metu stumdytų
 * aplinkinį tekstą. Rodoma reikšmė apvalinama — tarpinis kadras su trupmena būtų skaičius, kurio
 * duomenyse niekada nebuvo.
 */
export const CountUpNumber = memo(function CountUpNumber({ value }: Props) {
  const animated = useCountUp(value);
  return <span className="tabular-nums">{Math.round(animated)}</span>;
});
