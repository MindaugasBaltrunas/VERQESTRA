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
});
