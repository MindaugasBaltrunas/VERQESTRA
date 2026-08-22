import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useOperatorActions, type OperatorToast } from "../../controller/useOperatorActions";
import { ToastStack } from "./ToastStack";

function toast(overrides: Partial<OperatorToast> = {}): OperatorToast {
  return { id: 1, tone: "success", message: "Loop started with 2 stream(s).", ...overrides };
}

describe("ToastStack", () => {
  it("interrupts the reader for an error and only confirms a success", () => {
    render(
      <ToastStack
        toasts={[
          toast({ id: 1, tone: "success", message: "Loop restarted." }),
          toast({ id: 2, tone: "error", message: "Could not stop the loop: HTTP 500" }),
        ]}
        onDismiss={vi.fn()}
      />,
    );

    // `alert` nutraukia ekrano skaitytuvą, nes reikalauja veiksmo; `status` tik patvirtina jau
    // įvykusį dalyką. Sukeisti juos vietomis reikštų, kad klaida praeitų nepastebėta.
    expect(screen.getByRole("alert")).toHaveTextContent("Could not stop the loop: HTTP 500");
    expect(screen.getByRole("status")).toHaveTextContent("Loop restarted.");
  });

  it("announces the stack politely, so a new message never steals the focus", () => {
    const { container } = render(<ToastStack toasts={[toast()]} onDismiss={vi.fn()} />);

    const stack = container.querySelector(".toast-stack");
    expect(stack).toHaveAttribute("aria-live", "polite");
  });

  it("closes exactly the message whose button was pressed", () => {
    const onDismiss = vi.fn();
    render(
      <ToastStack
        toasts={[
          toast({ id: 7, tone: "error", message: "first" }),
          toast({ id: 9, tone: "error", message: "second" }),
        ]}
        onDismiss={onDismiss}
      />,
    );

    // Abu mygtukai vadinasi vienodai, tad identifikuoja tik pranešimo id — būtent jį ir tikriname.
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[1]);

    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledWith(9);
  });

  it("renders nothing at all when there is nothing to report", () => {
    const { container } = render(<ToastStack toasts={[]} onDismiss={vi.fn()} />);

    // Tuščias `aria-live` konteineris būtų tyli sritis, kurios skaitytuvas stebėti neprivalo, o
    // vartotojui liktų tuščias tarpas tarp panelių.
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("shows the server sentence exactly as the server wrote it", () => {
    // Serverio `{error}` tekstas yra vienintelis dalykas, pasakantis, ką operatorius gali padaryti:
    // sutrumpintas, perfrazuotas ar praleistas jis paverstų pranešimą bevertišku „nepavyko".
    const message =
      "Could not send the task back to the queue: HTTP 409: task '1235-x.md' is in 'queue'; only 'human-review' tasks can be triaged from the UI";
    render(<ToastStack toasts={[toast({ tone: "error", message })]} onDismiss={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveTextContent(message);
  });

  it("prints server-controlled text as text, never as markup", () => {
    // Pranešimo turinį diktuoja serverio atsakymas. Jei jis kada nors atkeliautų su HTML, React
    // vaikas privalo likti tekstu — `dangerouslySetInnerHTML` čia paverstų klaidos pranešimą
    // injekcijos kanalu.
    const message = '<img src="x" onerror="alert(1)">HTTP 500: <b>boom</b>';
    const { container } = render(<ToastStack toasts={[toast({ tone: "error", message })]} onDismiss={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });
});

/**
 * Nuo serverio atsakymo iki ekrano vienu keliu. Kontrolerio testai įrodo, kad pranešimas atsiranda
 * BŪSENOJE; čia įrodoma, kad ta pati būsena tampa matomu sakiniu — būtent tai jungia `DashboardPage`,
 * ir būtent to nepatikrina nė vienas hook'o lygio testas.
 */
describe("ToastStack driven by useOperatorActions", () => {
  /**
   * Tas pats laidas kaip `DashboardPage`: mygtukas -> `run()` -> `toasts` -> `ToastStack`. Testas
   * paspaudžia mygtuką, o ne kviečia hook'ą, todėl jis matuoja tai, ką mato vartotojas.
   */
  function Harness({
    perform,
    failureMessage,
    successDismissMs,
  }: {
    perform: () => Promise<string>;
    failureMessage: string;
    successDismissMs?: number;
  }) {
    const { run, toasts, dismissToast } = useOperatorActions(
      successDismissMs === undefined ? undefined : { successDismissMs },
    );
    return (
      <>
        <button type="button" onClick={() => void run("fix-1235-x", { perform, failureMessage })}>
          Act
        </button>
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </>
    );
  }

  it("puts the rejected request's server text on the screen and lets the operator close it", async () => {
    render(
      <Harness
        perform={() => Promise.reject(new Error("HTTP 409: task is held by an active worker lease"))}
        failureMessage="Could not send the task back to the queue"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Act" }));

    // Serverio paaiškinimas nukeliauja iki DOM'o nepakeistas — kontrolerio būsena yra tik pusiaukelė.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not send the task back to the queue: HTTP 409: task is held by an active worker lease",
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("takes a success sentence off the screen on its own, without any click", async () => {
    vi.useFakeTimers();
    try {
      render(
        <Harness
          perform={() => Promise.resolve("Loop restarted.")}
          failureMessage="Could not restart the loop"
          successDismissMs={5_000}
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Act" }));
        await Promise.resolve();
      });
      expect(screen.getByRole("status")).toHaveTextContent("Loop restarted.");

      act(() => {
        vi.advanceTimersByTime(5_000);
      });

      // Sėkmė yra patvirtinimas, ne užduotis: ji dingsta pati. Klaida (aukščiau) — tik paspaudus.
      expect(screen.queryByRole("status")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends one request for a double click all the way from the DOM", () => {
    // Hook'o lygiu tai jau įrodyta; čia tas pats paspaudimas ateina per TIKRĄ DOM įvykį, tad
    // matuojama ir tai, ar rodinys apsaugos nepraranda.
    const perform = vi.fn(() => new Promise<string>(() => {}));
    render(<Harness perform={perform} failureMessage="no" />);

    const button = screen.getByRole("button", { name: "Act" });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(perform).toHaveBeenCalledTimes(1);
  });
});
