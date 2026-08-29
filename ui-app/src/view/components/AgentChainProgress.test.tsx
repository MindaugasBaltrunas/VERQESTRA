import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AgentActivity, SlotAgentActivity } from "../../model/types";
import { AgentChainProgress } from "./AgentChainProgress";

const activity: AgentActivity = {
  chain: ["architect", "coder"],
  statuses: { architect: "done", coder: "active" },
  currentAgent: "coder",
  currentActivity: "Taiso UI",
  taskId: "981-example",
  claudeStatus: "running",
  mode: "subagents",
  updatedAt: "2026-07-22T20:00:00.000Z",
};

const w2Activity: AgentActivity = {
  chain: ["reviewer", "tester"],
  statuses: { reviewer: "done", tester: "active" },
  currentAgent: "tester",
  currentActivity: "Rašo testus",
  taskId: "982-example",
  claudeStatus: "running",
  mode: "subagents",
  updatedAt: "2026-07-22T20:01:00.000Z",
};

const w2Slot: SlotAgentActivity = {
  worker_id: "w2",
  task_id: "982-example",
  attempt: 1,
  log_path: "vq/logs/w2/claude-last.log",
  activity: w2Activity,
};

describe("AgentChainProgress", () => {
  it("shows agent names together with accessible statuses", () => {
    render(<AgentChainProgress activity={activity} />);

    expect(screen.getByText("architect")).toBeInTheDocument();
    expect(screen.getByText("coder")).toBeInTheDocument();
    expect(screen.getByLabelText("architect: done")).toBeInTheDocument();
    expect(screen.getByLabelText("coder: active")).toBeInTheDocument();
  });

  it("stays unchanged in sequential mode, without an empty w2 block", () => {
    render(<AgentChainProgress activity={activity} slots={[]} />);

    expect(screen.queryByText("Task: 982-example")).not.toBeInTheDocument();
    expect(screen.queryByText("reviewer")).not.toBeInTheDocument();
  });

  it("renders a second parallel chain lane when a live w2 slot is present", () => {
    render(<AgentChainProgress activity={activity} slots={[w2Slot]} />);

    // Pirmoji juosta lieka nepakitusi.
    expect(screen.getByText("architect")).toBeInTheDocument();
    expect(screen.getByText("coder")).toBeInTheDocument();

    // Antra juosta rodo w2 task id, fazę ir jo pačio grandinę.
    expect(screen.getByText("Task: 982-example")).toBeInTheDocument();
    expect(screen.getByText("Rašo testus")).toBeInTheDocument();
    expect(screen.getByText("reviewer")).toBeInTheDocument();
    expect(screen.getByText("tester")).toBeInTheDocument();
    expect(screen.getByLabelText("reviewer: done")).toBeInTheDocument();
    expect(screen.getByLabelText("tester: active")).toBeInTheDocument();
  });
});
