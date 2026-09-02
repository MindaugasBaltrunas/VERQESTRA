import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { WorkflowBucketView } from "../../model/dashboardViewModel";
import { WorkflowBoard } from "./WorkflowBoard";

const buckets: WorkflowBucketView[] = [
  {
    name: "done",
    tasks: ["task-20.md", "task-21.md"],
    totalTasks: 3,
    variant: "good",
    description: "Completed and delivered",
    isQueue: false,
  },
];

describe("WorkflowBoard", () => {
  it("shows the total and loads the complete bucket on demand", async () => {
    const onLoadTasks = vi.fn().mockResolvedValue(["task-1.md", "task-2.md", "task-3.md"]);
    render(
      <WorkflowBoard
        buckets={buckets}
        onOpenFolder={vi.fn()}
        onUpload={vi.fn()}
        onLoadTasks={onLoadTasks}
      />,
    );

    expect(screen.getByText("3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show all (3)" }));

    await waitFor(() => expect(onLoadTasks).toHaveBeenCalledWith("done"));
    // 2026-08-24 (operatoriaus nurodymas): sąraše rodomas užduoties ID ir pavadinimas, be
    // plėtinio — jis stumdavo pavadinimą iš matomo ploto ir vertė jį kirpti. PILNAS vardas
    // NEDINGSTA: jis lieka `title`, tad detalė pasiekiama. Tai skirtumas tarp trumpinimo ir
    // informacijos praradimo.
    expect(screen.getByText("task-1")).toBeInTheDocument();
    expect(screen.getByTitle("task-1.md")).toBeInTheDocument();
    expect(screen.getByText("Showing all 3 tasks")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open folder: done" })).toBeInTheDocument();
  });

  // 2026-09-02 auditas: worktree slot'ų task'ai pagrindiniame medyje tebeguli `queue`, tad lenta
  // rodė juos kaip laukiančius, o „Running" — tik pirminio medžio `delegated`/`active` task'ą.
  it("marks queued tasks that are live in worktree streams and lists them as running", () => {
    const liveBuckets: WorkflowBucketView[] = [
      {
        name: "queue",
        tasks: ["118-native-shell.md", "122-reducer.md", "150-allowed-paths.md"],
        totalTasks: 3,
        variant: "neutral",
        description: "Waiting to start",
        isQueue: true,
      },
      {
        name: "delegated",
        tasks: ["148-b-03-infra.md"],
        totalTasks: 1,
        variant: "live",
        description: "Agent is working",
        isQueue: false,
      },
    ];
    render(
      <WorkflowBoard
        buckets={liveBuckets}
        liveSlots={[
          { workerId: "w2", index: 2, taskId: "118-native-shell" },
          { workerId: "w1", index: 1, taskId: "122-reducer" },
        ]}
        onOpenFolder={vi.fn()}
        onUpload={vi.fn()}
        onLoadTasks={vi.fn()}
      />,
    );

    // Pirminio medžio task'as pirmas, po jo srautai pagal numerį — ne pagal atėjimo eilę.
    expect(screen.getByRole("status", { name: "" })).toBeTruthy();
    expect(screen.getByText("148-b-03-infra, 122-reducer (Stream 1), 118-native-shell (Stream 2)")).toBeInTheDocument();

    // Eilės kortelėje gyvi task'ai turi srauto ženklelį, o laukiantis — ne.
    expect(screen.getByText("Stream 1")).toBeInTheDocument();
    expect(screen.getByText("Stream 2")).toBeInTheDocument();
    expect(screen.getByTitle("Running in stream 2")).toBeInTheDocument();
    expect(screen.getByTitle("150-allowed-paths.md")).toBeInTheDocument();
    expect(screen.getByText("2 of these are running in worktree streams right now")).toBeInTheDocument();
  });

  it("keeps the old running line when no stream information is available", () => {
    render(
      <WorkflowBoard
        buckets={[
          { name: "active", tasks: ["0042-x.md"], totalTasks: 1, variant: "live", description: "Under validation", isQueue: false },
        ]}
        onOpenFolder={vi.fn()}
        onUpload={vi.fn()}
        onLoadTasks={vi.fn()}
      />,
    );

    expect(screen.getByText("0042-x")).toBeInTheDocument();
    expect(screen.queryByText(/Stream/)).not.toBeInTheDocument();
  });
});
