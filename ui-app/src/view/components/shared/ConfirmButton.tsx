import { useEffect, useState } from "react";

type Props = {
  label: string;
  confirmLabel: string;
  cancelLabel: string;
  tone?: "danger" | "ghost" | "success";
  disabled?: boolean;
  busy?: boolean;
  /** Priežastis, kodėl mygtukas neaktyvus — rodoma TIK pradinėje (nepatvirtintoje) būsenoje. */
  title?: string;
  onConfirm: () => void;
};

/**
 * Dviejų paspaudimų patvirtinimas TOJE PAČIOJE vietoje, kur veiksmas vykdomas.
 *
 * `window.confirm` čia sąmoningai nenaudojamas: jis blokuoja giją, yra neverčiamas ir jsdom'e iš
 * viso „not implemented", tad patvirtinimo kelias liktų neuždengtas testais.
 *
 * Būsena yra KIEKVIENO egzemplioriaus atskirai — taip lieka teisinga taisyklė „patvirtinimo prašo tik
 * ta kortelė, kurią paspaudei". Atšaukimas užklausos nesiunčia pagal konstrukciją: `onConfirm`
 * kviečiamas tik iš patvirtinimo mygtuko, o „Atšaukti" tik nuima paruoštą būseną.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  cancelLabel,
  tone = "danger",
  disabled = false,
  busy = false,
  title,
  onConfirm,
}: Props) {
  const [armed, setArmed] = useState(false);
  // Paruošta būsena NEGYVENA ilgiau už leidimą veikti. Be šito patvirtinimo mygtukas būtų vienintelis
  // valdiklis, kuris `disabled` nepaiso: paruošus jį ir tuo metu pradėjus kitą veiksmą (matrica tada
  // uždaro visus tris), antras paspaudimas vis tiek išsiųstų užklausą.
  const blocked = disabled || busy;

  useEffect(() => {
    if (blocked) setArmed(false);
  }, [blocked]);

  if (armed && !blocked) {
    return (
      <>
        <button
          className={`button ${tone} small-button`} type="button"
          onClick={() => {
            setArmed(false);
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
        <button className="button ghost small-button" type="button" onClick={() => setArmed(false)}>
          {cancelLabel}
        </button>
      </>
    );
  }

  return (
    <button
      className={`button ${tone} small-button`} type="button"
      disabled={blocked}
      // `aria-busy` rašomas tik kai veiksmas tikrai vyksta: nuolatinis `aria-busy="false"` nieko
      // nepasako, o mygtuko PAVADINIMAS nesikeičia — suktukas paslėptas nuo pagalbinių technologijų.
      aria-busy={busy || undefined}
      title={blocked ? title : undefined}
      onClick={() => setArmed(true)}
    >
      {label}
      {busy && <span className="button-spinner" aria-hidden="true" />}
    </button>
  );
}
