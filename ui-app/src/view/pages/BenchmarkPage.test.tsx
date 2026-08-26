import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BenchmarkPage } from "./BenchmarkPage";
import * as api from "../../model/api";
import type { BenchmarkReportDocument, BenchmarkReportView } from "../../model/types";

vi.mock("../../model/api", () => ({
  fetchBenchmarkReport: vi.fn(),
  getUiToken: vi.fn().mockReturnValue(""),
}));

const noop = () => undefined;

afterEach(() => {
  vi.mocked(api.fetchBenchmarkReport).mockReset();
});

function report(overrides: Partial<BenchmarkReportDocument> = {}): BenchmarkReportDocument {
  return {
    schemaVersion: 1,
    verdict: "stable",
    verdictBasis: "comparison",
    reasons: ["nothing material moved"],
    current: {
      identity: {
        suiteHash: "sha256:aaa", configHash: "sha256:bbb", policyHash: "sha256:ccc",
        agCommit: "d".repeat(40),
        modeAdapterVersions: [{ mode: "ag-loop", version: "ag-loop/1" }],
      },
      environment: { platform: "linux", arch: "x64", nodeVersion: "v22.15.0", cpuCount: 8 },
      sampleCount: 6,
      modes: ["ag-loop"],
    },
    baseline: {
      identity: {
        suiteHash: "sha256:aaa", configHash: "sha256:bbb", policyHash: "sha256:ccc",
        agCommit: "e".repeat(40),
        modeAdapterVersions: [{ mode: "ag-loop", version: "ag-loop/1" }],
      },
      environment: { platform: "linux", arch: "x64", nodeVersion: "v22.15.0", cpuCount: 8 },
      sampleCount: 6,
      modes: ["ag-loop"],
    },
    modes: [
      {
        mode: "ag-loop",
        baselineSampleCount: 6,
        currentSampleCount: 6,
        metrics: [
          { metric: "acceptedRate", kind: "rate", baseline: 0.8, current: 0.83, absoluteDelta: 0.03, relativeDelta: 0.0375 },
          { metric: "firstPassRate", kind: "rate", baseline: 0.6, current: 0.6, absoluteDelta: 0, relativeDelta: 0 },
          // BENCH-7 nulinis vardiklis: relativeDelta neegzistuoja, bet absoliutus IŠMATUOTAS —
          // headline KPI privalo rodyti „+0 p.p.", ne n/a (2026-08-26 regresija).
          { metric: "humanReviewRate", kind: "rate", baseline: 0, current: 0, absoluteDelta: 0, relativeDelta: undefined },
          { metric: "perVerifiedAcceptedChange.billableTokens", kind: "cost", baseline: 12_000, current: 11_500, absoluteDelta: -500, relativeDelta: -0.0417 },
          // BENCH-7 nulinis vardiklis: relativeDelta neegzistuoja, bet absoliutus IŠMATUOTAS —
          // puslapis privalo rodyti „0 p.p.", ne n/a (2026-08-26 regresija).
          { metric: "securityFailureRate", kind: "rate", baseline: 0, current: 0, absoluteDelta: 0, relativeDelta: undefined },
        ],
        differences: [{ aspect: "telemetry", code: "loop-only", detail: "only ag-loop can report a repair" }],
      },
    ],
    scenarios: [
      {
        scenarioId: "code-change-01", mode: "ag-loop", verdict: "stable", reasons: [],
        baseline: { count: 3, median: 4000, mean: 4100, min: 3900, max: 4400, standardDeviation: 200, successCount: 3 },
        current: { count: 3, median: 3900, mean: 3950, min: 3800, max: 4200, standardDeviation: 180, successCount: 3 },
      },
    ],
    limitations: ["every number in this report is rounded to 4 decimal place(s)"],
    reproduction: { arguments: ["ag", "benchmark", "report"], command: "ag benchmark report" },
    ...overrides,
  };
}

function view(overrides: Partial<BenchmarkReportView> = {}): BenchmarkReportView {
  return {
    state: "available",
    reason: undefined,
    source: { path: "AG/benchmark/reports/benchmark-report.json", command: "pnpm --dir AG/benchmark benchmark:report" },
    freshness: { reportedAgCommit: "d".repeat(40), currentAgCommit: "d".repeat(40) },
    report: report(),
    ...overrides,
  };
}

describe("BenchmarkPage", () => {
  it("shows a loading state, then a success verdict with baseline metrics", async () => {
    vi.mocked(api.fetchBenchmarkReport).mockResolvedValue(view());
    render(<BenchmarkPage activeRoute="benchmark" onNavigate={noop} />);

    expect(screen.getByText("Loading...")).toBeInTheDocument();
    await waitFor(() => {
      const verdictHeading = screen.getByRole("heading", { name: "Verdict" });
      const stableBadge = verdictHeading.closest("section")!.querySelector(".badge.status-good");
      expect(stableBadge).toHaveTextContent("stable");
    });
    expect(screen.getByText("code-change-01")).toBeInTheDocument();
    // Nulinio baseline delta rodomas procentiniais punktais, ne paliekamas kaip n/a.
    expect(screen.getByText(/0 p\.p\./)).toBeInTheDocument();
  });

  it("shows the empty state when no report has been generated", async () => {
    vi.mocked(api.fetchBenchmarkReport).mockResolvedValue(view({
      state: "missing",
      reason: "AG/benchmark/reports/benchmark-report.json does not exist.",
      report: undefined,
    }));
    render(<BenchmarkPage activeRoute="benchmark" onNavigate={noop} />);

    await waitFor(() => expect(screen.getByText("No benchmark report available")).toBeInTheDocument());
    expect(screen.getByText(/does not exist/)).toBeInTheDocument();
  });

  it("shows an error state and allows retry", async () => {
    vi.mocked(api.fetchBenchmarkReport).mockRejectedValueOnce(new Error("boom"));
    render(<BenchmarkPage activeRoute="benchmark" onNavigate={noop} />);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("boom"));

    vi.mocked(api.fetchBenchmarkReport).mockResolvedValueOnce(view());
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      const verdictHeading = screen.getByRole("heading", { name: "Verdict" });
      const stableBadge = verdictHeading.closest("section")!.querySelector(".badge.status-good");
      expect(stableBadge).toHaveTextContent("stable");
    });
  });

  it("shows a stale warning while still rendering the underlying report", async () => {
    vi.mocked(api.fetchBenchmarkReport).mockResolvedValue(view({
      state: "stale",
      reason: "the report was measured on AG commit deadbeefcafe, but HEAD is 000000000000.",
    }));
    render(<BenchmarkPage activeRoute="benchmark" onNavigate={noop} />);

    await waitFor(() => expect(screen.getByText(/This report is stale/)).toBeInTheDocument());
    const verdictHeading = screen.getByRole("heading", { name: "Verdict" });
    const stableBadge = verdictHeading.closest("section")!.querySelector(".badge.status-good");
    expect(stableBadge).toHaveTextContent("stable");
  });

  it("shows the no-baseline note for an inconclusive verdict", async () => {
    vi.mocked(api.fetchBenchmarkReport).mockResolvedValue(view({
      report: report({
        verdict: "inconclusive",
        verdictBasis: "no-baseline",
        reasons: ["no-baseline-comparison"],
        baseline: undefined,
        modes: [{
          mode: "ag-loop",
          baselineSampleCount: undefined,
          currentSampleCount: 6,
          metrics: [{ metric: "acceptedRate", kind: "rate", baseline: undefined, current: 0.83, absoluteDelta: undefined, relativeDelta: undefined }],
          differences: [],
        }],
      }),
    }));
    render(<BenchmarkPage activeRoute="benchmark" onNavigate={noop} />);

    await waitFor(() => expect(screen.getByText("inconclusive")).toBeInTheDocument());
    expect(screen.getByText("No baseline comparison was supplied.")).toBeInTheDocument();
    expect(screen.getByText("No baseline recorded")).toBeInTheDocument();
  });

  it("shows regression reasons and lets a scenario be selected for drill-down", async () => {
    vi.mocked(api.fetchBenchmarkReport).mockResolvedValue(view({
      report: report({
        verdict: "regressed",
        reasons: ["scenario code-change-01 regressed"],
        scenarios: [
          {
            scenarioId: "code-change-01", mode: "ag-loop", verdict: "regressed",
            reasons: ["a new security violation appeared"],
            baseline: { count: 3, median: 4000, mean: 4100, min: 3900, max: 4400, standardDeviation: 200, successCount: 3 },
            current: { count: 3, median: 9000, mean: 9100, min: 8900, max: 9400, standardDeviation: 200, successCount: 1 },
          },
        ],
      }),
    }));
    render(<BenchmarkPage activeRoute="benchmark" onNavigate={noop} />);

    await waitFor(() => expect(screen.getAllByText("regressed").length).toBeGreaterThan(0));
    // The only scenario is auto-selected, so its reason legitimately renders twice:
    // once in the auto-opened drill-down detail and once in the "Regression reasons" summary.
    // Selection itself lands one render after the data commit (a separate effect), so this
    // must be awaited rather than asserted immediately after the "regressed" badge appears.
    await waitFor(() => expect(screen.getAllByText("a new security violation appeared")).toHaveLength(2));

    fireEvent.click(screen.getByText("code-change-01"));
    await waitFor(() => expect(screen.getByRole("heading", { level: 3, name: /code-change-01 · ag-loop/ })).toBeInTheDocument());
  });
});
