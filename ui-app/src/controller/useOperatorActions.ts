import { useCallback, useEffect, useRef, useState } from "react";

export type ToastTone = "success" | "error";

export type OperatorToast = { id: number; tone: ToastTone; message: string };

export type RunOptions = {
  /** Grąžina JAU IŠVERSTĄ sėkmės sakinį: tekstas gimsta kontroleryje, kur `t()` yra pasiekiamas. */
  perform: () => Promise<string>;
  /** JAU IŠVERSTAS klaidos prefiksas; po jo prikabinamas serverio paaiškinimas. */
  failureMessage: string;
};

const DEFAULT_SUCCESS_DISMISS_MS = 5_000;

/**
 * Vienas mutuojančių veiksmų kelias: dvigubo paspaudimo apsauga, „vykdoma" žymė ir rezultato
 * pranešimas.
 *
 * Kodėl apsauga remiasi `ref`, o ne `disabled`:
 * `setState` yra asinchroninis ir grupuojamas — `setPendingActions` iškvietimas paspaudimo
 * apdorotuve DOM'o dar nepakeičia, tad antras paspaudimas toje pačioje partijoje (greitas dvigubas
 * paspaudimas, laikomas Enter, sinchroniškai siunčiami testų įvykiai) į apdorotuvą įeina su VIS DAR
 * aktyviu mygtuku ir išsiunčia ANTRĄ užklausą. Be to `disabled` priklauso nuo to, ar rodinys
 * savybę panaudojo, ir nieko negali apsaugoti, kai tą patį veiksmą turi du įėjimo taškai
 * (signalo kortelė ir ciklo valdymo juosta). `Set` mutuojama sinchroniškai ir yra vienintelis
 * autoritetas; `disabled`/`aria-busy` — tik matoma jo atspindys.
 */
export function useOperatorActions(options?: { successDismissMs?: number }): {
  pendingActions: ReadonlySet<string>;
  isPending: (actionId: string) => boolean;
  run: (actionId: string, options: RunOptions) => Promise<void>;
  toasts: readonly OperatorToast[];
  dismissToast: (id: number) => void;
  pushToast: (tone: ToastTone, message: string) => void;
} {
  const successDismissMs = options?.successDismissMs ?? DEFAULT_SUCCESS_DISMISS_MS;
  const [pendingActions, setPendingActions] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [toasts, setToasts] = useState<readonly OperatorToast[]>([]);
  const inFlight = useRef<Set<string>>(new Set());
  const mounted = useRef(true);
  const toastSequence = useRef(0);
  // Laikmačiai laikomi `ref` žemėlapyje ir valomi išmontuojant — ta pati drausmė kaip
  // `scheduleLabelReset`: kitaip išėjus į kitą route'ą laikmatis rašytų į nebeegzistuojantį rodinį.
  const dismissTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    mounted.current = true;
    const timers = dismissTimers.current;
    return () => {
      mounted.current = false;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const dismissToast = useCallback((id: number) => {
    const timer = dismissTimers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      dismissTimers.current.delete(id);
    }
    setToasts((previous) => previous.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback(
    (tone: ToastTone, message: string) => {
      if (!mounted.current) return;
      // `Date.now()`/`Math.random()` čia netiktų: id turi būti monotoniškas ir nepriklausyti nuo
      // laikrodžio, kitaip du tos pačios milisekundės pranešimai gautų tą patį React raktą.
      const id = (toastSequence.current += 1);
      setToasts((previous) => [...previous, { id, tone, message }]);
      // KLAIDOS pranešimas savaime nedingsta: jis yra vienintelis dalykas, kurį operatorius privalo
      // perskaityti, ir jį uždaro tik jis pats.
      if (tone !== "success") return;
      const timer = setTimeout(() => {
        dismissTimers.current.delete(id);
        if (!mounted.current) return;
        setToasts((previous) => previous.filter((toast) => toast.id !== id));
      }, successDismissMs);
      dismissTimers.current.set(id, timer);
    },
    [successDismissMs],
  );

  const run = useCallback(
    async (actionId: string, runOptions: RunOptions) => {
      // PIRMA eilutė ir sinchroniškai — žr. komentarą prie hook'o: po pirmo `await` apsaugos nebėra.
      if (inFlight.current.has(actionId)) return;
      inFlight.current.add(actionId);
      setPendingActions(new Set(inFlight.current));
      try {
        pushToast("success", await runOptions.perform());
      } catch (actionError) {
        const message = actionError instanceof Error ? actionError.message : String(actionError);
        // `assertOk` jau surinko „HTTP 409: <serverio paaiškinimas>", tad serverio tekstas pasiekia
        // ekraną nepakeistas — būtent jis pasako, ką operatorius gali padaryti.
        pushToast("error", `${runOptions.failureMessage}: ${message}`);
      } finally {
        inFlight.current.delete(actionId);
        if (mounted.current) setPendingActions(new Set(inFlight.current));
      }
    },
    [pushToast],
  );

  const isPending = useCallback((actionId: string) => pendingActions.has(actionId), [pendingActions]);

  return { pendingActions, isPending, run, toasts, dismissToast, pushToast };
}
