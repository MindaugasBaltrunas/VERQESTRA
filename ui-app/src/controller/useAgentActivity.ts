import { useEffect, useRef, useState } from "react";
import { getUiToken } from "../model/api";
import type { AgentActivity } from "../model/types";

const RETRY_MS = 2_000;
const MAX_RETRY_MS = 30_000;

/** Ryšio su `/api/events` būsena — ji renderinama, kad tylus gedimas nebeatrodytų kaip ramybė. */
export type AgentActivityStatus = "connecting" | "live" | "disconnected";

export type AgentActivityState = {
  activity: AgentActivity | null;
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
  const [status, setStatus] = useState<AgentActivityStatus>("connecting");
  const [lastError, setLastError] = useState("");
  const pending = useRef<AgentActivity | null>(null);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = RETRY_MS;

    const flush = () => {
      frame.current = null;
      if (pending.current !== null) {
        setActivity(pending.current);
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
        pending.current = JSON.parse(data) as AgentActivity;
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

  return { activity, status, lastError };
}
