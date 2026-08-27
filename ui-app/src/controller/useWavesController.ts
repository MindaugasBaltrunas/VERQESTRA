import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWaves } from "../model/api";
import type { UiWavesView } from "../model/types";

// `GET /api/waves` DTO persikėlė į `model/types.ts`: tuos pačius laukus dabar skaito ir model
// sluoksnis, o modelis kontrolerio importuoti negali. Re-eksportas paliktas, kad esami importai
// (`WavesPanel`) nesulūžtų.
export type {
  UiWaveEvent,
  UiWaveLease,
  UiWaveRefillDecision,
  UiWaveRejection,
  UiWaveSlot,
  UiWaveSlotFailure,
  UiWaveSlotState,
  UiWavesView,
} from "../model/types";

const WAVES_POLL_MS = 30_000;

/**
 * `#/system` bangų vaizdas: slot'ų lease'ai, atmetimų priežastys ir įvykių uodega.
 *
 * `enabled: false` reiškia „šio ekrano nėra matomo" — tada nedaromas nei pirmas užklausimas, nei
 * periodinis atnaujinimas. Be šios vėliavos kiekvienas duomenų vartotojas pridėtų dar vieną
 * 30 s pollingo srautą net tada, kai jo panelė neatidaryta.
 */
export function useWavesController(options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  const [data, setData] = useState<UiWavesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    try {
      const view = await fetchWaves();
      if (requestId !== requestSequence.current) return;
      setData(view);
      setError(null);
    } catch (loadError) {
      if (requestId !== requestSequence.current) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const timer = setInterval(() => void load(), WAVES_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, load]);

  return { data, error, loading, reload: load };
}
