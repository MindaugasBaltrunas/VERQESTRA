import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOperatorActions } from "../../controller/useOperatorActions";

afterEach(() => {
  vi.useRealTimers();
});

describe("useOperatorActions", () => {
  it("sends one request for a double click, because the guard is synchronous", async () => {
    let release: (() => void) | null = null;
    const perform = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve("done");
        }),
    );
    const { result } = renderHook(() => useOperatorActions());

    // Du paspaudimai TOJE PAČIOJE partijoje, be `await` tarp jų: būtent taip atrodo greitas dvigubas
    // paspaudimas, kai `setState` dar nespėjo išjungti mygtuko.
    act(() => {
      void result.current.run("loop-stop", { perform, failureMessage: "no" });
      void result.current.run("loop-stop", { perform, failureMessage: "no" });
    });

    expect(perform).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.pendingActions.has("loop-stop")).toBe(true));

    await act(() => {
      release?.();
      return Promise.resolve();
    });
    await waitFor(() => expect(result.current.pendingActions.has("loop-stop")).toBe(false));

    // Pasibaigus veiksmui tas pats mygtukas vėl veikia — apsauga yra laikina, o ne užraktas visam laikui.
    await act(async () => {
      await result.current.run("loop-stop", { perform: () => Promise.resolve("again"), failureMessage: "no" });
    });
    expect(result.current.toasts.at(-1)?.message).toBe("again");
  });

  it("lets different actions run at the same time", async () => {
    const never = () => new Promise<string>(() => {});
    const { result } = renderHook(() => useOperatorActions());

    act(() => {
      void result.current.run("loop-stop", { perform: never, failureMessage: "no" });
      void result.current.run("workers-2", { perform: never, failureMessage: "no" });
    });

    await waitFor(() => {
      expect(result.current.pendingActions.has("loop-stop")).toBe(true);
      expect(result.current.pendingActions.has("workers-2")).toBe(true);
    });
  });

  it("shows the sentence the action produced and takes it away on its own", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useOperatorActions({ successDismissMs: 5_000 }));

    await act(async () => {
      await result.current.run("loop-start", {
        perform: () => Promise.resolve("Loop started with 2 stream(s)."),
        failureMessage: "no",
      });
    });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0]?.message).toBe("Loop started with 2 stream(s).");

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current.toasts).toHaveLength(0);
  });

  it("keeps the error on screen and never lets the rejection escape", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useOperatorActions({ successDismissMs: 5_000 }));

    await act(async () => {
      // Veiksmas NETURI mesti: mygtuko paspaudimas be `catch` paliktų neapdorotą promise atmetimą.
      await result.current.run("fix-0900-a", {
        perform: () => Promise.reject(new Error("HTTP 409: task is in 'queue'")),
        failureMessage: "Could not send the task back to the queue",
      });
    });

    expect(result.current.toasts[0]?.message).toBe(
      "Could not send the task back to the queue: HTTP 409: task is in 'queue'",
    );
    // Klaidos tekstas yra vienintelis dalykas, kurį operatorius privalo perskaityti — jis nedingsta.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.toasts).toHaveLength(1);
    // Ir po nesėkmės mygtukas atsirakina.
    expect(result.current.pendingActions.has("fix-0900-a")).toBe(false);
  });

  it("closes a message when the operator dismisses it", async () => {
    const { result } = renderHook(() => useOperatorActions());

    await act(async () => {
      await result.current.run("loop-stop", { perform: () => Promise.resolve("stopped"), failureMessage: "no" });
    });
    const id = result.current.toasts[0]?.id ?? 0;

    act(() => {
      result.current.dismissToast(id);
    });

    expect(result.current.toasts).toHaveLength(0);
  });

  it("writes nothing after unmounting mid-flight", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    let release: ((value: string) => void) | null = null;
    const { result, unmount } = renderHook(() => useOperatorActions());

    let pending: Promise<void> | null = null;
    act(() => {
      pending = result.current.run("loop-restart", {
        perform: () => new Promise<string>((resolve) => { release = resolve; }),
        failureMessage: "no",
      });
    });
    unmount();
    await act(async () => {
      release?.("restarted");
      await pending;
    });

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
