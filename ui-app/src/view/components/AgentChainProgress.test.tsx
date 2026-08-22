import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AgentActivity } from "../../model/types";
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

describe("AgentChainProgress", () => {
  it("shows agent names together with accessible statuses", () => {
    render(<AgentChainProgress activity={activity} />);

    expect(screen.getByText("architect")).toBeInTheDocument();
    expect(screen.getByText("coder")).toBeInTheDocument();
    expect(screen.getByLabelText("architect: done")).toBeInTheDocument();
    expect(screen.getByLabelText("coder: active")).toBeInTheDocument();
  });
});
