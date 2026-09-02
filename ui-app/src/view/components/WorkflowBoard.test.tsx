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

    // Srautų task'ai rodomi VYKDYMO (`delegated`) kortelėje su ženkleliu, kaip ir pirminio medžio
    // task'as — ne eilėje (2026-09-02: „kodėl w2 neperkeliama kaip w1?"). Eilės peržiūroje jų
    // nebėra, liko tik laukiantis ir suvestinė, kiek eilės failų sukasi srautuose.
    const delegatedCard = document.querySelector(".workflow-card--delegated")!;
    const delegatedItems = [...delegatedCard.querySelectorAll("li")].map((item) => item.textContent ?? "");
    expect(delegatedItems[0]).toMatch(/^122.*Stream 1$/);
    expect(delegatedItems[1]).toMatch(/^118.*Stream 2$/);
    expect(delegatedItems[2]).toMatch(/^148/);
    expect(
      screen.getByTitle("Running in stream 2; the file stays in the queue folder until the branch is merged"),
    ).toBeInTheDocument();

    const queueCard = document.querySelector(".workflow-card--queue")!;
    const queueItems = [...queueCard.querySelectorAll("li")].map((item) => item.textContent ?? "");
    expect(queueItems).toHaveLength(1);
    expect(queueItems[0]).toMatch(/^150/);
    expect(screen.getByTitle("150-allowed-paths.md")).toBeInTheDocument();
    expect(screen.getByText("2 of these are running in worktree streams right now")).toBeInTheDocument();
  });

  // 2026-09-02 (operatoriaus radinys): du srautai dirbo, o „suvestinė nerodė jų pozicijos" —
  // serveris į eilės kortelę deda tik pirmus N failų, ir gyvi task'ai liko už tos ribos. Jie
  // prisegami kortelės viršuje su srauto ženkleliu ir skaičiuojami suvestinėje.
  it("pins live stream tasks at the top of the queue card when the preview does not include them", () => {
    render(
      <WorkflowBoard
        buckets={[
          { name: "queue", tasks: ["101-a.md", "107-b.md"], totalTasks: 25, variant: "neutral", description: "Waiting to start", isQueue: true },
          { name: "done", tasks: ["100-x.md"], totalTasks: 1, variant: "good", description: "Completed", isQueue: false },
        ]}
        liveSlots={[
          { workerId: "w2", index: 2, taskId: "152-a-02-koordinatorius" },
          { workerId: "w1", index: 1, taskId: "153-a-02-scheduling" },
        ]}
        onOpenFolder={vi.fn()}
        onUpload={vi.fn()}
        onLoadTasks={vi.fn()}
      />,
    );

    const queueItems = screen.getAllByRole("listitem").map((item) => item.textContent ?? "");
    // Prisegti srautai eina PIRMI ir srauto numerio tvarka; laukiantys — po jų. Etiketė
    // (`taskFileLabel`) skaido id ir vardą, tad tikrinamas numeris ir srauto ženklelis.
    expect(queueItems[0]).toMatch(/^153.*Stream 1$/);
    expect(queueItems[1]).toMatch(/^152.*Stream 2$/);
    expect(queueItems[2]).toMatch(/^101/);
    expect(
      screen.getByTitle("Running in stream 1; the file stays in the queue folder until the branch is merged"),
    ).toBeInTheDocument();
    expect(screen.getByText("2 of these are running in worktree streams right now")).toBeInTheDocument();
    // Antraštė toliau įvardija abu.
    expect(screen.getByText("153-a-02-scheduling (Stream 1), 152-a-02-koordinatorius (Stream 2)")).toBeInTheDocument();
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
