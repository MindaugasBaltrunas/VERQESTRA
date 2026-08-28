import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WavesPanel } from "./WavesPanel";
import type { UiWaveSlot, UiWavesView } from "../../model/types";

/**
 * Nuo task 053-a-02 `WavesPanel` nebeturi vidinio duomenų kelio — duomenis visada paduoda
 * tėvinis komponentas per props (`DashboardPage` juos visada paduoda). Todėl testai nebemock'ina
 * `fetchWaves` ar `fetch`: jie tiesiog paduoda `data`/`error`/`loading` props ir tikrina vaizdą
 * bei `onReload` iškvietimą.
 */

function view(overrides: Partial<UiWavesView> = {}): UiWavesView {
  return {
    events: [{ ts: "2026-08-11T10:00:00Z", event: "wave.granted", task_id: "0900-example" }],
    leases: [
      { worker_id: "w1", task_id: "0900-example", status: "active", expires_at: "2026-08-11T10:05:00Z", has_worktree: true },
    ],
    last_rejections: [{ task_id: "0901-other", reason: "isolation_conflict", detail: "shares write-set with 0900" }],
    degraded: [],
    ...overrides,
  };
}

function slot(overrides: Partial<UiWaveSlot> = {}): UiWaveSlot {
  return {
    worker_id: "w1",
    task_id: "0900-example",
    state: "running",
    lease_status: "held",
    acquired_at: "2026-08-11T10:00:00Z",
    heartbeat_at: "2026-08-11T10:04:00Z",
    expires_at: "2026-08-11T10:05:00Z",
    lease_age_ms: 300_000,
    heartbeat_age_ms: 45_000,
    stale: false,
    has_worktree: true,
    last_failure: null,
    ...overrides,
  };
}

describe("WavesPanel", () => {
  it("renders slot leases and rejections from props", () => {
    render(<WavesPanel data={view()} onReload={() => {}} />);

    expect(screen.getByText("w1")).toBeInTheDocument();
    expect(screen.getByText("0900-example")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText(/isolation_conflict/)).toBeInTheDocument();
    expect(screen.getByText(/shares write-set with 0900/)).toBeInTheDocument();
    expect(screen.getByText(/wave.granted/)).toBeInTheDocument();
  });

  it("shows a degraded-sources notice without failing the whole panel", () => {
    render(<WavesPanel data={view({ degraded: ["leases"] })} onReload={() => {}} />);

    expect(screen.getByText(/Some wave sources could not be read/)).toHaveTextContent("leases");
  });

  it("shows an empty state when there are no active leases or rejections", () => {
    render(<WavesPanel data={view({ leases: [], last_rejections: [], events: [] })} onReload={() => {}} />);

    expect(screen.getByText("No active leases")).toBeInTheDocument();
    expect(screen.getByText("No rejections recorded")).toBeInTheDocument();
    expect(screen.getByText("No wave events recorded")).toBeInTheDocument();
  });

  it("shows a loading placeholder when there is no data yet", () => {
    render(<WavesPanel data={null} loading onReload={() => {}} />);

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows an error with a retry action when there is no data yet", () => {
    const onReload = vi.fn();
    render(<WavesPanel data={null} error="HTTP 500: internal" onReload={onReload} />);

    expect(screen.getByText(/Failed to load waves/)).toBeInTheDocument();
    expect(screen.getByText(/HTTP 500: internal/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("keeps showing the last successful data as a banner when a later poll fails", () => {
    render(<WavesPanel data={view()} error="HTTP 503: waves snapshot unreadable" onReload={() => {}} />);

    // Klaida rodoma JUOSTA virš duomenų, o ne vietoj jų — paskutinė sėkminga eilutė lieka matoma.
    expect(screen.getByText(/Failed to load waves/)).toBeInTheDocument();
    expect(screen.getByText("w1")).toBeInTheDocument();
    expect(screen.getByText("0900-example")).toBeInTheDocument();
  });

  it("disables the retry button and shows a loading label while a retry is in flight", () => {
    render(<WavesPanel data={view()} error="HTTP 500: internal" loading onReload={() => {}} />);

    expect(screen.getByRole("button", { name: "Loading..." })).toBeDisabled();
  });

  it("calls onReload when the retry button is clicked", () => {
    const onReload = vi.fn();
    render(<WavesPanel data={view()} error="HTTP 500: internal" onReload={onReload} />);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  // Task 1228: kai serveris grąžina `slots`, operatorius mato būseną, o ne vien lease'o eilutę.
  it("renders slot rows with state, heartbeat and failure reason when the server sends slots", () => {
    const { container } = render(
      <WavesPanel
        data={view({
          slots: [
            slot(),
            slot({
              worker_id: "w2",
              task_id: "0901-other",
              state: "failed",
              stale: true,
              heartbeat_age_ms: 3_600_000,
              last_failure: { ts: "2026-08-11T10:02:00Z", task_id: "0901-other", reason: "dispatch exited 75" },
            }),
          ],
        })}
        onReload={() => {}}
      />,
    );

    // Viena lentelė, ne dvi: lease'o eilutė gyvena slot'o eilutėje, tad workeris rodomas vienąkart.
    expect(screen.getAllByText("w1")).toHaveLength(1);
    expect(screen.getAllByText("w2")).toHaveLength(1);

    expect(container.querySelector('[data-state="running"]')).toHaveTextContent("Running");
    expect(container.querySelector('[data-state="failed"]')).toHaveTextContent("Failed");
    expect(screen.getByText("45s")).toBeInTheDocument();
    expect(screen.getByText(/Stale lease/)).toBeInTheDocument();
    expect(screen.getByText(/dispatch exited 75/)).toHaveTextContent("2026-08-11T10:02:00Z");
    // Slot'ų lentelė turi „State", o ne legacy „Status" stulpelį.
    expect(screen.queryByText("Status")).not.toBeInTheDocument();
  });

  it("keeps the legacy lease table when the server sends no slots", () => {
    const { container } = render(<WavesPanel data={view()} onReload={() => {}} />);

    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(container.querySelector("[data-state]")).toBeNull();
  });
});
