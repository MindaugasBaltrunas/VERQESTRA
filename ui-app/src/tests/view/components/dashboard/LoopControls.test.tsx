import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkerControlView } from "../../../../model/dashboardViewModel";
import { LoopControls } from "../../../../view/components/dashboard/LoopControls";

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

describe("LoopControls", () => {
  it("starts exactly as many streams as are requested", () => {
    const onStartLoop = vi.fn();
    render(
      <LoopControls
        loopStatus="stopped"
        workerControl={workerControl({ requested: 2 })}
        onStartLoop={onStartLoop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start loop (2 stream(s))" }));

    expect(onStartLoop).toHaveBeenCalledWith(2);
  });

  // 2026-08-06 incidentas: nepatvirtinta būsena buvo laikoma „sustojusia", ir UI siūlė paleisti
  // ANTRĄ orkestratorių. Sakinys ekrane privalo pasakyti ir kodėl paleisti negalima, ir kad stabdyti — galima.
  it("blocks starting while the loop state is unconfirmed, but keeps stopping available", () => {
    render(
      <LoopControls loopStatus="unknown" onStartLoop={vi.fn()} onStopLoop={vi.fn()} onRestartLoop={vi.fn()} />,
    );

    const start = screen.getByRole("button", { name: "Start loop (1 stream(s))" });
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute("title", "Starting is blocked while the loop state is unconfirmed.");
    expect(screen.getByRole("button", { name: "Stop loop" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Restart loop" })).toBeDisabled();
    expect(
      screen.getByText(
        "The loop process state is not confirmed. Starting is blocked so a second orchestrator cannot be launched; stopping stays available.",
      ),
    ).toBeInTheDocument();
  });

  // Task 059-d: kiekvienas išjungtas ciklo mygtukas paaiškina priežastį per `title`, o „Stabdyti"
  // pasekmė (drain semantika) matoma visada, ne tik `hover` metu.
  it("explains each button's disabled reason and always shows the stop button's consequence", () => {
    render(
      <LoopControls
        loopStatus="stopped"
        onStartLoop={vi.fn()}
        onStopLoop={vi.fn()}
        onRestartLoop={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Start loop (1 stream(s))" })).toBeEnabled();
    const stop = screen.getByRole("button", { name: "Stop loop" });
    expect(stop).toBeDisabled();
    expect(stop).toHaveAttribute("title", "The loop is already stopped.");
    const restart = screen.getByRole("button", { name: "Restart loop" });
    expect(restart).toBeDisabled();
    expect(restart).toHaveAttribute("title", "Restart requires the loop to be running.");

    // Pasekmės sakinys šalia „Stabdyti" — VISADA, nepriklausomai nuo to, ar mygtukas šiuo metu aktyvus.
    expect(
      screen.getByText(
        "Stopping does not force-kill the loop — the running task finishes first, then the loop stops.",
      ),
    ).toBeInTheDocument();
  });

  it("explains that starting is blocked because the loop is already running", () => {
    render(<LoopControls loopStatus="running" onStartLoop={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Start loop (1 stream(s))" })).toHaveAttribute(
      "title",
      "The loop is already running.",
    );
  });

  it("requires a second, deliberate click before restarting a running loop", () => {
    const onRestartLoop = vi.fn();
    render(
      <LoopControls
        loopStatus="running"
        workerControl={workerControl({ requested: 2 })}
        onStartLoop={vi.fn()}
        onStopLoop={vi.fn()}
        onRestartLoop={onRestartLoop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Restart loop" }));
    expect(onRestartLoop).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onRestartLoop).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Restart loop" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Restart loop" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm restart" }));
    expect(onRestartLoop).toHaveBeenCalledWith(2);
  });

  it("marks the action that is running and locks the other two", () => {
    render(
      <LoopControls
        loopStatus="running"
        pendingActions={new Set(["loop-stop"])}
        onStartLoop={vi.fn()}
        onStopLoop={vi.fn()}
        onRestartLoop={vi.fn()}
      />,
    );

    const stop = screen.getByRole("button", { name: "Stop loop" });
    expect(stop).toHaveAttribute("aria-busy", "true");
    expect(stop).toBeDisabled();
    // Vykdomas veiksmas irgi paaiškinamas: „busy" jį rodo vizualiai, o `title` — pagalbinėms
    // technologijoms ir pelės hover'ui.
    const pendingReason = "A loop action is currently in progress; wait for it to finish.";
    expect(stop).toHaveAttribute("title", pendingReason);
    const start = screen.getByRole("button", { name: "Start loop (1 stream(s))" });
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute("title", pendingReason);
    const restart = screen.getByRole("button", { name: "Restart loop" });
    expect(restart).toBeDisabled();
    expect(restart).toHaveAttribute("title", pendingReason);
  });

  it("reports a worker click as a new request", () => {
    const onSetWorkers = vi.fn();
    render(<LoopControls loopStatus="running" workerControl={workerControl()} onSetWorkers={onSetWorkers} />);

    // W1 — bazinis srautas, visada „paspaustas"; W2 — perjungiklis antram srautui.
    expect(screen.getByRole("button", { name: "W1" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "W2" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "W2" }));
    expect(onSetWorkers).toHaveBeenCalledWith(2);

    // Sakinys „prašymas ≠ leidimas" keliauja kartu su valdikliu, kurį jis paaiškina.
    expect(
      screen.getByText(
        "Requesting 2 workers does not grant them — every wave re-checks isolation and may reject the second slot.",
      ),
    ).toBeInTheDocument();
  });

  it("marks W2 unavailable (not disabled-as-selected) when the environment caps the loop at one worker", () => {
    const onSetWorkers = vi.fn();
    render(
      <LoopControls
        loopStatus="running"
        workerControl={workerControl({ requested: 1, max: 1 })}
        onSetWorkers={onSetWorkers}
      />,
    );

    const w1 = screen.getByRole("button", { name: "W1" });
    const w2 = screen.getByRole("button", { name: "W2" });

    // W1 lieka realiai paspaudžiamas net kai jis jau yra pasirinkimas — pažymėjimas yra būsena,
    // ne priežastis išjungti.
    expect(w1).toBeEnabled();
    expect(w1).toHaveAttribute("aria-pressed", "true");
    expect(w1).toHaveAttribute(
      "title",
      "The base stream — always on while the loop runs. Click to keep only W1.",
    );

    expect(w2).toBeDisabled();
    expect(w2).toHaveAttribute(
      "title",
      "This worker count is unavailable: the environment limits this loop to 1 worker(s).",
    );

    fireEvent.click(w2);
    expect(onSetWorkers).not.toHaveBeenCalled();
  });

  it("disables the worker control when the environment owns the value", () => {
    const onSetWorkers = vi.fn();
    render(
      <LoopControls
        loopStatus="running"
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

  it("hides the worker block when the server does not report it, without losing the loop actions", () => {
    render(<LoopControls loopStatus="running" onStartLoop={vi.fn()} onStopLoop={vi.fn()} onRestartLoop={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "W1" })).toBeNull();
    expect(screen.queryByRole("button", { name: "W2" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start loop (1 stream(s))" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop loop" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart loop" })).toBeInTheDocument();
  });

  it("shows the stop request without turning the stop button off", () => {
    // Stabdymas yra idempotentiškas: pakartotinis prašymas nekenkia, tad vėliava tik informuoja.
    render(<LoopControls loopStatus="running" stopRequested onStopLoop={vi.fn()} />);

    expect(screen.getByText(/Stop requested/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop loop" })).toBeEnabled();
  });
});
