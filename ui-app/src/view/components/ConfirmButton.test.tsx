import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmButton } from "./ConfirmButton";

function labels(overrides: Partial<Parameters<typeof ConfirmButton>[0]> = {}) {
  return {
    label: "Abort stream",
    confirmLabel: "Confirm abort",
    cancelLabel: "Cancel",
    onConfirm: vi.fn(),
    ...overrides,
  };
}

describe("ConfirmButton", () => {
  it("does nothing on the first click and acts on the deliberate second one", () => {
    const props = labels();
    render(<ConfirmButton {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Abort stream" }));
    expect(props.onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm abort" }));
    expect(props.onConfirm).toHaveBeenCalledOnce();
  });

  it("returns to the initial state when the operator changes their mind", () => {
    const props = labels();
    render(<ConfirmButton {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Abort stream" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // Persigalvojimas yra pilnavertis kelias, o ne dar vienas paspaudimas iki veiksmo.
    expect(props.onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Abort stream" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm abort" })).toBeNull();
  });

  it("keeps the same name while busy and refuses further clicks", () => {
    const props = labels({ busy: true });
    render(<ConfirmButton {...props} />);

    const button = screen.getByRole("button", { name: "Abort stream" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("drops the armed state when the action is closed while waiting for the second click", () => {
    // Patvirtinimo mygtukas negali būti vienintelis valdiklis, kuris nepaiso `disabled`: kai kol
    // laukiama antro paspaudimo pradedamas kitas veiksmas, matrica uždaro VISUS tris mygtukus.
    const props = labels();
    const { rerender } = render(<ConfirmButton {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Abort stream" }));
    expect(screen.getByRole("button", { name: "Confirm abort" })).toBeInTheDocument();

    rerender(<ConfirmButton {...props} disabled />);

    expect(screen.queryByRole("button", { name: "Confirm abort" })).toBeNull();
    expect(screen.getByRole("button", { name: "Abort stream" })).toBeDisabled();

    // Vėl leidus veiksmą mygtukas grįžta į PRADINĘ, o ne į paruoštą būseną: patvirtinimas privalo
    // likti sąmoningas antras paspaudimas.
    rerender(<ConfirmButton {...props} />);
    expect(screen.queryByRole("button", { name: "Confirm abort" })).toBeNull();
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it("asks for confirmation only in the instance that was clicked", () => {
    render(
      <>
        <ConfirmButton {...labels({ label: "Abort stream 1" })} />
        <ConfirmButton {...labels({ label: "Abort stream 2" })} />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Abort stream 1" }));

    expect(screen.getAllByRole("button", { name: "Confirm abort" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Abort stream 2" })).toBeInTheDocument();
  });
});
