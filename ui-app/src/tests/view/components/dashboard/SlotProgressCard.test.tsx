import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SlotProgressView } from "../../../../model/slotProgressViewModel";
import { SlotProgressCard } from "../../../../view/components/dashboard/SlotProgressCard";

function view(overrides: Partial<SlotProgressView> = {}): SlotProgressView {
  return {
    workerId: "w1",
    index: 1,
    taskId: "1233-frontend",
    attempt: 2,
    desired: "run",
    state: "running",
    phase: "implementation",
    phaseDetail: "coder",
    elapsedMs: 295_000,
    progress: { signal: "chain", percent: 43, level: "normal", done: 3, total: 7 },
    eta: { state: "available", lowMs: 240_000, highMs: 420_000, confidence: "medium" },
    worktree: "yes",
    lease: { known: true, status: "held", stale: false, heartbeatAgeMs: 5_000, mismatchedTask: false },
    lastError: null,
    blocked: null,
    liveness: "attached",
    chain: { agents: ["coder", "reviewer"], statuses: { coder: "active", reviewer: "pending" }, currentAgent: "coder" },
    ...overrides,
  };
}

function card() {
  return within(screen.getByRole("article", { name: "Stream 1" }));
}

describe("SlotProgressCard", () => {
  it("shows what the stream is working on, how far it got and how long it took", () => {
    render(<SlotProgressCard view={view()} variant="full" />);

    expect(card().getByText("Task 1233-frontend, attempt 2")).toBeInTheDocument();
    expect(card().getByText(/^Implementation/)).toBeInTheDocument();
    expect(card().getByText("Elapsed")).toBeInTheDocument();
    expect(card().getByText("4m 55s")).toBeInTheDocument();
    expect(card().getByText("3 of 7 agents")).toBeInTheDocument();
    expect(card().getByRole("progressbar")).toHaveAttribute("aria-valuenow", "43");
  });

  it("prints the agent name verbatim, because it is an identifier and not a sentence", () => {
    render(<SlotProgressCard view={view({ phase: "unknown", phaseDetail: "brand-new-agent" })} variant="full" />);

    expect(card().getByText("brand-new-agent")).toBeInTheDocument();
    expect(card().getByText(/^Phase unknown/)).toBeInTheDocument();
  });

  it("says a stream has no task instead of showing an empty attempt line", () => {
    render(<SlotProgressCard view={view({ taskId: null, attempt: null })} variant="full" />);

    expect(card().getByText("No task assigned")).toBeInTheDocument();
  });

  it("admits that progress is not available instead of drawing an empty bar", () => {
    render(<SlotProgressCard view={view({ progress: { signal: "none" } })} variant="full" />);

    expect(card().getByText("Progress not available")).toBeInTheDocument();
    expect(card().queryByRole("progressbar")).toBeNull();
  });

  it("writes out an unknown progress instead of leaving a bar that looks finished", () => {
    render(<SlotProgressCard view={view({ progress: { signal: "indeterminate" } })} variant="full" />);

    // Sustabdžius animaciją judesys nieko nebepasako, todėl tekstas privalo būti ir be jo.
    expect(card().getByText("Progress unknown")).toBeInTheDocument();
    expect(card().getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  });

  it("shows the forecast range with its confidence when ETA data is available", () => {
    render(<SlotProgressCard view={view()} variant="full" />);
    expect(card().getByText(/4–7m/)).toBeInTheDocument();
    expect(card().getByText("Estimate confidence: medium")).toBeInTheDocument();
  });

  it("stays quiet about a forecast it does not have, instead of drawing a dead placeholder", () => {
    render(
      <SlotProgressCard
        view={view({ eta: { state: "unavailable", reason: "not-enough-data" } })}
        variant="full"
      />,
    );
    expect(card().queryByText("ETA: not enough data")).toBeNull();
  });

  it("reports the worktree and the heartbeat of a known lease", () => {
    render(
      <SlotProgressCard
        view={view({ worktree: "no", lease: { known: true, status: "held", stale: true, heartbeatAgeMs: 90_000, mismatchedTask: false } })}
        variant="full"
      />,
    );

    expect(card().getByText("Worktree")).toBeInTheDocument();
    expect(card().getByText("No")).toBeInTheDocument();
    expect(card().getByText(/1m ⚠ Stale lease/)).toBeInTheDocument();
  });

  it("calls an unknown worktree unknown rather than assuming there is none", () => {
    render(<SlotProgressCard view={view({ worktree: "unknown" })} variant="full" />);

    expect(card().getByText("unknown")).toBeInTheDocument();
  });

  it("warns when the lease carries another task, so the timer cannot be trusted", () => {
    render(
      <SlotProgressCard
        view={view({ lease: { known: true, status: "held", stale: false, heartbeatAgeMs: 5_000, mismatchedTask: true } })}
        variant="full"
      />,
    );

    expect(card().getByText(/Lease belongs to another task/)).toBeInTheDocument();
  });

  it("shows the last failure with its timestamp and task in the tooltip", () => {
    render(
      <SlotProgressCard
        view={view({ lastError: { ts: "2026-08-15T05:59:00.000Z", taskId: "1230-old", reason: "exit 75" } })}
        variant="full"
      />,
    );

    expect(card().getByText("Last error")).toBeInTheDocument();
    expect(card().getByText("exit 75")).toHaveAttribute("title", "2026-08-15T05:59:00.000Z — 1230-old");
  });

  it("explains a blocked stream with the wave reason and its detail", () => {
    render(<SlotProgressCard view={view({ blocked: { reason: "hard-cap", detail: "hard_capped=2" } })} variant="full" />);

    expect(card().getByText(/Blocked: hard-cap — hard_capped=2/)).toBeInTheDocument();
  });

  it("says the stream is unknown only when the live activity cannot be attributed", () => {
    const attached = render(<SlotProgressCard view={view({ liveness: "attached" })} variant="full" />);
    expect(card().queryByText("Stream unknown")).toBeNull();
    attached.unmount();

    // Sustabdytame cikle sieti nėra ko, tad tyla ten yra teisingas atsakymas.
    const offline = render(<SlotProgressCard view={view({ liveness: "offline" })} variant="full" />);
    expect(card().queryByText("Stream unknown")).toBeNull();
    offline.unmount();

    const detached = render(<SlotProgressCard view={view({ liveness: "detached" })} variant="full" />);
    expect(card().getByText("Stream unknown")).toHaveAttribute("title", "Live stream cannot be matched to a slot");
    detached.unmount();

    render(<SlotProgressCard view={view({ liveness: "ambiguous" })} variant="full" />);
    expect(card().getByText("Stream unknown")).toHaveAttribute(
      "title",
      "Live activity matches more than one stream",
    );
  });

  it("renders the controls it is given without owning them", () => {
    render(
      <SlotProgressCard view={view()} variant="full">
        <button type="button">Stop stream (drain)</button>
      </SlotProgressCard>,
    );

    expect(card().getByRole("button", { name: "Stop stream (drain)" })).toBeInTheDocument();
  });
});

describe("SlotProgressCard compact variant", () => {
  it("summarizes the stream without becoming a second control surface", () => {
    render(
      <SlotProgressCard view={view()} variant="compact">
        <button type="button">Abort stream</button>
      </SlotProgressCard>,
    );

    expect(card().getByText("Stream 1 · 1233-frontend")).toBeInTheDocument();
    expect(card().getByText("Implementation")).toBeInTheDocument();
    expect(card().getByRole("progressbar")).toBeInTheDocument();

    // Valdymas, darbo kopija ir klaidų istorija turi vieną šeimininką — `#/system`.
    expect(card().queryByRole("button")).toBeNull();
    expect(card().queryByText("Worktree")).toBeNull();
    expect(card().queryByText("Last error")).toBeNull();
    expect(card().queryByText("Elapsed")).toBeNull();
  });

  it("stays quiet about a forecast it does not have", () => {
    render(
      <SlotProgressCard
        view={view({ eta: { state: "unavailable", reason: "no-source" } })}
        variant="compact"
      />,
    );

    expect(card().queryByText("ETA: not enough data")).toBeNull();
  });
});
