import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWavesController } from "./useWavesController";

// Tinklo sluoksnis mock'inamas: tikrinama elgsena („ar apskritai einama į serverį"), o ne HTTP.
vi.mock("../model/api", () => ({ getUiToken: () => "test-token" }));

const emptyView = {
  events: [],
  leases: [],
  last_rejections: [],
  degraded: [],
};

function okFetch() {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => emptyView });
}

describe("useWavesController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not touch the network and starts no polling while the screen is not shown", () => {
    vi.useFakeTimers();
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    const { unmount } = renderHook(() => useWavesController({ enabled: false }));

    // Nei pirmo užklausimo, nei laikmačio: kitaip kiekvienas duomenų vartotojas pridėtų dar vieną
    // 30 s pollingo srautą tam pačiam endpoint'ui.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(120_000);
    expect(fetchMock).not.toHaveBeenCalled();

    unmount();
    setIntervalSpy.mockRestore();
  });

  it("loads once as soon as the screen is shown", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useWavesController({ enabled: true }));

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/waves");
    expect(result.current.error).toBeNull();
  });

  it("keeps the last known error message when the endpoint fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: "waves snapshot unreadable" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useWavesController());

    await waitFor(() => expect(result.current.error).toBe("waves snapshot unreadable"));
    expect(result.current.data).toBeNull();
  });
});
