import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WavesPanel } from "./WavesPanel";
import * as api from "../../model/api";
import type { UiWaveSlot, UiWavesView } from "../../controller/useWavesController";

/**
 * Mock'inama `fetchWaves`, o NE globalus `fetch`.
 *
 * Iki 2026-08-26 šie testai stub'ino `globalThis.fetch`, nes kontroleris pats kalbėjosi su tinklu.
 * Task 028 jį perkėlė į bendrą klientą (`model/api`), tad tinklo sluoksnis — timeout'as, token'as
 * ir `assertOk` klaidų paaiškinimai — nebėra šio komponento reikalas. Testas, kuris ir toliau
 * stub'intų `fetch`, tikrintų kelią, kurio komponentas nebeturi: mock'as perima `fetchWaves`,
 * tikrasis `fetch` niekada nekviečiamas, o panelė lieka be duomenų.
 */
vi.mock("../../model/api", () => ({
  fetchWaves: vi.fn(),
  getUiToken: () => "test-token",
}));

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
  beforeEach(() => {
    vi.mocked(api.fetchWaves).mockReset();
  });

  it("renders slot leases and rejections from GET /api/waves", async () => {
    vi.mocked(api.fetchWaves).mockResolvedValue(view());

    render(<WavesPanel />);

    await waitFor(() => expect(screen.getByText("w1")).toBeInTheDocument());
    expect(api.fetchWaves).toHaveBeenCalledTimes(1);
    expect(screen.getByText("0900-example")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText(/isolation_conflict/)).toBeInTheDocument();
    expect(screen.getByText(/shares write-set with 0900/)).toBeInTheDocument();
    expect(screen.getByText(/wave.granted/)).toBeInTheDocument();
  });

  it("shows a degraded-sources notice without failing the whole panel", async () => {
    vi.mocked(api.fetchWaves).mockResolvedValue(view({ degraded: ["leases"] }));

    render(<WavesPanel />);

    await waitFor(() =>
      expect(screen.getByText(/Some wave sources could not be read/)).toHaveTextContent("leases"),
    );
  });

  it("shows an empty state when there are no active leases or rejections", async () => {
    vi.mocked(api.fetchWaves).mockResolvedValue(view({ leases: [], last_rejections: [], events: [] }));

    render(<WavesPanel />);

    await waitFor(() => expect(screen.getByText("No active leases")).toBeInTheDocument());
    expect(screen.getByText("No rejections recorded")).toBeInTheDocument();
    expect(screen.getByText("No wave events recorded")).toBeInTheDocument();
  });

  it("shows an error with a retry action when the request fails", async () => {
    // Bendras klientas neok atsakymą paverčia metimu (`assertOk`), tad panelė mato Error, ne Response.
    vi.mocked(api.fetchWaves).mockRejectedValue(new Error("HTTP 500: internal"));

    render(<WavesPanel />);

    await waitFor(() => expect(screen.getByText(/Failed to load waves/)).toBeInTheDocument());

    vi.mocked(api.fetchWaves).mockResolvedValue(view());
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(screen.getByText("w1")).toBeInTheDocument());
  });

  it("keeps showing the last successful data as a banner when a later poll fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(api.fetchWaves).mockResolvedValueOnce(view());
      render(<WavesPanel />);
      await waitFor(() => expect(screen.getByText("w1")).toBeInTheDocument());

      vi.mocked(api.fetchWaves).mockRejectedValueOnce(new Error("HTTP 503: waves snapshot unreadable"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      // Klaida rodoma JUOSTA virš duomenų, o ne vietoj jų — paskutinė sėkminga eilutė lieka matoma.
      await waitFor(() => expect(screen.getByText(/Failed to load waves/)).toBeInTheDocument());
      expect(screen.getByText("w1")).toBeInTheDocument();
      expect(screen.getByText("0900-example")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("disables the retry button and shows a loading label while a retry is in flight", async () => {
    vi.mocked(api.fetchWaves).mockRejectedValueOnce(new Error("HTTP 500: internal"));
    render(<WavesPanel />);
    await waitFor(() => expect(screen.getByText(/Failed to load waves/)).toBeInTheDocument());

    let resolveRetry!: (value: ReturnType<typeof view>) => void;
    vi.mocked(api.fetchWaves).mockReturnValueOnce(new Promise((resolve) => { resolveRetry = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Loading..." })).toBeDisabled());

    resolveRetry(view());
    await waitFor(() => expect(screen.getByText("w1")).toBeInTheDocument());
  });

  it("polls again after 30 seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(api.fetchWaves).mockResolvedValue(view());
      render(<WavesPanel />);
      await waitFor(() => expect(api.fetchWaves).toHaveBeenCalledTimes(1));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(api.fetchWaves).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // Task 1228: kai serveris grąžina `slots`, operatorius mato būseną, o ne vien lease'o eilutę.
  it("renders slot rows with state, heartbeat and failure reason when the server sends slots", async () => {
    vi.mocked(api.fetchWaves).mockResolvedValue(
      view({
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
      }),
    );

    const { container } = render(<WavesPanel />);

    await waitFor(() => expect(screen.getByText("w1")).toBeInTheDocument());

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

  it("keeps the legacy lease table when the server sends no slots", async () => {
    vi.mocked(api.fetchWaves).mockResolvedValue(view());

    const { container } = render(<WavesPanel />);

    await waitFor(() => expect(screen.getByText("w1")).toBeInTheDocument());

    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(container.querySelector("[data-state]")).toBeNull();
  });
});
