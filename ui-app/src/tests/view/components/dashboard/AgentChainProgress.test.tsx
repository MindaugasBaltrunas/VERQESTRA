import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AgentActivity, SlotAgentActivity } from "../../../../model/types";
import { AgentChainProgress } from "../../../../view/components/dashboard/AgentChainProgress";

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

const w1Activity: AgentActivity = {
  chain: ["readme-guard", "coder"],
  statuses: { "readme-guard": "done", coder: "active" },
  currentAgent: "coder",
  currentActivity: "Rašo adapterį",
  taskId: "983-example",
  claudeStatus: "running",
  mode: "subagents",
  updatedAt: "2026-07-22T20:02:00.000Z",
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

const w1Slot: SlotAgentActivity = {
  worker_id: "w1",
  task_id: "983-example",
  attempt: 1,
  log_path: "vq/logs/w1/claude-last.log",
  activity: w1Activity,
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
    expect(screen.getByRole("heading", { name: "Active execution" })).toBeInTheDocument();
  });

  it("stays unchanged in sequential mode, without an empty w2 block", () => {
    render(<AgentChainProgress activity={activity} slots={[]} />);

    expect(screen.queryByText("Task: 982-example")).not.toBeInTheDocument();
    expect(screen.queryByText("reviewer")).not.toBeInTheDocument();
    expect(screen.getByText("architect")).toBeInTheDocument();
  });

  it("renders one lane per live slot, each from its own chain, in stream order", () => {
    render(<AgentChainProgress activity={activity} slots={[w2Slot, w1Slot]} />);

    expect(screen.getByText("Task: 983-example")).toBeInTheDocument();
    expect(screen.getByText("Rašo adapterį")).toBeInTheDocument();
    expect(screen.getByLabelText("readme-guard: done")).toBeInTheDocument();

    expect(screen.getByText("Task: 982-example")).toBeInTheDocument();
    expect(screen.getByText("Rašo testus")).toBeInTheDocument();
    expect(screen.getByLabelText("reviewer: done")).toBeInTheDocument();
    expect(screen.getByLabelText("tester: active")).toBeInTheDocument();

    // Srautų tvarka pagal numerį, ne pagal atėjimo eilę.
    const lanes = screen.getAllByText(/^Stream \d$/).map((node) => node.textContent);
    expect(lanes).toEqual(["Stream 1", "Stream 2"]);
  });

  it("hides the global mirror when live slots are present — it is another writer's log", () => {
    render(<AgentChainProgress activity={activity} slots={[w2Slot]} attribution="unknown" />);

    // Globalus `activity` (981-example, architect→coder) NERODOMAS: gyvo slot'o įrašas yra
    // tiesioginis įrodymas, o globalus failas — paskutinio rašytojo veidrodis.
    expect(screen.queryByText("architect")).not.toBeInTheDocument();
    expect(screen.queryByText("Task: 981-example")).not.toBeInTheDocument();
    expect(screen.queryByText("Stream unknown")).not.toBeInTheDocument();
    expect(screen.getByText("Task: 982-example")).toBeInTheDocument();
  });

  it("calls a finished run 'Last execution' and drops the stream attribution (task 106)", () => {
    const finished: AgentActivity = {
      ...activity,
      claudeStatus: "finished",
      currentActivity: null,
      statuses: { architect: "done", coder: "done" },
    };
    render(<AgentChainProgress activity={finished} attribution="unknown" streamLabel={null} />);

    expect(screen.getByRole("heading", { name: "Last execution" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Active execution" })).not.toBeInTheDocument();
    expect(screen.queryByText("Stream unknown")).not.toBeInTheDocument();
    // Grandinės rezultatas lieka matomas — tai užbaigto darbo įrodymas, ne laukiantis progresas.
    expect(screen.getByLabelText("coder: done")).toBeInTheDocument();
  });

  it("keeps the live heading and attribution while the run is active", () => {
    render(<AgentChainProgress activity={activity} attribution="attached" streamLabel="Stream 1" />);

    expect(screen.getByRole("heading", { name: "Active execution" })).toBeInTheDocument();
    expect(screen.getByText("Stream 1")).toBeInTheDocument();
  });
});
