// `preflight` CLI adapteris (etalonas: interfaces/cli/preflight/index.ts). Komanda valdo TIK
// išvestį — visas verdiktas gyvena application/quality-gates evaluatePreflight, o efektai
// (task failo rezoliucija, politikų krovimas, sprendimo persistavimas) ateina per
// PreflightPorts, kuriuos suriša kompozicija.
//
// Tai NE `claude-preflight`: ta komanda (2/5-b) varo LLM supervizoriaus grandinę, o ši yra
// deterministinis vartas prieš task'ą.

import {
  evaluatePreflight,
  type PreflightDecision,
  type PreflightPorts,
} from "../../../application/quality-gates/preflight.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type PreflightEvaluator = (
  ports: PreflightPorts,
  args: string[],
  projectRoot: string,
) => Promise<PreflightDecision>;

export type PreflightCommandDeps = {
  ports: PreflightPorts;
  projectRoot: string;
  /**
   * Use case'o portas (default — realus `evaluatePreflight`). Ta pati konvencija kaip
   * `context-pack` komandoje: renderis testuojamas be pilno politikų pasaulio.
   */
  evaluate?: PreflightEvaluator;
  io?: CliIo;
};

export async function preflightCommand(deps: PreflightCommandDeps, args: string[] = []): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const evaluate = deps.evaluate ?? evaluatePreflight;
    const decision = await evaluate(deps.ports, args, deps.projectRoot);

    io.out(`preflight: ${decision.verdict}`);
    if (decision.classification) {
      io.out(
        `classification: ${decision.classification.categories.join(",")} (${decision.classification.sensitivity})`,
      );
      io.out(`model_hint: ${decision.classification.model_policy_hint}`);
      for (const hint of decision.classification.review_routing_hints) io.out(`review_hint: ${hint}`);
    }
    io.out(`token_budget: ${decision.token_budget.tier}`);
    io.out(`token_budget_model_hint: ${decision.token_budget.model_policy_hint}`);
    if (decision.human_review) {
      for (const gate of decision.human_review.gates) io.out(`human_review_gate: ${gate.category}`);
    }
    if (decision.split_plan) {
      io.out(`split_plan: ${decision.split_plan.parts} parts`);
    }
    for (const reason of decision.reasons) io.out(`reason: ${reason}`);

    return decision.verdict === "pass" ? 0 : 1;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
