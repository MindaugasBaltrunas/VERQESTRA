import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LoopControlView, LoopSlotView } from "../../model/dashboardViewModel";
import { buildSlotProgressViews, type SlotProgressView } from "../../model/slotProgressViewModel";
import type { UiWaveSlot } from "../../model/types";
import { LoopStreamCards } from "./LoopStreamCards";

const NOW = Date.parse("2026-08-15T06:04:00.000Z");

function slot(overrides: Partial<LoopSlotView> = {}): LoopSlotView {
  return {
    workerId: "w1",
    index: 1,
    desired: "run",
    state: "idle",
    taskId: null,
    attempt: null,
    lastWave: null,
    ...overrides,
  };
}

/**
 * Abu srautai su darbu.
 *
 * Nuo 2026-08-24 tuščio srauto stabdyti ir nutraukti nebegalima (operatoriaus nurodymas), tad
 * per-srautinio TAIKYMO testai negali remtis numatytuoju fixture'u, kuriame `w2` tuščias — jie
 * tikrintų išjungtą mygtuką, o ne tai, kad paspaudimas pataiko į teisingą srautą. Numatytasis
 * fixture lieka nepaliestas: juo remiasi „No task assigned" atvejis.
 */
function bothStreamsWorking(): LoopControlView {
  return loopControl({
    slots: [
      slot({ state: "running", taskId: "1233-loop-streams", attempt: 2 }),
      slot({ workerId: "w2", index: 2, state: "running", taskId: "1233-antra", attempt: 1 }),
    ],
  });
}

function loopControl(overrides: Partial<LoopControlView> = {}): LoopControlView {
  return {
    known: true,
    loopStatus: "running",
    stopRequested: false,
    slots: [
      slot({ state: "running", taskId: "1233-loop-streams", attempt: 2 }),
      slot({ workerId: "w2", index: 2 }),
    ],
    ...overrides,
  };
}

const leases: UiWaveSlot[] = [
  {
    worker_id: "w1",
    task_id: "1233-loop-streams",
    state: "running",
    lease_status: "held",
    acquired_at: "2026-08-15T06:00:00.000Z",
    heartbeat_at: "2026-08-15T06:03:55.000Z",
    expires_at: "2026-08-15T06:10:00.000Z",
    lease_age_ms: 240_000,
    heartbeat_age_ms: 5_000,
    stale: false,
    has_worktree: true,
    last_failure: null,
  },
];

/**
 * Progreso rodinys statomas TUO PAČIU keliu kaip produkcijoje (`DashboardPage`): rankomis surašytos
 * kortelės testuotų išgalvotą duomenų formą, o ne tą, kurią komponentas realiai gauna.
 */
function progressFor(control: LoopControlView): SlotProgressView[] {
  return buildSlotProgressViews({
    now: NOW,
    loopControl: control,
    waveSlots: leases,
    activity: null,
    activityStatus: "live",
  });
}

function stream(index: number) {
  return within(screen.getByRole("article", { name: `Stream ${index}` }));
}

// Produkcijoje `slotProgress` perduodamas VISADA (`RuntimePanel` gauna jį iš `DashboardPage`),
// todėl būtent ši šaka turi būti patikrinta: kitaip testuojamas kelias, kurio vartotojas nemato.
describe("LoopStreamCards with slot progress", () => {
  it("renders the progress card and keeps every stream visible", () => {
    const control = loopControl();
    render(<LoopStreamCards loopControl={control} slotProgress={progressFor(control)} />);

    expect(screen.getByRole("heading", { name: "Loop streams" })).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(2);
    // `Elapsed` yra tik progreso kortelėje: jos buvimas įrodo, kad testuojama TA šaka.
    expect(stream(1).getByText("Elapsed")).toBeInTheDocument();
    expect(stream(1).getByText("4m")).toBeInTheDocument();
    expect(stream(1).getByText("Task 1233-loop-streams, attempt 2")).toBeInTheDocument();
    expect(stream(1).getByText("Running")).toBeInTheDocument();
    expect(stream(2).getByText("No task assigned")).toBeInTheDocument();
    // Laukiančiam srautui būsena ir fazė sutampa, tad tas pats žodis stovi abiejose vietose.
    expect(stream(2).getAllByText("Idle")).toHaveLength(2);
  });

  it("drains exactly the stream whose button was pressed", () => {
    const control = bothStreamsWorking();
    const onStopSlot = vi.fn();
    render(<LoopStreamCards loopControl={control} slotProgress={progressFor(control)} onStopSlot={onStopSlot} />);

    fireEvent.click(stream(2).getByRole("button", { name: "Stop stream (drain)" }));

    expect(onStopSlot).toHaveBeenCalledWith("w2");
  });

  // 2026-08-24, operatoriaus nurodymas: „Išjungti srauto stabdymą bei nutraukimą, kai srautas
  // tuščias." `drain` ir `abort` veikia VYKDOMĄ bandymą — tuščiam srautui jie nekeičia nieko, tad
  // aktyvus mygtukas žada veiksmą, kurio vienintelė galima pasekmė yra tyla.
  it("tuščiame sraute stabdymas ir nutraukimas IŠJUNGTI, o tęsimas lieka", () => {
    const control = loopControl();
    const onStopSlot = vi.fn();
    render(
      <LoopStreamCards
        loopControl={control}
        slotProgress={progressFor(control)}
        onStopSlot={onStopSlot}
        onAbortSlot={vi.fn()}
        onResumeSlot={vi.fn()}
      />,
    );

    const drain = stream(2).getByRole("button", { name: "Stop stream (drain)" });
    expect(drain).toBeDisabled();
    expect(stream(2).getByRole("button", { name: "Abort stream" })).toBeDisabled();
    // Priežastis pasiekiama, o ne nutylima: išjungtas mygtukas be paaiškinimo yra mįslė.
    // Be `I18nProvider` `t()` grąžina patį raktą — tai numatytoji anglų kalba, ne trūkstamas vertimas.
    expect(drain).toHaveAttribute("title", "The stream has no running task");

    fireEvent.click(drain);
    expect(onStopSlot).not.toHaveBeenCalled();
  });

  it("dirbantis srautas lieka valdomas — taisyklė liečia TIK tuščią", () => {
    const control = bothStreamsWorking();
    render(<LoopStreamCards loopControl={control} slotProgress={progressFor(control)} onStopSlot={vi.fn()} onAbortSlot={vi.fn()} />);

    expect(stream(2).getByRole("button", { name: "Stop stream (drain)" })).toBeEnabled();
    expect(stream(2).getByRole("button", { name: "Abort stream" })).toBeEnabled();
  });

  it("resumes exactly the stream whose button was pressed", () => {
    const control = loopControl({
      slots: [slot({ desired: "drain", state: "draining", taskId: "1233-a", attempt: 1 }), slot({ workerId: "w2", index: 2 })],
    });
    const onResumeSlot = vi.fn();
    render(<LoopStreamCards loopControl={control} slotProgress={progressFor(control)} onResumeSlot={onResumeSlot} />);

    fireEvent.click(stream(1).getByRole("button", { name: "Resume stream" }));

    expect(onResumeSlot).toHaveBeenCalledWith("w1");
  });

  it("requires a second, deliberate click before aborting a stream", () => {
    const control = loopControl();
    const onAbortSlot = vi.fn();
    render(<LoopStreamCards loopControl={control} slotProgress={progressFor(control)} onAbortSlot={onAbortSlot} />);

    fireEvent.click(stream(1).getByRole("button", { name: "Abort stream" }));
    expect(onAbortSlot).not.toHaveBeenCalled();

    fireEvent.click(stream(1).getByRole("button", { name: "Confirm abort" }));
    expect(onAbortSlot).toHaveBeenCalledWith("w1");
  });

  it("returns to the initial state when the abort is cancelled", () => {
    const control = loopControl();
    const onAbortSlot = vi.fn();
    render(<LoopStreamCards loopControl={control} slotProgress={progressFor(control)} onAbortSlot={onAbortSlot} />);

    fireEvent.click(stream(1).getByRole("button", { name: "Abort stream" }));
    fireEvent.click(stream(1).getByRole("button", { name: "Cancel" }));

    expect(onAbortSlot).not.toHaveBeenCalled();
    // Persigalvojimas yra pilnavertis kelias: mygtukas grįžta, o patvirtinimo nebelieka.
    expect(stream(1).getByRole("button", { name: "Abort stream" })).toBeInTheDocument();
    expect(stream(1).queryByRole("button", { name: "Confirm abort" })).toBeNull();
  });

  it("asks for confirmation only in the stream that was clicked", () => {
    const control = loopControl();
    render(<LoopStreamCards loopControl={control} slotProgress={progressFor(control)} onAbortSlot={vi.fn()} />);

    fireEvent.click(stream(1).getByRole("button", { name: "Abort stream" }));

    expect(stream(1).getByRole("button", { name: "Confirm abort" })).toBeInTheDocument();
    expect(stream(2).queryByRole("button", { name: "Confirm abort" })).toBeNull();
    expect(stream(2).getByRole("button", { name: "Abort stream" })).toBeInTheDocument();
  });

  // Task 1235: viso ciklo veiksmai turi VIENĄ šeimininką (`LoopControls`). Ši panelė valdo tik tai,
  // ką galima padaryti atskiram srautui.
  it("no longer owns the global loop actions", () => {
    const control = loopControl();
    render(<LoopStreamCards loopControl={control} slotProgress={progressFor(control)} />);

    expect(screen.queryByRole("button", { name: /Start loop|Stop loop/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Start with|Stop all streams/ })).toBeNull();
  });

  it("stays read-only without handlers instead of rendering dead buttons", () => {
    const control = loopControl();
    render(<LoopStreamCards loopControl={control} slotProgress={progressFor(control)} />);

    expect(stream(1).getByRole("button", { name: "Stop stream (drain)" })).toBeDisabled();
    expect(stream(1).getByRole("button", { name: "Resume stream" })).toBeDisabled();
    expect(stream(1).getByRole("button", { name: "Abort stream" })).toBeDisabled();
  });

  it("disables the action that would repeat the state the stream is already in", () => {
    const control = loopControl({
      slots: [
        slot({ desired: "drain", state: "draining", taskId: "1233-a", attempt: 1 }),
        slot({ workerId: "w2", index: 2, state: "running", taskId: "1233-antra", attempt: 1 }),
      ],
    });
    render(
      <LoopStreamCards
        loopControl={control}
        slotProgress={progressFor(control)}
        onStopSlot={vi.fn()}
        onResumeSlot={vi.fn()}
      />,
    );

    // Jau stabdomo srauto nebestabdome antrą kartą; grąžinti į darbą — galima.
    expect(stream(1).getByRole("button", { name: "Stop stream (drain)" })).toBeDisabled();
    expect(stream(1).getByRole("button", { name: "Resume stream" })).toBeEnabled();
    // Veikiančio srauto atnaujinti nėra ko.
    expect(stream(2).getByRole("button", { name: "Stop stream (drain)" })).toBeEnabled();
    expect(stream(2).getByRole("button", { name: "Resume stream" })).toBeDisabled();
  });

  it("separates an operator stop from a stream the wave never granted", () => {
    const control = loopControl({
      slots: [
        slot({ desired: "drain", state: "draining", taskId: "1233-a", attempt: 1 }),
        slot({
          workerId: "w2",
          index: 2,
          lastWave: { waveId: "w-1", granted: false, rejectedReason: "legacy-reads" },
        }),
      ],
    });
    render(<LoopStreamCards loopControl={control} slotProgress={progressFor(control)} onStopSlot={vi.fn()} />);

    expect(
      stream(1).getByText(
        "Stopped by the operator: the running attempt finishes and no new task is assigned to this stream.",
      ),
    ).toBeInTheDocument();
    expect(stream(2).getByText("This stream was not granted by the last wave: legacy-reads")).toBeInTheDocument();
    expect(
      stream(2).queryByText(
        "Stopped by the operator: the running attempt finishes and no new task is assigned to this stream.",
      ),
    ).toBeNull();
  });

  it("names the missing reason instead of leaving the wave note half-written", () => {
    const control = loopControl({
      slots: [slot({ lastWave: { waveId: "w-1", granted: false, rejectedReason: null } })],
    });
    render(<LoopStreamCards loopControl={control} slotProgress={progressFor(control)} />);

    expect(stream(1).getByText("This stream was not granted by the last wave: unknown")).toBeInTheDocument();
  });

  it("warns on Stream 1 that stopping it stops the whole loop, before it is stopped", () => {
    const note = "Stream 1 gates the whole loop: stopping it stops the loop process, not just this stream.";
    const control = loopControl();
    render(<LoopStreamCards loopControl={control} slotProgress={progressFor(control)} onStopSlot={vi.fn()} />);

    // Sakinio reikia PRIEŠ paspaudimą: po jo jis jau nieko nebeišgelbėtų.
    expect(stream(1).getByText(note)).toBeInTheDocument();
    expect(stream(2).queryByText(note)).toBeNull();
  });

  it("keeps the Stream 1 loop-gate warning next to the drain note it corrects", () => {
    const control = loopControl({
      slots: [slot({ desired: "drain", state: "draining", taskId: "1233-a", attempt: 1 })],
    });
    render(<LoopStreamCards loopControl={control} slotProgress={progressFor(control)} onResumeSlot={vi.fn()} />);

    expect(
      stream(1).getByText(
        "Stopped by the operator: the running attempt finishes and no new task is assigned to this stream.",
      ),
    ).toBeInTheDocument();
    expect(
      stream(1).getByText(
        "Stream 1 gates the whole loop: stopping it stops the loop process, not just this stream.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the panel-level warnings and the abort limitation visible", () => {
    const control = loopControl({ invalid: "unreadable", stopRequested: true });
    render(<LoopStreamCards loopControl={control} slotProgress={progressFor(control)} />);

    expect(screen.getByText(/The loop control file is unreadable; every stream defaults to run\./)).toBeInTheDocument();
    // „Prašoma sustabdyti" nuo task 1235 stovi šalia paties stabdymo mygtuko (`LoopControls`).
    expect(screen.queryByText(/Stop requested/)).toBeNull();
    expect(
      screen.getByText(
        "Abort does not stop a running attempt — it finishes exactly as with drain, and only the reported state differs. A real force-abort is not implemented.",
      ),
    ).toBeInTheDocument();
  });

  it("falls back to the plain card for a stream the progress view does not cover", () => {
    const control = bothStreamsWorking();
    // Serveris atsiuntė tik vieno srauto progresą: antras srautas privalo likti valdomas.
    const partial = progressFor(control).filter((view) => view.workerId === "w1");
    const onStopSlot = vi.fn();
    render(<LoopStreamCards loopControl={control} slotProgress={partial} onStopSlot={onStopSlot} />);

    expect(stream(1).getByText("Elapsed")).toBeInTheDocument();
    expect(stream(2).queryByText("Elapsed")).toBeNull();
    fireEvent.click(stream(2).getByRole("button", { name: "Stop stream (drain)" }));
    expect(onStopSlot).toHaveBeenCalledWith("w2");
  });
});

// Užstrigusios užduoties grąžinimas į eilę tiesiai iš srauto kortelės (task 1235).
describe("LoopStreamCards fix action", () => {
  it("offers the fix only for a task the server would really accept", () => {
    const control = loopControl();
    const onFixTask = vi.fn();
    render(
      <LoopStreamCards
        loopControl={control}
        slotProgress={progressFor(control)}
        fixableTaskIds={new Set(["1233-loop-streams"])}
        onFixTask={onFixTask}
      />,
    );

    fireEvent.click(stream(1).getByRole("button", { name: "Fix (requeue)" }));
    expect(onFixTask).toHaveBeenCalledOnce();
    expect(onFixTask).toHaveBeenCalledWith("1233-loop-streams");
  });

  it("renders nothing at all when the task is not in human-review", () => {
    // Išjungtas mygtukas be paaiškinimo yra klausimas be atsakymo, o vienintelė tokio paspaudimo
    // baigtis būtų 409 — todėl jo tiesiog nėra.
    const control = loopControl();
    render(
      <LoopStreamCards
        loopControl={control}
        slotProgress={progressFor(control)}
        fixableTaskIds={new Set(["some-other-task"])}
        onFixTask={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Fix (requeue)" })).toBeNull();
  });

  it("renders nothing for a stream without a task", () => {
    const control = loopControl();
    render(
      <LoopStreamCards
        loopControl={control}
        slotProgress={progressFor(control)}
        fixableTaskIds={new Set(["1233-loop-streams"])}
        onFixTask={vi.fn()}
      />,
    );

    expect(stream(2).queryByRole("button", { name: "Fix (requeue)" })).toBeNull();
  });

  it("marks the running action and leaves the other stream alone", () => {
    const control = bothStreamsWorking();
    render(
      <LoopStreamCards
        loopControl={control}
        slotProgress={progressFor(control)}
        fixableTaskIds={new Set(["1233-loop-streams"])}
        onFixTask={vi.fn()}
        onStopSlot={vi.fn()}
        pendingActions={new Set(["fix-1233-loop-streams", "slot-w1-drain"])}
      />,
    );

    const fix = stream(1).getByRole("button", { name: "Fix (requeue)" });
    expect(fix).toHaveAttribute("aria-busy", "true");
    expect(fix).toBeDisabled();
    expect(stream(1).getByRole("button", { name: "Stop stream (drain)" })).toBeDisabled();
    // Vieno srauto veiksmas negali užrakinti kito srauto: tai atskiri slot'ai ir atskiros užklausos.
    expect(stream(2).getByRole("button", { name: "Stop stream (drain)" })).toBeEnabled();
  });
});

// Be `slotProgress` kortelė privalo likti tiksliai tokia, kokia buvo: naujas blokas yra PAPILDOMAS.
describe("LoopStreamCards without slot progress", () => {
  it("keeps the same controls and the same sentences", () => {
    const control = loopControl();
    const onAbortSlot = vi.fn();
    render(<LoopStreamCards loopControl={control} onAbortSlot={onAbortSlot} />);

    expect(stream(1).getByText("Task 1233-loop-streams, attempt 2")).toBeInTheDocument();
    expect(stream(1).getByText("Running")).toBeInTheDocument();
    expect(stream(1).queryByText("Elapsed")).toBeNull();
    expect(
      stream(1).getByText(
        "Stream 1 gates the whole loop: stopping it stops the loop process, not just this stream.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(stream(1).getByRole("button", { name: "Abort stream" }));
    fireEvent.click(stream(1).getByRole("button", { name: "Confirm abort" }));
    expect(onAbortSlot).toHaveBeenCalledWith("w1");
  });
});
