import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { OverviewMetric, WorkerControlView } from "../../../../model/dashboardViewModel";
import type { SlotProgressView } from "../../../../model/slotProgressViewModel";
import { I18nProvider } from "../../../../i18n/I18nContext";
import { OverviewPanel } from "../../../../view/components/dashboard/OverviewPanel";

function slotView(overrides: Partial<SlotProgressView> = {}): SlotProgressView {
  return {
    workerId: "w2",
    index: 2,
    taskId: "1234-backend",
    attempt: 1,
    desired: "run",
    state: "running",
    phase: "implementation",
    phaseDetail: "coder",
    elapsedMs: null,
    progress: { signal: "none" },
    eta: { state: "unavailable", reason: "no-source" },
    worktree: "unknown",
    lease: { known: false, status: null, stale: false, heartbeatAgeMs: null, mismatchedTask: false },
    lastError: null,
    blocked: null,
    liveness: "unknown",
    chain: null,
    ...overrides,
  };
}

function workerControl(overrides: Partial<WorkerControlView> = {}): WorkerControlView {
  return {
    requested: 1,
    source: "default",
    canEdit: true,
    lastWaveKnown: false,
    granted: 0,
    grantedOf: 1,
    max: 0,
    rejected: [],
    ...overrides,
  };
}

const metrics: OverviewMetric[] = [{ label: "Decision", value: "PASS", variant: "good" }];

function renderPanel(props: Partial<Parameters<typeof OverviewPanel>[0]> = {}) {
  render(
    <I18nProvider>
      <OverviewPanel metrics={metrics} {...props} />
    </I18nProvider>,
  );
}

describe("OverviewPanel w2 and wave signals", () => {
  it("shows the w2 live task with elapsed minutes", () => {
    renderPanel({ slotProgress: [slotView({ taskId: "1234-backend", elapsedMs: 125_000 })] });

    expect(screen.getByText("1234-backend (2m)")).toBeInTheDocument();
  });

  it("shows the w2 live task without elapsed time when it is not known", () => {
    renderPanel({ slotProgress: [slotView({ taskId: "1234-backend", elapsedMs: null })] });

    expect(screen.getByText("1234-backend")).toBeInTheDocument();
  });

  it("does not show a w2 row when w2 has no task", () => {
    renderPanel({ slotProgress: [slotView({ taskId: null, elapsedMs: null })] });

    expect(screen.queryByText("W2 live task")).not.toBeInTheDocument();
  });

  it("does not show a w2 row when there is no slot progress at all", () => {
    renderPanel({ slotProgress: [] });

    expect(screen.queryByText("W2 live task")).not.toBeInTheDocument();
  });

  it("reports sequential mode when only one slot was granted", () => {
    renderPanel({ workerControl: workerControl({ lastWaveKnown: true, granted: 1, grantedOf: 1 }) });

    expect(screen.getByText("sequential")).toBeInTheDocument();
  });

  it("reports full parallel mode when every requested slot was granted", () => {
    renderPanel({ workerControl: workerControl({ lastWaveKnown: true, granted: 2, grantedOf: 2 }) });

    expect(screen.getByText("parallel 2/2")).toBeInTheDocument();
  });

  it("says how many slots were actually granted when the wave rejected some", () => {
    // `parallel 2/3` skaitėsi kaip lygiagretus vykdymas, nors trečias slot'as buvo atmestas.
    renderPanel({ workerControl: workerControl({ lastWaveKnown: true, granted: 2, grantedOf: 3 }) });

    expect(screen.getByText("parallel 2/3 granted")).toBeInTheDocument();
  });

  it("shows the w1 live task too — signals are symmetric across streams", () => {
    renderPanel({
      slotProgress: [
        slotView({ workerId: "w1", index: 1, taskId: "1111-front", elapsedMs: 60_000 }),
        slotView({ taskId: "1234-backend", elapsedMs: null }),
      ],
    });

    // Numatytoji kalba yra `lt`, tad etiketės tikrinamos išverstos — būtent tai ir matys operatorius.
    expect(screen.getByText("W1 gyva užduotis")).toBeInTheDocument();
    expect(screen.getByText("1111-front (1m)")).toBeInTheDocument();
    expect(screen.getByText("W2 gyva užduotis")).toBeInTheDocument();
  });

  it("shows the w1 last failure with its own label", () => {
    renderPanel({
      slotProgress: [
        slotView({
          workerId: "w1",
          index: 1,
          taskId: null,
          lastError: { ts: "2026-09-02T00:00:00.000Z", taskId: "1111-front", reason: "task-failed" },
        }),
      ],
    });

    expect(screen.getByText("W1 paskutinė nesėkmė")).toBeInTheDocument();
    expect(screen.getByText("task-failed")).toBeInTheDocument();
  });

  it("does not show a wave mode row before any wave has run", () => {
    renderPanel({ workerControl: workerControl({ lastWaveKnown: false }) });

    expect(screen.queryByText("Wave mode")).not.toBeInTheDocument();
  });

  it("shows the w2 last failure reason when lastError is set", () => {
    renderPanel({
      slotProgress: [
        slotView({ lastError: { ts: "2026-08-30T00:00:00.000Z", taskId: "1234-backend", reason: "timeout" } }),
      ],
    });

    expect(screen.getByText("timeout")).toBeInTheDocument();
  });

  it("does not show a w2 last failure row when lastError is null", () => {
    renderPanel({ slotProgress: [slotView({ lastError: null })] });

    expect(screen.queryByText("W2 last failure")).not.toBeInTheDocument();
  });
});
