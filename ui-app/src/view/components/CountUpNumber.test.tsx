import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CountUpNumber } from "./CountUpNumber";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** `matchMedia`, kuri visada sako „mažiau judesio". Prenumeratos metodų sąmoningai nėra. */
function reducedMotionMatchMedia() {
  return vi.fn(() => ({ matches: true, media: "(prefers-reduced-motion: reduce)" }));
}

describe("CountUpNumber with reduced motion", () => {
  it("renders the final value immediately when the user asked for less motion", () => {
    vi.stubGlobal("matchMedia", reducedMotionMatchMedia());

    const { rerender } = render(<CountUpNumber value={5} />);
    expect(screen.getByText("5")).toBeInTheDocument();

    rerender(<CountUpNumber value={42} />);

    // Jokio tarpinio kadro: prašiusiam mažiau judesio animacija yra klaida, o ne malonumas.
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.queryByText("5")).toBeNull();
  });

  it("does the same, and throws nothing, when matchMedia does not exist at all", () => {
    // SSR arba senas jsdom: saugus numatytasis atsakymas yra „be animacijos".
    vi.stubGlobal("matchMedia", undefined);

    const { rerender } = render(<CountUpNumber value={5} />);
    expect(screen.getByText("5")).toBeInTheDocument();

    expect(() => rerender(<CountUpNumber value={42} />)).not.toThrow();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("never shows a fraction of a task", () => {
    vi.stubGlobal("matchMedia", reducedMotionMatchMedia());

    render(<CountUpNumber value={7} />);

    expect(screen.getByText("7")).toBeInTheDocument();
  });
});
