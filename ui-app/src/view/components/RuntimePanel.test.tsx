import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  LoopControlView,
  LoopSlotView,
  RuntimeProcessView,
  WorkerControlView,
} from "../../model/dashboardViewModel";
import { RuntimePanel } from "./RuntimePanel";

const processes: RuntimeProcessView[] = [
  { name: "AG UI", status: "running", detail: "pid 10", variant: "good" },
  { name: "AG loop", status: "stopped", detail: "pid 20", variant: "neutral" },
  { name: "User Claude terminal", status: "unknown", detail: "PID not recorded", variant: "warning" },
];

describe("RuntimePanel", () => {
  it("summarizes runtime health and exposes contextual recovery actions", () => {
    const onStartLoop = vi.fn();
    const onRefresh = vi.fn();

    render(
      <RuntimePanel
        processes={processes}
        root="D:/project"
        onStartLoop={onStartLoop}
        onRefresh={onRefresh}
        loopRunState="stopped"
      />,
    );

    // Antraštė įvardija tai, ką `overall` PATIKRINO (UI procesą ir būsenų žinomumą), o ne
    // „sistemą": „Sistema veikia" šalia „Ciklas: sustabdytas" ir „1 / 3" skaitėsi kaip
    // prieštaravimas, nors abu teiginiai teisingi.
    expect(screen.getByRole("heading", { name: "Runtime state is incomplete" })).toBeInTheDocument();
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    expect(screen.getByText("D:/project")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start loop" }));
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    // Signalo kortelė paleidžia TĄ PATĮ veiksmą kaip ciklo valdymo juosta, tad ir srautų skaičių ji
    // paduoda tokį pat: be `workerControl` prašomas vienas srautas.
    expect(onStartLoop).toHaveBeenCalledWith(1);
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  // Task 1235: ciklo valdymas yra PAPILDOMAS blokas — be abiejų duomenų šaltinių jo nėra.
  it("omits the loop controls when the server reports neither the loop nor the worker state", () => {
    render(<RuntimePanel processes={processes} root="D:/project" />);

    expect(screen.queryByRole("heading", { name: "Loop controls" })).not.toBeInTheDocument();
  });

  it("shows the loop controls when either source is reported", () => {
    const { unmount } = render(
      <RuntimePanel processes={processes} root="D:/project" workerControl={workerControl()} />,
    );
    expect(screen.getByRole("heading", { name: "Loop controls" })).toBeInTheDocument();
    unmount();

    render(<RuntimePanel processes={processes} root="D:/project" loopControl={loopControl()} />);
    expect(screen.getByRole("heading", { name: "Loop controls" })).toBeInTheDocument();
  });

  it("starts the loop with the requested number of streams from the idle signal", () => {
    const onStartLoop = vi.fn();
    render(
      <RuntimePanel
        processes={processes}
        root="D:/project"
        workerControl={workerControl({ requested: 2 })}
        onStartLoop={onStartLoop}
        loopRunState="stopped"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start loop" }));

    expect(onStartLoop).toHaveBeenCalledWith(2);
  });

  /**
   * 1235 review radinys: „Automatika laukia" kortelė ir ciklo valdymo juosta atsakinėjo į tą patį
   * klausimą iš dviejų skirtingų šaltinių, tad serveriui nesiunčiant `loopControl` bloko (senas
   * `dist`) tame pačiame ekrane stovėdavo AKTYVUS ir IŠJUNGTAS „Paleisti". Nuo šiol abu maitina
   * viena `loopRunState` reikšmė.
   */
  it("gives both start buttons the same answer when the loop state is not confirmed", () => {
    render(
      <RuntimePanel
        processes={processes}
        root="D:/project"
        workerControl={workerControl()}
        onStartLoop={vi.fn()}
        onStopLoop={vi.fn()}
      />,
    );

    // Nė vienos `loopRunState` reikšmės: numatytoji nežinomybė uždaro paleidimą ABIEJOSE vietose.
    expect(screen.getByRole("button", { name: "Start loop" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start loop (1 stream(s))" })).toBeDisabled();
    // Stabdymas nežinomoje būsenoje lieka — stop vėliava nekenksminga.
    expect(screen.getByRole("button", { name: "Stop loop" })).toBeEnabled();
  });

  it("ignores the loop control block's own status and follows the controller's state", () => {
    const onStartLoop = vi.fn();

    render(
      <RuntimePanel
        processes={processes}
        root="D:/project"
        // Valdymo failo serveris nesiuntė (`known: false` → `unknown`), bet vykdymo procesai sako
        // „sustojęs": vienintelis atsakymas ateina iš kontrolerio, ir jį gauna abu mygtukai.
        loopControl={loopControl({ known: false, loopStatus: "unknown" })}
        loopRunState="stopped"
        onStartLoop={onStartLoop}
      />,
    );

    const idleStart = screen.getByRole("button", { name: "Start loop" });
    const controlsStart = screen.getByRole("button", { name: "Start loop (1 stream(s))" });
    expect(idleStart).toBeEnabled();
    expect(controlsStart).toBeEnabled();

    fireEvent.click(idleStart);
    fireEvent.click(controlsStart);
    // Tas pats ketinimas su tuo pačiu srautų skaičiumi, iš kurio taško bebūtų paleistas.
    expect(onStartLoop).toHaveBeenNthCalledWith(1, 1);
    expect(onStartLoop).toHaveBeenNthCalledWith(2, 1);
  });

  // Panelė be `workerControl` privalo likti tokia, kokia buvo (testas aukščiau jos nepaduoda):
  // valdiklis yra PAPILDOMAS blokas, o ne nauja panelės prielaida.
  it("omits the worker-slot control when the server does not report it", () => {
    render(<RuntimePanel processes={processes} root="D:/project" />);

    expect(screen.queryByRole("heading", { name: "Worker slots" })).not.toBeInTheDocument();
  });

  // Ta pati taisyklė srautams (task 0052): naujas blokas yra PAPILDOMAS, o ne nauja prielaida.
  it("omits the loop-stream controls when the server does not report them", () => {
    render(<RuntimePanel processes={processes} root="D:/project" />);

    expect(screen.queryByRole("heading", { name: "Loop streams" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abort stream" })).not.toBeInTheDocument();
  });
});

// Worker slot'ų valdiklis (task 0051).
function workerControl(overrides: Partial<WorkerControlView> = {}): WorkerControlView {
  return {
    requested: 1,
    source: "state",
    canEdit: true,
    lastWaveKnown: false,
    granted: 0,
    grantedOf: 1,
    max: 0,
    rejected: [],
    ...overrides,
  };
}

describe("RuntimePanel worker slots", () => {
  it("shows the current request and reports a click as a new request", () => {
    const onSetWorkers = vi.fn();

    render(
      <RuntimePanel
        processes={processes}
        root="D:/project"
        workerControl={workerControl({ requested: 1 })}
        onSetWorkers={onSetWorkers}
      />,
    );

    expect(screen.getByRole("heading", { name: "Worker slots" })).toBeInTheDocument();
    // W1 yra bazinis srautas — „paspaustas" visada; W2 perjungiklis rodo, kad antras srautas nepra­šytas.
    expect(screen.getByRole("button", { name: "W1" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "W2" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "W2" }));
    expect(onSetWorkers).toHaveBeenCalledWith(2);

    // Sakinys „prašymas ≠ leidimas" yra pati valdiklio esmė: be jo operatorius manytų, kad
    // paspaudęs „2" gavo du workerius.
    expect(
      screen.getByText(
        "Requesting 2 workers does not grant them — every wave re-checks isolation and may reject the second slot.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("No wave has planned a worker pool yet.")).toBeInTheDocument();
  });

  it("disables the buttons when the environment owns the value", () => {
    const onSetWorkers = vi.fn();

    render(
      <RuntimePanel
        processes={processes}
        root="D:/project"
        workerControl={workerControl({ requested: 2, source: "env", canEdit: false })}
        onSetWorkers={onSetWorkers}
      />,
    );

    expect(screen.getByRole("button", { name: "W1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "W2" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "W1" }));
    expect(onSetWorkers).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Controlled by the AG_MAX_WORKERS environment variable in this UI process; the on-screen control is disabled.",
      ),
    ).toBeInTheDocument();
  });

  it("stays read-only without a handler instead of rendering dead buttons", () => {
    render(<RuntimePanel processes={processes} root="D:/project" workerControl={workerControl()} />);

    expect(screen.getByRole("button", { name: "W1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "W2" })).toBeDisabled();
  });

  // Task 1235: valdiklis persikėlė ten, kur priimami ciklo sprendimai, o „Workerių slot'ai" liko
  // BANGOS rezultato ataskaita. Du valdikliai tam pačiam prašymui reikštų du šeimininkus.
  it("keeps the request control in the loop controls and the wave result in the worker slots", () => {
    render(
      <RuntimePanel
        processes={processes}
        root="D:/project"
        workerControl={workerControl({ requested: 2, lastWaveKnown: true, granted: 1, grantedOf: 2, max: 2 })}
        onSetWorkers={vi.fn()}
      />,
    );

    const loopControls = within(screen.getByRole("region", { name: "Loop controls" }));
    const workerSlots = within(screen.getByRole("region", { name: "Worker slots" }));

    expect(loopControls.getByRole("button", { name: "W2" })).toHaveAttribute("aria-pressed", "true");
    expect(workerSlots.queryByRole("button", { name: "W2" })).toBeNull();
    expect(workerSlots.getByText("What the last wave actually granted, and why any slot was rejected.")).toBeInTheDocument();
    expect(workerSlots.getByText("Last wave: granted 1 of 2 requested (limit 2).")).toBeInTheDocument();
  });

  it("explains the last wave result and every rejected slot", () => {
    render(
      <RuntimePanel
        processes={processes}
        root="D:/project"
        workerControl={workerControl({
          requested: 2,
          lastWaveKnown: true,
          granted: 1,
          grantedOf: 2,
          max: 2,
          rejected: [{ taskId: "0502-beta", reason: "legacy-reads", detail: "stop-status read by verify-task" }],
        })}
        onSetWorkers={vi.fn()}
      />,
    );

    expect(screen.getByText("Last wave: granted 1 of 2 requested (limit 2).")).toBeInTheDocument();
    expect(screen.getByText("0502-beta")).toBeInTheDocument();
    // Kodas IR detalė: kodas yra ieškomas log'e, o detalė pasako, kuris būtent įrodymas trūko.
    expect(screen.getByText(/legacy-reads/)).toBeInTheDocument();
    expect(screen.getByText(/stop-status read by verify-task/)).toBeInTheDocument();
  });

  it("warns that an unusable request file left the loop on one worker", () => {
    render(
      <RuntimePanel
        processes={processes}
        root="D:/project"
        workerControl={workerControl({ invalid: "malformed" })}
        onSetWorkers={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/The worker request file is unreadable; the loop is using 1 worker\./),
    ).toBeInTheDocument();
  });
});

// Srautų gyvavimo ciklas (task 0052).
function loopSlot(overrides: Partial<LoopSlotView> = {}): LoopSlotView {
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

function loopControl(overrides: Partial<LoopControlView> = {}): LoopControlView {
  return {
    known: true,
    loopStatus: "running",
    stopRequested: false,
    slots: [
      loopSlot({ state: "running", taskId: "0052-loop-streams", attempt: 2 }),
      loopSlot({ workerId: "w2", index: 2 }),
    ],
    ...overrides,
  };
}

function stream(index: number) {
  return within(screen.getByRole("article", { name: `Stream ${index}` }));
}

describe("RuntimePanel loop streams", () => {
  it("shows what each stream is actually doing, not what was requested", () => {
    render(
      <RuntimePanel
        processes={processes}
        root="D:/project"
        loopControl={loopControl()}
        onStopSlot={vi.fn()}
        onResumeSlot={vi.fn()}
        onAbortSlot={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Loop streams" })).toBeInTheDocument();
    expect(stream(1).getByText("Task 0052-loop-streams, attempt 2")).toBeInTheDocument();
    expect(stream(1).getByText("Running")).toBeInTheDocument();
    // Antras srautas neturi task'o: „laukia" ir „dirba" negali atrodyti vienodai.
    expect(stream(2).getByText("No task assigned")).toBeInTheDocument();
    expect(stream(2).getByText("Idle")).toBeInTheDocument();
  });

  it("stops and restarts the loop through the loop controls, not through the stream cards", () => {
    const onStopLoop = vi.fn();
    const onRestartLoop = vi.fn();

    render(
      <RuntimePanel
        processes={processes}
        root="D:/project"
        loopControl={loopControl()}
        workerControl={workerControl({ requested: 2 })}
        loopRunState="running"
        onStopLoop={onStopLoop}
        onRestartLoop={onRestartLoop}
      />,
    );

    const streams = within(screen.getByRole("region", { name: "Loop streams" }));
    expect(streams.queryByRole("button", { name: /Stop loop|Restart loop/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Stop loop" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart loop" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm restart" }));

    expect(onStopLoop).toHaveBeenCalledOnce();
    expect(onRestartLoop).toHaveBeenCalledWith(2);
  });

  it("drains exactly the stream whose button was pressed", () => {
    const onStopSlot = vi.fn();
    // ABU srautai su darbu: nuo 2026-08-24 tuščio srauto stabdymas išjungtas, tad numatytasis
    // fixture (tuščias `w2`) tikrintų išjungtą mygtuką, o ne per-srautinį taikymą.
    const control = loopControl({
      slots: [
        loopSlot({ state: "running", taskId: "0052-loop-streams", attempt: 2 }),
        loopSlot({ workerId: "w2", index: 2, state: "running", taskId: "0052-antra", attempt: 1 }),
      ],
    });

    render(<RuntimePanel processes={processes} root="D:/project" loopControl={control} onStopSlot={onStopSlot} />);

    fireEvent.click(stream(2).getByRole("button", { name: "Stop stream (drain)" }));

    expect(onStopSlot).toHaveBeenCalledWith("w2");
  });

  it("requires a second, deliberate click before aborting a stream", () => {
    const onAbortSlot = vi.fn();

    render(
      <RuntimePanel processes={processes} root="D:/project" loopControl={loopControl()} onAbortSlot={onAbortSlot} />,
    );

    fireEvent.click(stream(1).getByRole("button", { name: "Abort stream" }));
    expect(onAbortSlot).not.toHaveBeenCalled();

    // Persigalvojimas privalo būti pilnavertis kelias, o ne dar vienas paspaudimas iki abort'o.
    fireEvent.click(stream(1).getByRole("button", { name: "Cancel" }));
    expect(onAbortSlot).not.toHaveBeenCalled();

    fireEvent.click(stream(1).getByRole("button", { name: "Abort stream" }));
    fireEvent.click(stream(1).getByRole("button", { name: "Confirm abort" }));
    expect(onAbortSlot).toHaveBeenCalledWith("w1");

    // Sakinys apie abort'ą įvardija tikrąją ribą: vykdomas bandymas NĖRA stabdomas, o nuo `drain`
    // skiriasi tik rodoma būsena. Bet koks „nutrauks" pažadas čia būtų melas.
    expect(
      screen.getByText(
        "Abort does not stop a running attempt — it finishes exactly as with drain, and only the reported state differs. A real force-abort is not implemented.",
      ),
    ).toBeInTheDocument();
  });

  // Srautai atrodo simetriški, bet 1-as srautas valdo visą ciklą — tai vienintelis dalykas, kurio
  // operatorius kortelėje nemato, todėl sakinys tikrinamas ABIEJOSE būsenose (prieš ir po stabdymo).
  it("warns only on Stream 1 that stopping it stops the whole loop", () => {
    const note = "Stream 1 gates the whole loop: stopping it stops the loop process, not just this stream.";

    render(
      <RuntimePanel processes={processes} root="D:/project" loopControl={loopControl()} onStopSlot={vi.fn()} />,
    );

    expect(stream(1).getByText(note)).toBeInTheDocument();
    expect(stream(2).queryByText(note)).not.toBeInTheDocument();
  });

  it("keeps the Stream 1 loop-gate warning next to the drain note it corrects", () => {
    render(
      <RuntimePanel
        processes={processes}
        root="D:/project"
        loopControl={loopControl({
          slots: [loopSlot({ desired: "drain", state: "draining", taskId: "0052-a", attempt: 1 })],
        })}
        onResumeSlot={vi.fn()}
      />,
    );

    // „Šiam srautui" viena pati meluoja: sustabdžius `w1` naujų užduočių nebegauna NĖ VIENAS srautas.
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

  it("separates an operator stop from a stream the wave never granted", () => {
    render(
      <RuntimePanel
        processes={processes}
        root="D:/project"
        loopControl={loopControl({
          slots: [
            loopSlot({ desired: "drain", state: "draining", taskId: "0052-a", attempt: 1 }),
            loopSlot({
              workerId: "w2",
              index: 2,
              lastWave: { waveId: "w-1", granted: false, rejectedReason: "legacy-reads" },
            }),
          ],
        })}
        onStopSlot={vi.fn()}
      />,
    );

    expect(
      stream(1).getByText(
        "Stopped by the operator: the running attempt finishes and no new task is assigned to this stream.",
      ),
    ).toBeInTheDocument();
    expect(stream(1).getByText("Draining")).toBeInTheDocument();
    // Antras srautas taip pat nieko nedirba, bet dėl visai kitos priežasties — ir ji įvardijama.
    expect(stream(2).getByText("This stream was not granted by the last wave: legacy-reads")).toBeInTheDocument();
    expect(
      stream(2).queryByText(
        "Stopped by the operator: the running attempt finishes and no new task is assigned to this stream.",
      ),
    ).not.toBeInTheDocument();
    // Jau stabdomo srauto nebestabdome antrą kartą; grąžinti į darbą — galima.
    expect(stream(1).getByRole("button", { name: "Stop stream (drain)" })).toBeDisabled();
  });

  it("stays read-only without handlers instead of rendering dead buttons", () => {
    render(<RuntimePanel processes={processes} root="D:/project" loopControl={loopControl()} />);

    expect(screen.getByRole("button", { name: "Start loop (1 stream(s))" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop loop" })).toBeDisabled();
    expect(stream(1).getByRole("button", { name: "Stop stream (drain)" })).toBeDisabled();
    expect(stream(1).getByRole("button", { name: "Abort stream" })).toBeDisabled();
  });

  it("explains why every stream is running when the control file cannot be used", () => {
    render(
      <RuntimePanel
        processes={processes}
        root="D:/project"
        loopControl={loopControl({ invalid: "unreadable", stopRequested: true })}
        onStopSlot={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/The loop control file is unreadable; every stream defaults to run\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/Stop requested/)).toBeInTheDocument();
  });
});
