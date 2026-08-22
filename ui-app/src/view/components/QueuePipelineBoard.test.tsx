import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LoopSlotView, WorkflowBucketView } from "../../model/dashboardViewModel";
import { buildQueuePipeline, type QueuePipelineInput } from "../../model/queuePipelineViewModel";
import { QueuePipelineBoard } from "./QueuePipelineBoard";

const NOW = Date.parse("2026-08-15T06:04:00.000Z");

function bucket(name: string, tasks: string[], totalTasks?: number): WorkflowBucketView {
  return {
    name,
    tasks,
    variant: "neutral",
    description: "",
    isQueue: name === "queue",
    totalTasks: totalTasks ?? tasks.length,
  };
}

function runningSlot(): LoopSlotView {
  return {
    workerId: "w1",
    index: 1,
    desired: "run",
    state: "running",
    taskId: "1233",
    attempt: 3,
    lastWave: null,
  };
}

function board(overrides: Partial<QueuePipelineInput> = {}) {
  return buildQueuePipeline({
    now: NOW,
    buckets: [],
    loopSlots: [],
    waveSlots: [],
    humanReview: [],
    rejections: [],
    refillDecisions: [],
    ...overrides,
  });
}

describe("QueuePipelineBoard", () => {
  it("always shows the five scheduler columns", () => {
    render(<QueuePipelineBoard board={board()} />);

    for (const title of ["Queued", "In progress", "Blocked", "Failed tasks", "Done"]) {
      expect(screen.getByLabelText(title)).toBeInTheDocument();
    }
  });

  it("says a column is empty instead of leaving a silent gap", () => {
    render(<QueuePipelineBoard board={board()} />);

    expect(screen.getAllByText("Nothing here")).toHaveLength(5);
  });

  it("shows why a task is blocked, not just that it is", () => {
    render(
      <QueuePipelineBoard
        board={board({
          humanReview: [
            {
              file: "1240-alpha.md",
              task_id: "1240-alpha",
              title: "Alpha",
              blocked_by: "supervisor approval",
              preview: "",
              actions: [],
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Requires your attention")).toBeInTheDocument();
    expect(screen.getByText(/Blocked by: supervisor approval/)).toBeInTheDocument();
  });

  it("shows the attempt count of a running task", () => {
    render(<QueuePipelineBoard board={board({ loopSlots: [runningSlot()] })} />);

    expect(screen.getByText("1233")).toBeInTheDocument();
    expect(screen.getByText(/Attempts: 3/)).toBeInTheDocument();
    expect(screen.getByText(/Stream 1/)).toBeInTheDocument();
  });

  it("says out loud how much of a column was cut off", () => {
    const files = Array.from({ length: 12 }, (_, index) => `13${String(index).padStart(2, "0")}-done.md`);
    render(<QueuePipelineBoard board={board({ buckets: [bucket("done", files, 42)] })} />);

    // Tyliai nukirpta uodega atrodytų kaip visas eilės turinys.
    expect(screen.getByText("Showing 10 of 42")).toBeInTheDocument();
  });

  it("warns that blocked reasons are incomplete when no wave data arrived", () => {
    render(<QueuePipelineBoard board={board({ waveSlots: undefined })} />);

    expect(screen.getByText(/Wave data is unavailable; blocked reasons may be incomplete\./)).toBeInTheDocument();
  });

  it("stays silent about the wave source when it is known", () => {
    render(<QueuePipelineBoard board={board({ waveSlots: [] })} />);

    expect(screen.queryByText(/Wave data is unavailable/)).toBeNull();
  });
});
