import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../model/api";
import type { TokenAnalyticsResponse } from "../model/types";

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const emptyResponse: TokenAnalyticsResponse = { groups: [], candidates: [], history: [] };

export function useTokenAnalyticsController() {
  const [data, setData] = useState<TokenAnalyticsResponse>(emptyResponse);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    try {
      const response = await api.fetchTokenAnalytics();
      if (requestId !== requestSequence.current) return;
      setData(response);
      setError(null);
    } catch (loadError) {
      if (requestId !== requestSequence.current) return;
      setError(toErrorMessage(loadError));
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  return {
    loading,
    error,
    isEmpty: !loading && !error && data.groups.length === 0,
    groups: data.groups,
    candidates: data.candidates,
    history: data.history,
    reload: load,
  };
}
