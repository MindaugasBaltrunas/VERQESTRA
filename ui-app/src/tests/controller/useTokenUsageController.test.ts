import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useTokenUsageController } from "../../controller/useTokenUsageController";
import * as api from "../../model/api";
import type { TokenUsageServerFilter } from "../../model/types";

vi.mock("../../model/api", () => ({
  fetchTokenUsage: vi.fn().mockResolvedValue({ records: [] }),
}));

describe("useTokenUsageController", () => {
  it("becomes empty and stops loading after an empty response resolves", async () => {
    const { result } = renderHook(() => useTokenUsageController());

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.isEmpty).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("keeps every model in modelOptions after picking one model filter", async () => {
    const allRecords = [
      { ts: "2026-01-01T00:00:00Z", phase: "preflight", task_id: "t1", model: "opus" },
      { ts: "2026-01-01T00:00:00Z", phase: "dispatch", task_id: "t2", model: "sonnet" },
    ];
    vi.mocked(api.fetchTokenUsage).mockImplementation((filter: TokenUsageServerFilter) => {
      const records = filter.model ? allRecords.filter((r) => r.model === filter.model) : allRecords;
      return Promise.resolve({ records });
    });

    const { result } = renderHook(() => useTokenUsageController());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.modelOptions).toEqual(["opus", "sonnet"]);

    act(() => result.current.actions.setModel("opus"));
    await waitFor(() => expect(result.current.byModel).not.toEqual([]));

    // The data view narrows to the selected model, but the dropdown itself
    // must still offer every model — otherwise the user can never switch back.
    expect(result.current.modelOptions).toEqual(["opus", "sonnet"]);
  });

  it("loads a bounded recent page first and can request the complete history", async () => {
    vi.mocked(api.fetchTokenUsage).mockResolvedValue({
      records: [],
      pagination: { total_records: 1706, returned_records: 500, offset: 0, limit: 500, has_more: true },
    });
    const { result } = renderHook(() => useTokenUsageController());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(api.fetchTokenUsage).toHaveBeenCalledWith(expect.objectContaining({ limit: 500 }));
    expect(result.current.isPartial).toBe(true);

    act(() => {
      result.current.actions.loadAll();
    });
    await waitFor(() => {
      expect(api.fetchTokenUsage).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 0 }));
    });
  });

  // 2026-08-06 UI auditas: 60 s foninis atnaujinimas nebuvo padengtas jokiu testu, todėl abi
  // žemiau fiksuojamos klaidos išgyveno nepastebėtos.
  it("keeps the full history after a background refresh once the complete history was requested", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(api.fetchTokenUsage).mockResolvedValue({
        records: [],
        pagination: { total_records: 1706, returned_records: 500, offset: 0, limit: 500, has_more: true },
      });
      const { result } = renderHook(() => useTokenUsageController());
      await waitFor(() => expect(result.current.loading).toBe(false));

      act(() => {
        result.current.actions.loadAll();
      });
      await waitFor(() => {
        expect(api.fetchTokenUsage).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 0 }));
      });

      // Anksčiau intervalo callback'as visada kviesdavo `load()` su numatytuoju 500, tad po
      // minutės visa istorija tyliai virsdavo 500 naujausių įrašų be jokio vartotojo veiksmo.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(api.fetchTokenUsage).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 0 }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps already-loaded data when a background refresh fails and reports it separately", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(api.fetchTokenUsage).mockResolvedValue({
        records: [{ ts: "2026-08-01T10:00:00Z", phase: "dispatch", task_id: "t1", model: "sonnet" }],
      });
      const { result } = renderHook(() => useTokenUsageController());
      await waitFor(() => expect(result.current.loadedRecords).toBe(1));

      vi.mocked(api.fetchTokenUsage).mockRejectedValue(new Error("HTTP 500: upstream"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      // Vienas trumpalaikis 5xx anksčiau pakeisdavo VISĄ puslapį raudona klaidos žinute.
      await waitFor(() => expect(result.current.refreshError).toContain("HTTP 500"));
      expect(result.current.error).toBeNull();
      expect(result.current.loadedRecords).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends date inputs as inclusive local-day ISO boundaries", async () => {
    vi.mocked(api.fetchTokenUsage).mockResolvedValue({ records: [] });
    const { result } = renderHook(() => useTokenUsageController());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.actions.setFrom("2026-07-10");
      result.current.actions.setTo("2026-07-15");
    });

    await waitFor(() => {
      expect(api.fetchTokenUsage).toHaveBeenCalledWith(expect.objectContaining({
        from: new Date(2026, 6, 10, 0, 0, 0, 0).toISOString(),
        to: new Date(2026, 6, 15, 23, 59, 59, 999).toISOString(),
      }));
    });
  });
});
