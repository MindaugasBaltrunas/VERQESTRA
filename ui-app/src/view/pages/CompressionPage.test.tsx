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
    // Verdiktą taria serveris; fixture atitinka telemetriją aukščiau (delta +12.5% → „hold").
    decision: {
      pressure: { level: "high" },
      recommendations: [
        { key: "worker_task_ir", action: "hold", reason: "ir-larger-on-average" },
        { key: "compact_dsl", action: "unmeasured", reason: "no-shadow-measurement" },
        { key: "symbol_slices", action: "unmeasured", reason: "no-shadow-measurement" },
        { key: "bash_output_digest", action: "unmeasured", reason: "no-shadow-measurement" },
        { key: "dispatch_tool_schema", action: "unmeasured", reason: "no-shadow-measurement" },
      ],
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

  it("rodo shadow telemetriją ir SERVERIO verdiktą, kai IR vidutiniškai DIDESNIS", async () => {
    vi.mocked(api.fetchCompression).mockResolvedValue(view());
    render(<CompressionPage activeRoute="compression" onNavigate={noop} />);

    await waitFor(() => expect(screen.getByText("58.7%")).toBeTruthy());
    expect(screen.getByText("4/12")).toBeTruthy();
    expect(screen.getByText("+12.5%")).toBeTruthy();
    // Sprendimo panelis: rekomendacija ateina iš serverio `decision`, puslapis jos NESKAIČIUOJA.
    expect(screen.getByText("Do not enable")).toBeTruthy();
    expect(screen.getByText(/IR form is larger than raw on average/)).toBeTruthy();
    expect(screen.getByText(/Real pressure/)).toBeTruthy();
  });

  it("įvardija KAS lyginama, kai verdiktas turi prompt'o lygio poros lauką", async () => {
    vi.mocked(api.fetchCompression).mockResolvedValue(
      view({
        telemetry: {
          sample_count: 12,
          latest_ts: "2026-08-26T08:25:57.730Z",
          avg_budget_percent: 58.7,
          max_budget_percent: 105,
          exceeded_count: 1,
          ir_compared_count: 12,
          ir_smaller_count: 4,
          avg_ir_delta_percent: 12.5,
          ir_pair: "prompt",
        },
        decision: {
          pressure: { level: "high" },
          recommendations: [
            { key: "worker_task_ir", action: "hold", reason: "ir-larger-on-average", pair: "prompt" },
            { key: "compact_dsl", action: "unmeasured", reason: "no-shadow-measurement" },
            { key: "symbol_slices", action: "unmeasured", reason: "no-shadow-measurement" },
            { key: "bash_output_digest", action: "unmeasured", reason: "no-shadow-measurement" },
            { key: "dispatch_tool_schema", action: "unmeasured", reason: "no-shadow-measurement" },
          ],
        },
      }),
    );
    render(<CompressionPage activeRoute="compression" onNavigate={noop} />);

    await waitFor(() => expect(screen.getByLabelText("worker_task_ir")).toBeTruthy());
    expect(screen.getAllByText("prompt").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/the same worker prompt the executor would receive/).length).toBeGreaterThan(0);
  });

  it("krenta prie task'o lygio poros sakinio, kai mėginiai prompt'o poros neturi", async () => {
    vi.mocked(api.fetchCompression).mockResolvedValue(
      view({
        telemetry: {
          sample_count: 12,
          latest_ts: "2026-08-26T08:25:57.730Z",
          avg_budget_percent: 58.7,
          max_budget_percent: 105,
          exceeded_count: 1,
          ir_compared_count: 12,
          ir_smaller_count: 4,
          avg_ir_delta_percent: 12.5,
          ir_pair: "task",
        },
        decision: {
          pressure: { level: "high" },
          recommendations: [
            { key: "worker_task_ir", action: "hold", reason: "ir-larger-on-average", pair: "task" },
            { key: "compact_dsl", action: "unmeasured", reason: "no-shadow-measurement" },
            { key: "symbol_slices", action: "unmeasured", reason: "no-shadow-measurement" },
            { key: "bash_output_digest", action: "unmeasured", reason: "no-shadow-measurement" },
            { key: "dispatch_tool_schema", action: "unmeasured", reason: "no-shadow-measurement" },
          ],
        },
      }),
    );
    render(<CompressionPage activeRoute="compression" onNavigate={noop} />);

    await waitFor(() => expect(screen.getByLabelText("worker_task_ir")).toBeTruthy());
    expect(screen.getAllByText("task").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/an older fallback used when no prompt-level pair was recorded/).length).toBeGreaterThan(0);
  });

  it("rodo išverstą sakinį likusioms keturioms vėliavoms, ne raw reason kodą", async () => {
    vi.mocked(api.fetchCompression).mockResolvedValue(
      view({
        decision: {
          pressure: { level: "high" },
          recommendations: [
            { key: "worker_task_ir", action: "hold", reason: "ir-larger-on-average" },
            { key: "compact_dsl", action: "enable", reason: "smaller-under-pressure" },
            { key: "symbol_slices", action: "unmeasured", reason: "no-shadow-measurement" },
            { key: "bash_output_digest", action: "unmeasured", reason: "no-shadow-measurement" },
            { key: "dispatch_tool_schema", action: "unmeasured", reason: "no-shadow-measurement" },
          ],
        },
      }),
    );
    render(<CompressionPage activeRoute="compression" onNavigate={noop} />);

    await waitFor(() => expect(screen.getByLabelText("compact_dsl")).toBeTruthy());
    expect(screen.getByText(/compiled form is smaller on average and the budget is under pressure/)).toBeTruthy();
    expect(screen.queryByText("smaller-under-pressure")).toBeNull();
  });

  it("rodo įspėjimą, kai vėliava išsaugota, bet priklausomybė ją laiko neaktyvia", async () => {
    vi.mocked(api.fetchCompression).mockResolvedValue(
      view({
        features: [
          { key: "worker_task_ir", value: false, canary_supported: true },
          {
            key: "compact_dsl",
            value: true,
            canary_supported: true,
            requires: ["worker_task_ir"],
            inactive_reason: "inactive_due_to_dependency",
          },
          { key: "symbol_slices", value: "canary", canary_supported: true },
          { key: "bash_output_digest", value: false, canary_supported: false },
          { key: "dispatch_tool_schema", value: true, canary_supported: true },
        ],
      }),
    );
    render(<CompressionPage activeRoute="compression" onNavigate={noop} />);

    await waitFor(() => expect(screen.getByLabelText("compact_dsl")).toBeTruthy());
    // Neaktyviai vėliavai: badge nebe „good", ir po hint'u yra įspėjimo eilutė su priklausomybe.
    expect(screen.getByText(/Saved, but not active — requires/)).toBeTruthy();
    expect(screen.getAllByText(/worker_task_ir/).length).toBeGreaterThan(0);
    expect(screen.getByText("inactive", { exact: false })).toBeTruthy();

    // Kitos keturios vėliavos neturi inactive_reason — įspėjimo eilutė matoma tik VIENĄ kartą.
    const warnings = screen.queryAllByText(/Saved, but not active/);
    expect(warnings.length).toBe(1);
  });

  it("telemetrijos lūžis nepaslepia vėliavų", async () => {
    vi.mocked(api.fetchCompression).mockResolvedValue(
      view({
        degraded: ["context-size.jsonl: not found"],
        telemetry: { sample_count: 0, exceeded_count: 0, ir_compared_count: 0, ir_smaller_count: 0 },
        // Be telemetrijos serveris verdiktą ATSISAKO — puslapis tai ištaria, ne nutyli.
        decision: {
          pressure: { level: "insufficient" },
          recommendations: [
            { key: "worker_task_ir", action: "insufficient", reason: "too-few-ir-comparisons" },
            { key: "compact_dsl", action: "unmeasured", reason: "no-shadow-measurement" },
            { key: "symbol_slices", action: "unmeasured", reason: "no-shadow-measurement" },
            { key: "bash_output_digest", action: "unmeasured", reason: "no-shadow-measurement" },
            { key: "dispatch_tool_schema", action: "unmeasured", reason: "no-shadow-measurement" },
          ],
        },
      }),
    );
    render(<CompressionPage activeRoute="compression" onNavigate={noop} />);

    await waitFor(() => expect(screen.getByLabelText("worker_task_ir")).toBeTruthy());
    expect(screen.getByText(/context-size\.jsonl: not found/)).toBeTruthy();
    expect(screen.getByText(/Too few samples to judge data pressure/)).toBeTruthy();
    expect(screen.getByText("Not enough data")).toBeTruthy();
  });
});
