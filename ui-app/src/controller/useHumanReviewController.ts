import { useCallback, useEffect, useRef, useState } from "react";
import { fetchDashboard, triageTask } from "../model/api";
import type { UiHumanReviewTask } from "../model/types";

export type TaskTriageAction = "requeue" | "complete";

/**
 * `#/reviews` triažas: pačios kortelės ateina iš `controlPlane.human_review_tasks`, tad
 * kontroleris pats skaito `/api/dashboard` (per esamą `model/api#fetchDashboard`), o ne priima jį
 * kaip props'ą — `useDashboardController` (kito task'o failas) šio lauko šiuo metu nepervedą.
 * Vienas veiksmas (requeue -> queue arba complete -> done) baigiasi task'o dingimu iš šio sąrašo
 * po sėkmingo `reload`.
 */
export function useHumanReviewController() {
  const [tasks, setTasks] = useState<UiHumanReviewTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const requestSequence = useRef(0);
  /**
   * Dvigubo paspaudimo apsauga pagal užduoties id. `busyTaskId` yra `setState`, tad jis DOM'o dar
   * nepakeičia tuo metu, kai į apdorotuvą įeina antras to paties tick'o paspaudimas — mygtukas vis
   * dar aktyvus, ir serveris gauna dvi triažo užklausas tai pačiai užduočiai. `Set` mutuojamas
   * sinchroniškai, tad jis yra vienintelis autoritetas (ta pati drausmė kaip `useOperatorActions`).
   */
  const inFlight = useRef<Set<string>>(new Set());
  // Panelė gyvena `#/reviews`, o operatorius gali išeiti iš jo dar neatsakius serveriui: po `await`
  // rašyti į išmontuotą rodinį nėra ko.
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const requestId = ++requestSequence.current;
    try {
      const dashboard = await fetchDashboard();
      if (requestId !== requestSequence.current || !mounted.current) return;
      setTasks(dashboard.controlPlane?.human_review_tasks ?? []);
      setError(null);
    } catch (loadError) {
      if (requestId !== requestSequence.current || !mounted.current) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (requestId === requestSequence.current && mounted.current) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const runAction = useCallback(
    async (action: TaskTriageAction, taskId: string) => {
      // PIRMA eilutė ir sinchroniškai: po pirmo `await` apsaugos nebėra.
      if (inFlight.current.has(taskId)) return;
      inFlight.current.add(taskId);
      setBusyTaskId(taskId);
      setErrors((previous) => {
        if (!(taskId in previous)) return previous;
        const next = { ...previous };
        delete next[taskId];
        return next;
      });
      try {
        // Vienintelis tinklo kelias yra `model/api`: čia buvęs savas `fetch` su `getUiToken` apeidavo
        // ir 30 s ribą, ir `assertOk` serverio paaiškinimą (task 1235).
        await triageTask(action, taskId);
        // Perkraunama tik jei yra kam rodyti: išmontuotam rodiniui tai būtų užklausa niekam.
        if (mounted.current) await reload();
      } catch (actionError) {
        const message = actionError instanceof Error ? actionError.message : String(actionError);
        if (mounted.current) setErrors((previous) => ({ ...previous, [taskId]: message }));
      } finally {
        // Apsauga yra laikina: ta pati užduotis po atsakymo (ir po klaidos) vėl gali būti bandoma.
        inFlight.current.delete(taskId);
        if (mounted.current) setBusyTaskId(null);
      }
    },
    [reload],
  );

  const requeue = useCallback((taskId: string) => runAction("requeue", taskId), [runAction]);
  const complete = useCallback((taskId: string) => runAction("complete", taskId), [runAction]);

  return { tasks, loaded, error, busyTaskId, errors, requeue, complete, reload };
}
