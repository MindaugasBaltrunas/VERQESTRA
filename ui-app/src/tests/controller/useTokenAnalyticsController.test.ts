import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useTokenAnalyticsController } from "../../controller/useTokenAnalyticsController";
import * as api from "../../model/api";

vi.mock("../../model/api", () => ({
  fetchTokenAnalytics: vi.fn().mockResolvedValue({ groups: [], candidates: [], history: [] }),
}));

describe("useTokenAnalyticsController", () => {
  it("becomes empty and stops loading after an empty response resolves", async () => {
    const { result } = renderHook(() => useTokenAnalyticsController());

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.isEmpty).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.groups).toEqual([]);
    expect(result.current.candidates).toEqual([]);
    expect(result.current.history).toEqual([]);
  });

  it("exposes groups, candidates, and history from a non-empty response", async () => {
    const response = {
      groups: [
        {
          familyKey: "1",
          taskIds: ["1-a"],
          totalTokensByTask: { "1-a": 100 },
          totalRecords: 1,
          totalTokens: 100,
          medianTokens: 100,
        },
      ],
      candidates: [],
      history: [],
    };
    vi.mocked(api.fetchTokenAnalytics).mockResolvedValue(response);

    const { result } = renderHook(() => useTokenAnalyticsController());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isEmpty).toBe(false);
    expect(result.current.groups).toEqual(response.groups);
  });

  it("surfaces a fetch error instead of throwing", async () => {
    vi.mocked(api.fetchTokenAnalytics).mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useTokenAnalyticsController());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("boom");
  });
});
