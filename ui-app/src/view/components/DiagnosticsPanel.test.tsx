import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DashboardData } from "../../model/types";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { TokenBudgetPanel } from "./TokenBudgetPanel";

/**
 * 2026-08-24, operatoriaus nurodymas: „taisyk taip, kad viskas būtų matoma ir veiktų."
 *
 * Šie testai pin'ina, kad laukai, kuriuos serveris siunčia nuo pirmo audito rato, REALIAI pasiekia
 * ekraną. Iki šio rato jie buvo skaičiuojami, serializuojami ir numetami kas 30 s — o `token_budget`
 * buvo brangiausias iš jų, nes jis vienintelis atsako, kodėl dispatch'as pristabdytas.
 */

const base: DashboardData = {
  root: "/repo",
  currentTaskId: null,
  currentTaskFile: null,
  claudeExit: null,
  stableRef: null,
  stopStatus: {},
  decision: {},
  supervisorResume: {},
  claudeResume: {},
  runtime: [],
  claudeLogUpdatedAt: null,
  claudeLogBytes: null,
  workflowBuckets: [],
};

describe("DiagnosticsPanel", () => {
  it("rodo būsenos failus, log antspaudą ir tęsimo taškus", () => {
    render(
      <DiagnosticsPanel
        data={{
          ...base,
          claudeLogUpdatedAt: "2026-08-24T10:00:00.000Z",
          claudeLogBytes: 4096,
          claudeLogSource: "legacy",
          supervisorResume: { status: "verified" },
          claudeResume: { status: "running", next_action: "quality-gates" },
          statusFiles: [
            { name: "current-task-id", present: true, bytes: 12, updatedAt: "2026-08-24T09:00:00.000Z" },
            { name: "claude-resume.json", present: false },
          ],
        }}
      />,
    );

    expect(screen.getByText("current-task-id")).toBeInTheDocument();
    // Nesamas failas LIEKA sąraše ir pavadinamas: jo nebuvimas yra faktas, ne tuštuma.
    expect(screen.getByText("claude-resume.json")).toBeInTheDocument();
    expect(screen.getByText("missing")).toBeInTheDocument();
    // Log kilmė matoma: `legacy` antspaudas gali priklausyti KITAM task'ui.
    expect(screen.getByText("legacy")).toBeInTheDocument();
    expect(screen.getByText("quality-gates")).toBeInTheDocument();
  });

  it("stack sprendimas su human-review reikalavimu rodo PRIEŽASTĮ", () => {
    render(
      <DiagnosticsPanel
        data={{
          ...base,
          controlPlane: {
            config_controls: [
              { id: "auto_push_enabled", label: "Auto push", value: false, source: "vq/config/git.json", editable: true },
            ],
            human_review_tasks: [],
            learning_recommendations: [],
            learning_summary: {
              records: 0,
              by_type: {},
              pending_recommendations: 0,
              approved_recommendations: 0,
              rejected_recommendations: 0,
            },
            stack_decision: {
              selected_language: "typescript",
              selected_framework: null,
              architecture_style: "hexagonal",
              confidence: "low",
              human_review_required: true,
              reason: "README neįvardija karkaso",
            },
          },
        }}
      />,
    );

    expect(screen.getByText("typescript")).toBeInTheDocument();
    expect(screen.getByRole("status").textContent).toContain("README neįvardija karkaso");
    // Automatikos politika irgi matoma — iki šio rato `config_controls` neturėjo NĖ VIENOS panelės.
    expect(screen.getByText("Auto push")).toBeInTheDocument();
  });
});

describe("TokenBudgetPanel", () => {
  it("be verdikto sako TAI, o ne rodo melagingus nulius", () => {
    render(<TokenBudgetPanel budget={undefined} />);
    // Be `I18nProvider` `t()` grąžina raktą — tai numatytoji anglų kalba, ne trūkstamas vertimas.
    expect(screen.getByText("The budget gates have not recorded a verdict yet.")).toBeInTheDocument();
  });

  it("atmestas biudžetas rodo priežasčių KODUS, o ne perpasakojimą", () => {
    render(
      <TokenBudgetPanel
        budget={{
          budget_enforcement: {
            ok: false,
            billable_tokens: 120_000,
            total_llm_calls: 9,
            limits: { max_llm_calls: null, max_total_llm_calls: 10, max_total_tokens: 100_000 },
            reasons: ["max_total_tokens_exceeded"],
          },
        }}
      />,
    );

    // Kodas rodomas nepakeistas: būtent jo ieškoma žurnale ir snapshot'e.
    expect(screen.getByText("max_total_tokens_exceeded")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("`null` riba reiškia neribotą, o ne nulį", () => {
    render(
      <TokenBudgetPanel
        budget={{ llm_call_authorization: { allowed: true, remaining_total_tokens: null, phase: "implementation" } }}
      />,
    );

    expect(screen.getAllByText("unlimited").length).toBeGreaterThan(0);
    expect(screen.getByText("implementation")).toBeInTheDocument();
  });
});
