import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SlotProgressBar } from "../../model/slotProgressViewModel";
import { ProgressBar } from "./ProgressBar";

function bar(progress: SlotProgressBar, label?: string | null) {
  render(<ProgressBar progress={progress} label={label} />);
  return screen.queryByRole("progressbar");
}

describe("ProgressBar", () => {
  it("renders nothing when there is no progress signal", () => {
    // „Signalo nėra" NĖRA nulinis progresas: 0 % juosta tvirtintų, kad darbas neprasidėjo.
    expect(bar({ signal: "none" })).toBeNull();
  });

  it("exposes a determinate bar to assistive technology with its real value", () => {
    const element = bar({ signal: "budget", percent: 42, level: "normal", clamped: false });

    expect(element).not.toBeNull();
    expect(element).toHaveAttribute("aria-valuenow", "42");
    expect(element).toHaveAttribute("aria-valuemin", "0");
    expect(element).toHaveAttribute("aria-valuemax", "100");
    expect(element).toHaveAttribute("title", "42%");
  });

  it("drives the fill through a custom property instead of an inline width", () => {
    const element = bar({ signal: "chain", percent: 43, level: "normal", done: 3, total: 7 });
    const fillElement = element?.querySelector(".progress-bar__fill") as HTMLElement;

    expect(fillElement).not.toBeNull();
    expect(fillElement.style.getPropertyValue("--progress")).toBe("0.43");
    // `width` kiekviename kadre verstų naršyklę perskaičiuoti išdėstymą.
    expect(fillElement.style.width).toBe("");
  });

  it("never invents a value for an indeterminate bar", () => {
    const element = bar({ signal: "indeterminate" });

    expect(element).not.toBeNull();
    expect(element).not.toHaveAttribute("aria-valuenow");
    expect(element).toHaveAttribute("aria-label", "Progress unknown");
  });

  it("renders no infinite animation for an indeterminate bar", () => {
    const element = bar({ signal: "indeterminate" });

    // Jokios begalinės animacijos klasės ar pieštino užpildo — būsena lieka statinė.
    expect(element?.className.split(/\s+/)).not.toContain("progress-bar--indeterminate");
    expect(element?.querySelector(".progress-bar__fill")).toBeNull();
  });

  it("says the progress is unknown in words, not only through motion", () => {
    // Sustabdžius animaciją (prefers-reduced-motion) vien juosta atrodytų kaip įvykdytas darbas.
    bar({ signal: "indeterminate" }, null);

    expect(screen.getByText("Progress unknown")).toBeInTheDocument();
  });

  it("keeps a caller-supplied label next to the percentage", () => {
    bar({ signal: "chain", percent: 43, level: "normal", done: 3, total: 7 }, "3 of 7 agents");

    expect(screen.getByText("3 of 7 agents")).toBeInTheDocument();
    expect(screen.getByText("43%")).toBeInTheDocument();
  });

  it("colours the bar by budget level, leaving normal without a modifier", () => {
    const { unmount } = render(
      <ProgressBar progress={{ signal: "budget", percent: 50, level: "normal", clamped: false }} />,
    );
    expect(screen.getByRole("progressbar").className).toBe("progress-bar");
    unmount();

    const warning = render(
      <ProgressBar progress={{ signal: "budget", percent: 90, level: "warning", clamped: false }} />,
    );
    expect(screen.getByRole("progressbar")).toHaveClass("progress-bar--warning");
    warning.unmount();

    const over = render(
      <ProgressBar progress={{ signal: "budget", percent: 100, level: "over", clamped: true }} />,
    );
    expect(screen.getByRole("progressbar")).toHaveClass("progress-bar--error");
    over.unmount();

    // Grandinės juosta rodo nueitą kelią, o ne sunaudotą resursą — ji visada „gera".
    render(<ProgressBar progress={{ signal: "chain", percent: 100, level: "normal", done: 7, total: 7 }} />);
    expect(screen.getByRole("progressbar")).toHaveClass("progress-bar--good");
  });
});
