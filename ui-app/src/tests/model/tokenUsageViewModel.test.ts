import { describe, expect, it } from "vitest";
import type { TokenUsageRecord } from "../../model/types";
import {
  aggregateTokenUsage,
  canonicalModelName,
  canonicalPhaseGroup,
  computeFastPathStats,
  computePeriodComparison,
  computeReworkProxyStats,
  computeTokenDistributionStats,
  computeTokenUsageTotals,
  filterTokenUsageRecords,
  normalizeTaskId,
  recordTotalTokens,
  sortAggregateRows,
  toInclusiveIsoDateBoundary,
  tokenShareForKey,
  uniqueSortedValues,
  type AggregateRow,
} from "../../model/tokenUsageViewModel";

function record(overrides: Partial<TokenUsageRecord> = {}): TokenUsageRecord {
  return {
    ts: "2026-06-01T10:00:00.000Z",
    phase: "dispatch",
    task_id: "task-1",
    model: "claude-opus",
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 10,
    cache_creation_input_tokens: 5,
    total_cost_usd: 1.5,
    ...overrides,
  };
}

describe("recordTotalTokens", () => {
  it("sums input, output, cache read and cache creation", () => {
    expect(recordTotalTokens(record())).toBe(165);
  });

  it("coerces missing numeric fields to 0", () => {
    expect(
      recordTotalTokens(
        record({ input_tokens: undefined, output_tokens: undefined, cache_read_input_tokens: undefined, cache_creation_input_tokens: undefined }),
      ),
    ).toBe(0);
  });
});

describe("canonicalPhaseGroup", () => {
  it("maps fastpath and local phases to 'fastpath'", () => {
    expect(canonicalPhaseGroup("preflight-fastpath")).toBe("fastpath");
    expect(canonicalPhaseGroup("diagnose-fastpath")).toBe("fastpath");
    expect(canonicalPhaseGroup("diagnose-local")).toBe("fastpath");
  });

  it("maps plain preflight/dispatch/diagnose phases", () => {
    expect(canonicalPhaseGroup("preflight")).toBe("preflight");
    expect(canonicalPhaseGroup("dispatch")).toBe("dispatch");
    expect(canonicalPhaseGroup("diagnose")).toBe("diagnose");
  });

  it("falls back to 'other' for unrecognized phases", () => {
    expect(canonicalPhaseGroup("repair")).toBe("other");
  });
});

describe("canonicalModelName", () => {
  it("collapses short aliases and concrete Claude model IDs into one reporting tier", () => {
    expect(canonicalModelName("sonnet")).toBe("sonnet");
    expect(canonicalModelName("claude-sonnet-5")).toBe("sonnet");
    expect(canonicalModelName("haiku")).toBe("haiku");
    expect(canonicalModelName("claude-haiku-4-5")).toBe("haiku");
  });

  it("preserves unknown provider model names", () => {
    expect(canonicalModelName("gpt-5.6")).toBe("gpt-5.6");
  });
});

describe("normalizeTaskId", () => {
  it("trims surrounding whitespace from a real task_id", () => {
    expect(normalizeTaskId("  task-9  ")).toBe("task-9");
  });

  it("returns null for empty and whitespace-only task_id", () => {
    expect(normalizeTaskId("")).toBeNull();
    expect(normalizeTaskId("   ")).toBeNull();
  });
});

describe("aggregateTokenUsage", () => {
  const records: TokenUsageRecord[] = [
    record({ ts: "2026-06-01T10:00:00.000Z", phase: "dispatch", model: "claude-opus", task_id: "task-1", input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    record({ ts: "2026-06-01T12:00:00.000Z", phase: "dispatch", model: "claude-opus", task_id: "task-1", input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    record({ ts: "2026-06-02T09:00:00.000Z", phase: "diagnose", model: "claude-haiku", task_id: "task-2", input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
  ];

  it("groups by model", () => {
    const rows = aggregateTokenUsage(records, "model");
    expect(rows).toEqual([
      { key: "haiku", records: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 15 },
      { key: "opus", records: 2, inputTokens: 300, outputTokens: 70, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 370 },
    ]);
  });

  it("merges aliases and concrete IDs for the same model tier", () => {
    const rows = aggregateTokenUsage([
      record({ model: "sonnet", input_tokens: 10, output_tokens: 0 }),
      record({ model: "claude-sonnet-5", input_tokens: 20, output_tokens: 0 }),
    ], "model");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "sonnet", records: 2, inputTokens: 30 });
  });

  it("groups by phase", () => {
    const rows = aggregateTokenUsage(records, "phase");
    expect(rows.map((r) => r.key)).toEqual(["diagnose", "dispatch"]);
    const dispatch = rows.find((r) => r.key === "dispatch")!;
    expect(dispatch.records).toBe(2);
    expect(dispatch.totalTokens).toBe(370);
  });

  it("groups by phaseGroup, collapsing fastpath/local variants", () => {
    const rows = aggregateTokenUsage(
      [
        record({ phase: "preflight", task_id: "t1" }),
        record({ phase: "preflight-fastpath", task_id: "t2" }),
        record({ phase: "diagnose-local", task_id: "t3" }),
      ],
      "phaseGroup",
    );
    expect(rows.map((r) => r.key)).toEqual(["fastpath", "preflight"]);
    expect(rows.find((r) => r.key === "fastpath")!.records).toBe(2);
  });

  it("groups by task_id", () => {
    const rows = aggregateTokenUsage(records, "task_id");
    expect(rows.map((r) => r.key)).toEqual(["task-1", "task-2"]);
    expect(rows.find((r) => r.key === "task-1")!.records).toBe(2);
  });

  it("neįtraukia tuščio/whitespace task_id kaip atskiros grupės (KPI 139 vs lentelė 140 regresija)", () => {
    // Operatoriaus radinys: tas pats tuščias task_id `computeTokenUsageTotals` buvo atmetamas iš
    // `uniqueTasks`, bet čia žalias raktas tapdavo savo grupe — KPI ir lentelė rodydavo skirtingus
    // skaičius iš TOS PAČIOS imties.
    const withUnassigned: TokenUsageRecord[] = [
      ...records,
      record({ task_id: "" }),
      record({ task_id: "   " }),
    ];
    const rows = aggregateTokenUsage(withUnassigned, "task_id");
    expect(rows.map((r) => r.key)).toEqual(["task-1", "task-2"]);
  });

  it("groups by local calendar day, sorted ascending", () => {
    const rows = aggregateTokenUsage(records, "day");
    expect(rows.map((r) => r.key)).toEqual(["2026-06-01", "2026-06-02"]);
  });

  it("uses 'unknown' as the day key when ts is empty", () => {
    const rows = aggregateTokenUsage([record({ ts: "" })], "day");
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("unknown");
  });

  it("coerces missing numeric fields to 0 and never produces NaN", () => {
    const rows = aggregateTokenUsage(
      [
        record({
          task_id: "task-missing",
          input_tokens: undefined,
          output_tokens: undefined,
          cache_read_input_tokens: undefined,
          cache_creation_input_tokens: undefined,
        }),
      ],
      "task_id",
    );
    expect(rows).toEqual([
      { key: "task-missing", records: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0 },
    ]);
    for (const value of Object.values(rows[0])) {
      if (typeof value === "number") expect(Number.isNaN(value)).toBe(false);
    }
  });
});

describe("computeTokenUsageTotals", () => {
  it("returns all-zero totals for an empty array", () => {
    expect(computeTokenUsageTotals([])).toEqual({
      records: 0,
      uniqueTasks: 0,
      unassignedRecords: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheTokens: 0,
      totalTokens: 0,
      tokensPerTask: 0,
      tokensPerRecord: 0,
      outputInputRatio: 0,
      cacheHitRate: 0,
      cacheReadToCreationRatio: 0,
      costUsd: 0,
      costRecords: 0,
      firstTimestamp: null,
      latestTimestamp: null,
    });
  });

  it("kainą sumuoja TIK iš įrašų, kurie ją turi, ir skaičiuoja jų kiekį", () => {
    const totals = computeTokenUsageTotals([
      record({ total_cost_usd: 1.25 }),
      record({ total_cost_usd: undefined }),
      record({ total_cost_usd: 0.75 }),
    ]);

    expect(totals.costUsd).toBeCloseTo(2);
    // Vardiklis yra kontrakto dalis: 2 iš 3 nurodo, kad tai NE visos imties sąskaita.
    expect(totals.costRecords).toBe(2);
    expect(totals.records).toBe(3);
  });

  it("TUŠČIAS task_id nėra užduotis ir neiškreipia vidurkio", () => {
    // Operatoriaus radinys 2026-08-24: įrašas be užduoties didino `uniqueTasks` vienetu ir tuo
    // MAŽINO `tokensPerTask` — vidurkis rodė pigesnę užduotį nei bet kuri reali.
    const totals = computeTokenUsageTotals([
      record({ task_id: "0001", input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      record({ task_id: "", input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ]);

    expect(totals.uniqueTasks).toBe(1);
    // 200 / 1, o ne 200 / 2: tokenai lieka imtyje, tik vardiklis nebemeluoja.
    expect(totals.totalTokens).toBe(200);
    expect(totals.tokensPerTask).toBe(200);
  });

  it("vien tik beužduočiai įrašai duoda NULĮ užduočių, o vidurkis nesprogsta", () => {
    const totals = computeTokenUsageTotals([record({ task_id: "   ", input_tokens: 50 })]);
    expect(totals.uniqueTasks).toBe(0);
    expect(totals.tokensPerTask).toBe(0);
    expect(Number.isNaN(totals.tokensPerTask)).toBe(false);
  });

  it("beužduočiai įrašai skaičiuojami į unassignedRecords, o priskirti — ne", () => {
    const totals = computeTokenUsageTotals([
      record({ task_id: "task-1" }),
      record({ task_id: "" }),
      record({ task_id: "   " }),
    ]);
    expect(totals.records).toBe(3);
    expect(totals.uniqueTasks).toBe(1);
    expect(totals.unassignedRecords).toBe(2);
  });

  it("uniqueTasks sutampa su task_id grupių skaičiumi iš aggregateTokenUsage (139 vs 140 regresija)", () => {
    const withUnassigned: TokenUsageRecord[] = [
      record({ task_id: "task-1" }),
      record({ task_id: "task-2" }),
      record({ task_id: "" }),
      record({ task_id: "   " }),
    ];
    const rows = aggregateTokenUsage(withUnassigned, "task_id");
    const totals = computeTokenUsageTotals(withUnassigned);
    expect(totals.uniqueTasks).toBe(rows.length);
  });

  it("tokenai vienai užduočiai iš totals sutampa su vidurkiu iš task_id grupių, kai imtis turi tuščią task_id", () => {
    const mixed: TokenUsageRecord[] = [
      record({ task_id: "task-1", input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      record({ task_id: "task-2", input_tokens: 200, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      // Beužduotė fazės telemetrija be tokenų — testas tikrina AIBĖS sutapimą (uniqueTasks ===
      // task_id grupių skaičius), o ne atskirą tokenų priskyrimo taisyklę.
      record({
        task_id: "  ",
        input_tokens: undefined,
        output_tokens: undefined,
        cache_read_input_tokens: undefined,
        cache_creation_input_tokens: undefined,
      }),
    ];
    const rows = aggregateTokenUsage(mixed, "task_id");
    const totals = computeTokenUsageTotals(mixed);

    expect(rows).toHaveLength(2);
    expect(totals.uniqueTasks).toBe(rows.length);
    expect(totals.unassignedRecords).toBe(1);

    const groupedAverage = rows.reduce((sum, row) => sum + row.totalTokens, 0) / rows.length;
    expect(totals.tokensPerTask).toBe(groupedAverage);
  });

  it("nekainuota imtis duoda NULĮ įrašų su kaina, o ne nulinę kainą", () => {
    const totals = computeTokenUsageTotals([record({ total_cost_usd: undefined })]);
    // `costRecords === 0` yra vienintelis skirtumas tarp „nemokama" ir „nematuota"; panelė
    // būtent iš jo sprendžia, ar kainos eilutę apskritai rodyti.
    expect(totals.costRecords).toBe(0);
    expect(totals.costUsd).toBe(0);
  });

  it("sums fields and never produces NaN when some records have missing fields", () => {
    const totals = computeTokenUsageTotals([
      record({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 }),
      record({ input_tokens: undefined, output_tokens: undefined, cache_read_input_tokens: undefined, cache_creation_input_tokens: undefined }),
    ]);
    expect(totals.records).toBe(2);
    expect(totals.uniqueTasks).toBe(1);
    expect(totals.inputTokens).toBe(10);
    expect(totals.outputTokens).toBe(5);
    expect(totals.cacheReadTokens).toBe(2);
    expect(totals.cacheCreationTokens).toBe(1);
    expect(totals.cacheTokens).toBe(3);
    expect(totals.totalTokens).toBe(18);
    expect(totals.tokensPerTask).toBeCloseTo(18);
    expect(totals.tokensPerRecord).toBeCloseTo(9);
    expect(totals.outputInputRatio).toBeCloseTo(0.5);
    expect(totals.cacheHitRate).toBeCloseTo(2 / 13);
    expect(totals.cacheReadToCreationRatio).toBeCloseTo(2);
    expect(totals.firstTimestamp).toBe("2026-06-01T10:00:00.000Z");
    expect(totals.latestTimestamp).toBe("2026-06-01T10:00:00.000Z");
    for (const value of Object.values(totals)) {
      if (typeof value === "number") expect(Number.isNaN(value)).toBe(false);
    }
  });

  it("keeps ratios at 0 when their denominators are 0", () => {
    const totals = computeTokenUsageTotals([
      record({ input_tokens: 0, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 }),
    ]);
    expect(totals.outputInputRatio).toBe(0);
    expect(totals.cacheReadToCreationRatio).toBe(0);
  });
});

describe("computeTokenDistributionStats", () => {
  it("returns all-zero stats for an empty array", () => {
    expect(computeTokenDistributionStats([])).toEqual({ mean: 0, median: 0, p95: 0 });
  });

  it("computes mean, median and p95 without mutating the input", () => {
    const values = [10, 30, 20, 40];
    const original = [...values];
    const stats = computeTokenDistributionStats(values);
    expect(stats.mean).toBeCloseTo(25);
    expect(stats.median).toBe(20);
    expect(stats.p95).toBe(40);
    expect(values).toEqual(original);
  });

  it("handles a single value", () => {
    expect(computeTokenDistributionStats([42])).toEqual({ mean: 42, median: 42, p95: 42 });
  });
});

describe("computeFastPathStats", () => {
  it("returns all-zero stats for an empty array", () => {
    expect(computeFastPathStats([])).toEqual({
      preflightTotal: 0,
      preflightFastPath: 0,
      preflightFastPathRate: 0,
      diagnoseTotal: 0,
      diagnoseFastPath: 0,
      diagnoseFastPathRate: 0,
    });
  });

  it("counts preflight and diagnose fast-path hits separately from full LLM calls", () => {
    const stats = computeFastPathStats([
      record({ phase: "preflight" }),
      record({ phase: "preflight" }),
      record({ phase: "preflight-fastpath" }),
      record({ phase: "diagnose" }),
      record({ phase: "diagnose-fastpath" }),
      record({ phase: "diagnose-local" }),
      record({ phase: "dispatch" }),
    ]);
    expect(stats.preflightTotal).toBe(3);
    expect(stats.preflightFastPath).toBe(1);
    expect(stats.preflightFastPathRate).toBeCloseTo(1 / 3);
    expect(stats.diagnoseTotal).toBe(3);
    expect(stats.diagnoseFastPath).toBe(2);
    expect(stats.diagnoseFastPathRate).toBeCloseTo(2 / 3);
  });
});

describe("computeReworkProxyStats", () => {
  it("counts only model-backed diagnose tokens and affected tasks", () => {
    const stats = computeReworkProxyStats([
      record({ task_id: "a", phase: "dispatch", input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      record({ task_id: "a", phase: "diagnose", input_tokens: 25, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      record({ task_id: "b", phase: "diagnose-fastpath", input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ]);
    expect(stats.diagnosisTokens).toBe(25);
    expect(stats.diagnosisTokenShare).toBeCloseTo(25 / 135);
    expect(stats.tasksWithDiagnosis).toBe(1);
    expect(stats.taskShare).toBeCloseTo(0.5);
    expect(stats.isExact).toBe(false);
    expect(stats.metadataCoverage).toBe(0);
  });

  it("computes exact retry tokens when every dispatch has attempt metadata", () => {
    const stats = computeReworkProxyStats([
      record({ phase: "dispatch", attempt: 1, outcome: "failed", input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      record({ phase: "dispatch", attempt: 2, outcome: "succeeded", input_tokens: 40, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ]);
    expect(stats.isExact).toBe(true);
    expect(stats.exactRetryTokens).toBe(40);
    expect(stats.exactRetryTokenShare).toBeCloseTo(40 / 140);
    expect(stats.retryAttempts).toBe(1);
    expect(stats.failedRetryAttempts).toBe(0);
  });

  it("surenka KODĖL buvo kartota, dažniausią pirma", () => {
    const stats = computeReworkProxyStats([
      record({ phase: "dispatch", attempt: 2, retry_reason: "gate-failed" }),
      record({ phase: "dispatch", attempt: 2, retry_reason: "gate-failed" }),
      record({ phase: "dispatch", attempt: 2, retry_reason: "rate-limit" }),
      record({ phase: "dispatch", attempt: 1 }),
    ]);

    expect(stats.retryReasons).toEqual([
      { reason: "gate-failed", count: 2 },
      { reason: "rate-limit", count: 1 },
    ]);
  });

  it("priežastis renka ir tada, kai `attempt` neužpildytas", () => {
    // Susiaurinus iki `attempt > 1` dingtų būtent tie atvejai, kur metaduomenų dengiamumas
    // prastas — t. y. tie, dėl kurių paaiškinimas ir reikalingas labiausiai.
    const stats = computeReworkProxyStats([record({ phase: "diagnose", retry_reason: "stop-bridge-timeout" })]);

    expect(stats.isExact).toBe(false);
    expect(stats.retryReasons).toEqual([{ reason: "stop-bridge-timeout", count: 1 }]);
  });
});

describe("computePeriodComparison", () => {
  it("compares the latest equal day window with the previous window", () => {
    const comparison = computePeriodComparison([
      record({ ts: "2026-06-01T10:00:00.000Z", task_id: "a", input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      record({ ts: "2026-06-02T10:00:00.000Z", task_id: "b", input_tokens: 200, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      record({ ts: "2026-06-03T10:00:00.000Z", task_id: "c", input_tokens: 300, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      record({ ts: "2026-06-04T10:00:00.000Z", task_id: "d", input_tokens: 600, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ]);
    expect(comparison.available).toBe(true);
    expect(comparison.daysPerPeriod).toBe(2);
    expect(comparison.previous.totalTokens).toBe(300);
    expect(comparison.current.totalTokens).toBe(900);
    expect(comparison.tokenDelta).toBeCloseTo(2);
  });

  it("is unavailable with fewer than two distinct days", () => {
    expect(computePeriodComparison([record()]).available).toBe(false);
  });

  // 2026-08-06 UI auditas: einamoji diena dalyvavo palyginime kaip lygiavertė, tad kelios ryto
  // valandos buvo lyginamos su visa vakarykšte para ir sprendimų panelė rodydavo dramatišką
  // „pagerėjimą", kurio nebuvo.
  it("excludes the still-running current day from the comparison", () => {
    const now = new Date(2026, 5, 5, 10, 0, 0);
    const rows = [
      record({ ts: "2026-06-01T10:00:00.000Z", task_id: "a", input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      record({ ts: "2026-06-02T10:00:00.000Z", task_id: "b", input_tokens: 200, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      record({ ts: "2026-06-03T10:00:00.000Z", task_id: "c", input_tokens: 300, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      record({ ts: "2026-06-04T10:00:00.000Z", task_id: "d", input_tokens: 600, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      // Nepilna šiandiena — vos keli tokenai, nes diena ką tik prasidėjo.
      record({ ts: "2026-06-05T09:00:00.000Z", task_id: "e", input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ];

    const comparison = computePeriodComparison(rows, now);
    expect(comparison.available).toBe(true);
    // Tas pats rezultatas kaip be nepilnos dienos: 06-01+06-02 prieš 06-03+06-04.
    expect(comparison.daysPerPeriod).toBe(2);
    expect(comparison.previous.totalTokens).toBe(300);
    expect(comparison.current.totalTokens).toBe(900);
  });
});

describe("tokenShareForKey", () => {
  const rows: AggregateRow[] = [
    { key: "diagnose", records: 1, inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 20 },
    { key: "dispatch", records: 1, inputTokens: 30, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 80 },
  ];

  it("returns the row's share of the given total", () => {
    expect(tokenShareForKey(rows, "diagnose", 100)).toBeCloseTo(0.2);
  });

  it("returns 0 when the key is not present", () => {
    expect(tokenShareForKey(rows, "fastpath", 100)).toBe(0);
  });

  it("returns 0 when totalTokens is 0", () => {
    expect(tokenShareForKey(rows, "diagnose", 0)).toBe(0);
  });
});

describe("toInclusiveIsoDateBoundary", () => {
  it("expands date input values from the user's local day to ISO boundaries", () => {
    expect(toInclusiveIsoDateBoundary("2026-06-10", "start")).toBe(
      new Date(2026, 5, 10, 0, 0, 0, 0).toISOString(),
    );
    expect(toInclusiveIsoDateBoundary("2026-06-10", "end")).toBe(
      new Date(2026, 5, 10, 23, 59, 59, 999).toISOString(),
    );
  });

  it("preserves full timestamps and omits empty values", () => {
    expect(toInclusiveIsoDateBoundary("2026-06-10T12:00:00.000Z", "end")).toBe("2026-06-10T12:00:00.000Z");
    expect(toInclusiveIsoDateBoundary("", "start")).toBeUndefined();
  });
});

describe("filterTokenUsageRecords", () => {
  const records: TokenUsageRecord[] = [
    record({ ts: "2026-06-01T10:00:00.000Z", model: "claude-opus", phase: "dispatch", task_id: "task-Alpha" }),
    record({ ts: "2026-06-05T10:00:00.000Z", model: "claude-haiku", phase: "diagnose", task_id: "task-Beta" }),
    record({ ts: "2026-06-10T10:00:00.000Z", model: "claude-opus", phase: "diagnose", task_id: "another" }),
  ];

  it("returns all records when filters are empty (identity)", () => {
    expect(filterTokenUsageRecords(records, {})).toEqual(records);
  });

  it("filters by exact model", () => {
    const result = filterTokenUsageRecords(records, { model: "claude-opus" });
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.model === "claude-opus")).toBe(true);
  });

  it("filters by exact phase", () => {
    const result = filterTokenUsageRecords(records, { phase: "diagnose" });
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.phase === "diagnose")).toBe(true);
  });

  it("filters by case-insensitive substring task_id query, trimmed", () => {
    const result = filterTokenUsageRecords(records, { taskIdQuery: "  alpha  " });
    expect(result).toHaveLength(1);
    expect(result[0].task_id).toBe("task-Alpha");
  });

  it("filters by inclusive from/to date bounds", () => {
    const result = filterTokenUsageRecords(records, {
      from: "2026-06-02T00:00:00.000Z",
      to: "2026-06-10T10:00:00.000Z",
    });
    expect(result.map((r) => r.task_id)).toEqual(["task-Beta", "another"]);
  });

  it("includes the entire day for date-only bounds", () => {
    const result = filterTokenUsageRecords(records, { from: "2026-06-10", to: "2026-06-10" });
    expect(result.map((r) => r.task_id)).toEqual(["another"]);
  });

  it("combines multiple filters", () => {
    const result = filterTokenUsageRecords(records, { model: "claude-opus", taskIdQuery: "another" });
    expect(result).toHaveLength(1);
    expect(result[0].task_id).toBe("another");
  });

  it("narrows correctly when model, phase, taskIdQuery, and from/to are all applied together", () => {
    const combinedRecords: TokenUsageRecord[] = [
      record({ ts: "2026-06-03T00:00:00.000Z", model: "claude-opus", phase: "diagnose", task_id: "task-gamma" }), // matches every filter
      record({ ts: "2026-06-03T00:00:00.000Z", model: "claude-opus", phase: "dispatch", task_id: "task-gamma" }), // wrong phase
      record({ ts: "2026-06-03T00:00:00.000Z", model: "claude-haiku", phase: "diagnose", task_id: "task-gamma" }), // wrong model
      record({ ts: "2026-06-03T00:00:00.000Z", model: "claude-opus", phase: "diagnose", task_id: "task-other" }), // taskIdQuery does not match
      record({ ts: "2026-06-20T00:00:00.000Z", model: "claude-opus", phase: "diagnose", task_id: "task-gamma" }), // after `to`
      record({ ts: "2026-05-01T00:00:00.000Z", model: "claude-opus", phase: "diagnose", task_id: "task-gamma" }), // before `from`
    ];

    const result = filterTokenUsageRecords(combinedRecords, {
      model: "claude-opus",
      phase: "diagnose",
      taskIdQuery: "gamma",
      from: "2026-06-01T00:00:00.000Z",
      to: "2026-06-10T00:00:00.000Z",
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(combinedRecords[0]);
  });
});

describe("sortAggregateRows", () => {
  const rows: AggregateRow[] = [
    { key: "b", records: 2, inputTokens: 20, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 25 },
    { key: "a", records: 5, inputTokens: 10, outputTokens: 15, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 75 },
  ];

  it("sorts ascending by a string key", () => {
    const result = sortAggregateRows(rows, "key", "asc");
    expect(result.map((r) => r.key)).toEqual(["a", "b"]);
  });

  it("sorts descending by a string key", () => {
    const result = sortAggregateRows(rows, "key", "desc");
    expect(result.map((r) => r.key)).toEqual(["b", "a"]);
  });

  it("sorts ascending by a numeric key", () => {
    const result = sortAggregateRows(rows, "records", "asc");
    expect(result.map((r) => r.records)).toEqual([2, 5]);
  });

  it("sorts descending by a numeric key", () => {
    const result = sortAggregateRows(rows, "totalTokens", "desc");
    expect(result.map((r) => r.totalTokens)).toEqual([75, 25]);
  });

  it("does not mutate the input array", () => {
    const original = [...rows];
    sortAggregateRows(rows, "key", "asc");
    expect(rows).toEqual(original);
    expect(rows[0]).toBe(original[0]);
    expect(rows[1]).toBe(original[1]);
  });
});

describe("uniqueSortedValues", () => {
  it("returns an empty array for no records", () => {
    expect(uniqueSortedValues([], "model")).toEqual([]);
  });

  it("dedupes and sorts model values", () => {
    const records = [record({ model: "b" }), record({ model: "a" }), record({ model: "b" })];
    expect(uniqueSortedValues(records, "model")).toEqual(["a", "b"]);
  });

  it("dedupes and sorts phase values", () => {
    const records = [record({ phase: "diagnose" }), record({ phase: "dispatch" }), record({ phase: "diagnose" })];
    expect(uniqueSortedValues(records, "phase")).toEqual(["diagnose", "dispatch"]);
  });
});
