import { useEffect, useRef, useState } from "react";
import { getUiToken } from "../model/api";
import type { AgentActivity, AgentActivityFrame, SlotAgentActivity } from "../model/types";

const RETRY_MS = 2_000;
const MAX_RETRY_MS = 30_000;

/** Ryšio su `/api/events` būsena — ji renderinama, kad tylus gedimas nebeatrodytų kaip ramybė. */
export type AgentActivityStatus = "connecting" | "live" | "disconnected";

export type AgentActivityState = {
  activity: AgentActivity | null;
  /**
   * Per-srautinės grandinės, kai banga turi gyvų slot'ų. Tuščias sąrašas reiškia „gyvų slot'ų
   * nėra" — tada lieka tik globalus `activity`.
   *
   * 2026-08-24 auditas, aštuntas ratas: serveris šį lauką siunčia nuo daugiaslot'inės bangos, o
   * klientas jo NESKAITĖ. Dėl to dviejų srautų bangoje grandinė buvo priskiriama pagal `task_id`
   * sutapimą su GLOBALIU log'u, kurį worker'iai perrašo vienas per kitą — t. y. antram srautui
   * rodoma svetima grandinė arba jokia. Būtent tam `slots[]` ir buvo sukurtas.
   */
  slots: readonly SlotAgentActivity[];
  status: AgentActivityStatus;
  /** Paskutinė ryšio klaida (`HTTP 401`, tinklo klaida). Tuščia, kol ryšys sveikas. */
  lastError: string;
};

/**
 * SSE prenumerata su matoma būsena.
 *
 * Iki 2026-08-06 audito hook'as grąžindavo tik `activity`, o kiekvieną gedimą prarydavo tuščias
 * `catch`. Nesutampant UI token'ui `/api/events` grąžina 401, `activity` amžinai lieka `null`,
 * o „Active execution" panelė tiesiog dingsta iš dashboard'o — vartotojas mato tvarkingą langą ir
 * daro išvadą, kad agentas nedirba. Tuo pačiu vyko begalinis 2 s pakartojimas be atsitraukimo.
 */
export function useAgentActivity(): AgentActivityState {
  const [activity, setActivity] = useState<AgentActivity | null>(null);
  const [slots, setSlots] = useState<readonly SlotAgentActivity[]>([]);
  const [status, setStatus] = useState<AgentActivityStatus>("connecting");
  const [lastError, setLastError] = useState("");
  const pending = useRef<AgentActivityFrame | null>(null);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = RETRY_MS;

    const flush = () => {
      frame.current = null;
      if (pending.current !== null) {
        const { slots: frameSlots, ...globalActivity } = pending.current;
        setActivity(globalActivity);
        // Sąrašas paimamas iš TO PAČIO kadro kaip globalus aktyvumas: du atskiri `setState`
        // šaltiniai leistų ekranui vieną akimirką rodyti naujo kadro grandinę su seno kadro
        // slot'ais, ir priskyrimas būtų neteisingas būtent perėjimo metu.
        setSlots(Array.isArray(frameSlots) ? frameSlots : []);
        pending.current = null;
      }
    };

    const acceptFrame = (raw: string) => {
      const data = raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) return;
      try {
        pending.current = JSON.parse(data) as AgentActivityFrame;
        if (frame.current === null) frame.current = requestAnimationFrame(flush);
      } catch {
        // Ignore malformed server-sent event frames.
      }
    };

    const connect = async (): Promise<void> => {
      try {
        const response = await fetch("/api/events", {
          headers: { "x-vq-ui-token": getUiToken() },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

        // Ryšys atkurtas: būsena ir atsitraukimo langas grįžta į pradinę reikšmę.
        retryDelay = RETRY_MS;
        setStatus("live");
        setLastError("");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? "";
          frames.forEach(acceptFrame);
        }
        if (!controller.signal.aborted) setStatus("disconnected");
      } catch (error) {
        if (controller.signal.aborted) return;
        setStatus("disconnected");
        setLastError(error instanceof Error ? error.message : String(error));
      }
      if (!controller.signal.aborted) {
        retryTimer = setTimeout(() => void connect(), retryDelay);
        // Eksponentinis atsitraukimas: nuolatinė 401 (blogas token'as) nebeturi mušti serverio
        // kas 2 s neribotą laiką, bet trumpas UI perkrovimas vis tiek atsistato greitai.
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
      }
    };

    void connect();
    return () => {
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);

  return { activity, slots, status, lastError };
}
