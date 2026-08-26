import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWaves } from "../model/api";
import { useWavesController } from "./useWavesController";

// Tinklo sluoksnis mock'inamas per `model/api` ribą: tikrinama elgsena („ar apskritai einama į
// serverį"), o ne HTTP. `fetchWaves` pati savo HTTP ir klaidų parsinimą turi `api.ts` teste
// (`apiEnvelopes.test.ts`) — čia svarbu tik, kaip kontroleris reaguoja į jos rezultatą.
vi.mock("../model/api", () => ({ fetchWaves: vi.fn() }));

const fetchWavesMock = vi.mocked(fetchWaves);

const emptyView = {
  events: [],
  leases: [],
  last_rejections: [],
  degraded: [],
};

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
    fetchWavesMock.mockResolvedValue(emptyView);
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    const { unmount } = renderHook(() => useWavesController({ enabled: false }));

    // Nei pirmo užklausimo, nei laikmačio: kitaip kiekvienas duomenų vartotojas pridėtų dar vieną
    // 30 s pollingo srautą tam pačiam endpoint'ui.
    expect(fetchWavesMock).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(120_000);
    expect(fetchWavesMock).not.toHaveBeenCalled();

    unmount();
    setIntervalSpy.mockRestore();
  });

  it("loads once as soon as the screen is shown", async () => {
    fetchWavesMock.mockResolvedValue(emptyView);

    const { result } = renderHook(() => useWavesController({ enabled: true }));

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(fetchWavesMock).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  it("keeps the last known error message when the endpoint fails", async () => {
    fetchWavesMock.mockRejectedValue(new Error("HTTP 503: waves snapshot unreadable"));

    const { result } = renderHook(() => useWavesController());

    await waitFor(() => expect(result.current.error).toBe("HTTP 503: waves snapshot unreadable"));
    expect(result.current.data).toBeNull();
  });
});
