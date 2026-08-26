import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CompressionPage } from "./CompressionPage";
import * as api from "../../model/api";
import type { CompressionView } from "../../model/types";

vi.mock("../../model/api", () => ({
  fetchCompression: vi.fn(),
  setCompressionFeature: vi.fn(),
  getUiToken: vi.fn().mockReturnValue(""),
}));

const noop = () => undefined;

afterEach(() => {
  vi.mocked(api.fetchCompression).mockReset();
  vi.mocked(api.setCompressionFeature).mockReset();
});

function view(overrides: Partial<CompressionView> = {}): CompressionView {
  return {
    version: 1,
    canary: { percent: 0, salt: "v1" },
    features: [
      { key: "worker_task_ir", value: false, canary_supported: true },
      { key: "compact_dsl", value: false, canary_supported: true },
      { key: "symbol_slices", value: "canary", canary_supported: true },
      { key: "bash_output_digest", value: false, canary_supported: false },
      { key: "dispatch_tool_schema", value: true, canary_supported: true },
    ],
    telemetry: {
      sample_count: 12,
      latest_ts: "2026-08-26T08:25:57.730Z",
      avg_budget_percent: 58.7,
      max_budget_percent: 105,
      exceeded_count: 1,
      ir_compared_count: 12,
      ir_smaller_count: 4,
      avg_ir_delta_percent: 12.5,
    },
    degraded: [],
    ...overrides,
  };
}

describe("CompressionPage", () => {
  it("rodo visas penkias vėliavas su dabartinėmis reikšmėmis", async () => {
    vi.mocked(api.fetchCompression).mockResolvedValue(view());
    render(<CompressionPage activeRoute="compression" onNavigate={noop} />);

    // Raktas rodomas DVIEJOSE vietose (eilutės antraštėje ir `<select>` label'e), tad ieškoma
    // per label'ą — jis yra vienintelis, ir būtent jį „mato" ekrano skaitytuvas.
    await waitFor(() => expect(screen.getByLabelText("worker_task_ir")).toBeTruthy());
    for (const key of ["compact_dsl", "symbol_slices", "bash_output_digest", "dispatch_tool_schema"]) {
      expect(screen.getByLabelText(key)).toBeTruthy();
    }

    const select = screen.getByLabelText("symbol_slices") as HTMLSelectElement;
    expect(select.value).toBe("canary");
  });

  /**
   * Svarbiausias šio puslapio testas: `bash_output_digest` sprendimo taškas neturi task konteksto,
   * tad serveris canary ten atmeta. Dropdown, siūlantis atmestiną reikšmę, klaidintų operatorių.
   */
  it("canary variantą siūlo TIK ten, kur serveris jį priims", async () => {
    vi.mocked(api.fetchCompression).mockResolvedValue(view());
    render(<CompressionPage activeRoute="compression" onNavigate={noop} />);

    await waitFor(() => expect(screen.getByLabelText("bash_output_digest")).toBeTruthy());

    const unsupported = screen.getByLabelText("bash_output_digest") as HTMLSelectElement;
    expect([...unsupported.options].map((option) => option.value)).toEqual(["false", "true"]);

    const supported = screen.getByLabelText("worker_task_ir") as HTMLSelectElement;
    expect([...supported.options].map((option) => option.value)).toEqual(["false", "true", "canary"]);
  });

  it("pasirinkus reikšmę siunčia ją serveriui ir PERSKAITO būseną iš naujo", async () => {
    vi.mocked(api.fetchCompression).mockResolvedValue(view());
    vi.mocked(api.setCompressionFeature).mockResolvedValue(undefined);
    render(<CompressionPage activeRoute="compression" onNavigate={noop} />);

    await waitFor(() => expect(screen.getByLabelText("compact_dsl")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("compact_dsl"), { target: { value: "canary" } });

    await waitFor(() => expect(api.setCompressionFeature).toHaveBeenCalledWith("compact_dsl", "canary"));
    // Antras `fetchCompression` — ekranas rodo SERVERIO tiesą, ne optimistinį spėjimą.
    await waitFor(() => expect(vi.mocked(api.fetchCompression).mock.calls.length).toBe(2));
  });

  it("serverio atmetimas rodomas operatoriui, o reikšmė lieka sena", async () => {
    vi.mocked(api.fetchCompression).mockResolvedValue(view());
    vi.mocked(api.setCompressionFeature).mockRejectedValue(new Error('does not support "canary"'));
    render(<CompressionPage activeRoute="compression" onNavigate={noop} />);

    await waitFor(() => expect(screen.getByLabelText("worker_task_ir")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("worker_task_ir"), { target: { value: "canary" } });

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain('does not support "canary"'));
    expect((screen.getByLabelText("worker_task_ir") as HTMLSelectElement).value).toBe("false");
  });

  it("rodo shadow telemetriją ir įspėja, kai IR vidutiniškai DIDESNIS", async () => {
    vi.mocked(api.fetchCompression).mockResolvedValue(view());
    render(<CompressionPage activeRoute="compression" onNavigate={noop} />);

    await waitFor(() => expect(screen.getByText("58.7%")).toBeTruthy());
    expect(screen.getByText("4/12")).toBeTruthy();
    expect(screen.getByText("+12.5%")).toBeTruthy();
    expect(screen.getByText(/IR is larger on average/)).toBeTruthy();
  });

  it("telemetrijos lūžis nepaslepia vėliavų", async () => {
    vi.mocked(api.fetchCompression).mockResolvedValue(
      view({ degraded: ["context-size.jsonl: not found"], telemetry: { sample_count: 0, exceeded_count: 0, ir_compared_count: 0, ir_smaller_count: 0 } }),
    );
    render(<CompressionPage activeRoute="compression" onNavigate={noop} />);

    await waitFor(() => expect(screen.getByLabelText("worker_task_ir")).toBeTruthy());
    expect(screen.getByText(/context-size\.jsonl: not found/)).toBeTruthy();
    expect(screen.getByText(/No shadow samples yet/)).toBeTruthy();
  });
});
