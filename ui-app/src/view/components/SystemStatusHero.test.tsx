import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SystemStatusHero, type SystemStatusHeroProps } from "./SystemStatusHero";

const BASE: SystemStatusHeroProps = {
  loopRunState: "running",
  currentTaskId: null,
  queueCount: 0,
  humanReviewCount: 0,
  canStartLoop: false,
  startLoopBusy: false,
  onStartLoop: vi.fn(),
  onGoToReviews: vi.fn(),
};

describe("SystemStatusHero", () => {
  it("ciklas vykdo: rodo vykdomą užduotį ir jokio kontekstinio veiksmo", () => {
    render(<SystemStatusHero {...BASE} loopRunState="running" currentTaskId="042-example" queueCount={3} />);

    expect(screen.getByText("Loop is running")).toBeInTheDocument();
    expect(screen.getByText("Currently executing 042-example.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start loop" })).toBeNull();
  });

  it("ciklas vykdo be priskirtos užduoties: sąžiningas tarp užduočių, ne tuščia eilutė", () => {
    render(<SystemStatusHero {...BASE} loopRunState="running" currentTaskId={null} />);

    expect(screen.getByText("Between tasks — the loop is running.")).toBeInTheDocument();
  });

  it("sustojęs dėl žmogaus sprendimo: priežastis įvardyta, kontekstinio veiksmo NĖRA (nuoroda žemiau — atskiras statistikos blokas)", () => {
    render(
      <SystemStatusHero {...BASE} loopRunState="stopped" queueCount={2} humanReviewCount={1} />,
    );

    expect(screen.getByText("Stopped — waiting on a decision")).toBeInTheDocument();
    expect(screen.getByText("1 task(s) need a human decision before the loop can continue.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start loop" })).toBeNull();
  });

  it("sustojęs be darbo: eilė tuščia, jokio kontekstinio veiksmo", () => {
    render(<SystemStatusHero {...BASE} loopRunState="stopped" queueCount={0} humanReviewCount={0} />);

    expect(screen.getByText("Stopped — no work queued")).toBeInTheDocument();
    expect(screen.getByText("The queue is empty; there is nothing for the loop to do.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start loop" })).toBeNull();
  });

  it("sustojęs, bet eilėje yra atblokuotų užduočių: kontekstinis veiksmas paleidžia ciklą", () => {
    const onStartLoop = vi.fn();
    render(
      <SystemStatusHero
        {...BASE}
        loopRunState="stopped"
        queueCount={4}
        humanReviewCount={0}
        canStartLoop
        onStartLoop={onStartLoop}
      />,
    );

    expect(screen.getByText("Stopped — work is waiting")).toBeInTheDocument();
    expect(screen.getByText("4 queued task(s) are ready to run.")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Start loop" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onStartLoop).toHaveBeenCalledTimes(1);
  });

  it("kontekstinis veiksmas laikosi ta pačia leidimo taisykle kaip Header'is: uzrakintas, kol negalima paleisti", () => {
    render(
      <SystemStatusHero {...BASE} loopRunState="stopped" queueCount={1} humanReviewCount={0} canStartLoop={false} />,
    );

    expect(screen.getByRole("button", { name: "Start loop" })).toBeDisabled();
  });

  it("Reikia peržiūros statistika visada veda į Reviews, nesvarbu ciklo būsena", () => {
    const onGoToReviews = vi.fn();
    render(
      <SystemStatusHero {...BASE} loopRunState="running" queueCount={0} humanReviewCount={2} onGoToReviews={onGoToReviews} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Needs review/ }));
    expect(onGoToReviews).toHaveBeenCalledTimes(1);
  });
});
