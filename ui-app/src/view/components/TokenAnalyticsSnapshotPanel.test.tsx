import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TokenAnalyticsSnapshot } from "../../model/types";
import { TokenAnalyticsSnapshotPanel } from "./TokenAnalyticsSnapshotPanel";

const snapshot: TokenAnalyticsSnapshot = {
  generatedAt: "2026-07-22T12:00:00.000Z",
  totals: { records: 10, totalTokens: 1_000, uniqueTasks: 4 },
  tokensByPhase: [{ key: "dispatch", totalTokens: 1_000 }],
  tokensByModel: [{ key: "sonnet", totalTokens: 1_000 }],
  tokensByDay: [
    { key: "2026-07-21", totalTokens: 400 },
    { key: "2026-07-22", totalTokens: 600 },
  ],
  fastPathHitRate: { preflight: 0.5, diagnose: 0.75 },
  cacheHitRate: 0.8,
  repairShare: 0.25,
  groupMedians: [
    { familyKey: "1", taskCount: 2, medianTokens: 100 },
    { familyKey: "2", taskCount: 2, medianTokens: 300 },
  ],
};

describe("TokenAnalyticsSnapshotPanel", () => {
  it("renders every snapshot metric family", () => {
    render(<TokenAnalyticsSnapshotPanel snapshot={snapshot} />);
    expect(screen.getByText("1 000")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("2 days · 2026-07-21–2026-07-22")).toBeInTheDocument();
    expect(screen.getByText("2 groups")).toBeInTheDocument();
    expect(screen.getByText("Tasks with repair")).toBeInTheDocument();
  });

  it("explains when persisted history does not exist yet", () => {
    render(<TokenAnalyticsSnapshotPanel snapshot={null} />);
    expect(screen.getByText(/Snapshot history has not been created/)).toBeInTheDocument();
  });
});
