import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../model/api";
import type { TokenUsageQueryResponse } from "../model/types";
import {
  aggregateTokenUsage,
  computeFastPathStats,
  computePeriodComparison,
  computeReworkProxyStats,
  computeTokenDistributionStats,
  computeTokenUsageTotals,
  filterTokenUsageRecords,
  recordTotalTokens,
  toInclusiveIsoDateBoundary,
  uniqueSortedValues,
} from "../model/tokenUsageViewModel";

const REFRESH_SEC = 60;

function toLocalDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Numatytoji puslapio apimtis; `0` reiškia „visa istorija" (žr. `loadAll`). */
const DEFAULT_LIMIT = 500;

export function useTokenUsageController() {
  const [data, setData] = useState<TokenUsageQueryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // Pasirinkta apimtis gyvena būsenoje, o ne funkcijos argumente: „Load full history" kviesdavo
  // `load(0)`, bet 60 s intervalo callback'as visada kviesdavo `load()` su numatytuoju 500, tad
  // po minutės visa istorija tyliai virsdavo 500 naujausių įrašų — grafikai ir sumos
  // pasikeisdavo be jokio vartotojo veiksmo (2026-08-06 UI auditas).
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const requestSequence = useRef(0);

  const [model, setModel] = useState("");
  const [phase, setPhase] = useState("");
  const [taskIdQuery, setTaskIdQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    try {
      const response = await api.fetchTokenUsage({
        from: toInclusiveIsoDateBoundary(from, "start"),
        to: toInclusiveIsoDateBoundary(to, "end"),
        limit,
      });
      if (requestId !== requestSequence.current) return;
      setData(response);
      setError(null);
      setRefreshError(null);
    } catch (loadError) {
      if (requestId !== requestSequence.current) return;
      // Turint duomenų, trumpalaikis 5xx per foninį atnaujinimą nebeištrina viso puslapio:
      // rodomas neįkyrus pranešimas virš jau įkeltų duomenų (tas pats modelis kaip dashboard'e).
      setData((current) => {
        if (current) setRefreshError(toErrorMessage(loadError));
        else setError(toErrorMessage(loadError));
        return current;
      });
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, [from, to, limit]);

  const loadAll = useCallback(() => {
    setLoading(true);
    setLimit(0);
  }, []);

  useEffect(() => {
    setLoading(true);
    queueMicrotask(() => {
      void load();
    });
    const timer = setInterval(() => {
      void load();
    }, REFRESH_SEC * 1000);

    return () => clearInterval(timer);
  }, [load]);

  const filteredRecords = useMemo(
    () => filterTokenUsageRecords(data?.records ?? [], { model, phase, taskIdQuery }),
    [data, model, phase, taskIdQuery],
  );

  const totals = useMemo(() => computeTokenUsageTotals(filteredRecords), [filteredRecords]);
  const byModel = useMemo(() => aggregateTokenUsage(filteredRecords, "model"), [filteredRecords]);
  const byPhase = useMemo(() => aggregateTokenUsage(filteredRecords, "phase"), [filteredRecords]);
  const byPhaseGroup = useMemo(() => aggregateTokenUsage(filteredRecords, "phaseGroup"), [filteredRecords]);
  const byDay = useMemo(() => aggregateTokenUsage(filteredRecords, "day"), [filteredRecords]);
  const byTask = useMemo(() => aggregateTokenUsage(filteredRecords, "task_id"), [filteredRecords]);
  const fastPathStats = useMemo(() => computeFastPathStats(filteredRecords), [filteredRecords]);
  const periodComparison = useMemo(() => computePeriodComparison(filteredRecords), [filteredRecords]);
  const reworkProxyStats = useMemo(() => computeReworkProxyStats(filteredRecords), [filteredRecords]);
  const perRecordTokenStats = useMemo(
    () => computeTokenDistributionStats(filteredRecords.map(recordTotalTokens)),
    [filteredRecords],
  );
  const perTaskTokenStats = useMemo(
    () => computeTokenDistributionStats(byTask.map((row) => row.totalTokens)),
    [byTask],
  );

  const modelOptions = useMemo(
    () => uniqueSortedValues(data?.records ?? [], "model"),
    [data],
  );
  const phaseOptions = useMemo(
    () => uniqueSortedValues(data?.records ?? [], "phase"),
    [data],
  );

  const resetFilters = useCallback(() => {
    setModel("");
    setPhase("");
    setTaskIdQuery("");
    setFrom("");
    setTo("");
  }, []);

  const setDatePreset = useCallback((days: number | null) => {
    if (days === null) {
      setFrom("");
      setTo("");
      return;
    }
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - (days - 1));
    setFrom(toLocalDateInputValue(start));
    setTo(toLocalDateInputValue(end));
  }, []);

  return {
    loading,
    error,
    /** Foninio atnaujinimo klaida, kai duomenys JAU rodomi — nepakeičia viso puslapio. */
    refreshError,
    isPartial: data?.pagination?.has_more ?? false,
    loadedRecords: data?.records.length ?? 0,
    totalRecords: data?.pagination?.total_records ?? data?.records.length ?? 0,
    isEmpty: !loading && !error && filteredRecords.length === 0,
    filters: { model, phase, taskIdQuery, from, to },
    modelOptions,
    phaseOptions,
    totals,
    byModel,
    byPhase,
    byPhaseGroup,
    byDay,
    byTask,
    fastPathStats,
    periodComparison,
    reworkProxyStats,
    perRecordTokenStats,
    perTaskTokenStats,
    actions: {
      setModel,
      setPhase,
      setTaskIdQuery,
      setFrom,
      setTo,
      setDatePreset,
      reload: load,
      loadAll,
      resetFilters,
    },
  };
}
