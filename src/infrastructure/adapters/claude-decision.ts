// Claude sprendimo (decision) JSON ekstrakcija ir tipai (etalonas: AG_loop core/decision.ts
// + claude-headless.ts extractDecisionJson). Tipai gyvena prie parserio: vienintelis
// gamintojas yra headless atsakymas, o application vartotojai (run-coordinator-ports)
// kontraktą deklaruoja struktūriškai be importo — kryptis lieka švari.

export type ChildTask = {
  title?: string;
  claude_task?: string;
};

export type RetryDecision = {
  verdict?: string;
  task_id?: string;
  retry_key?: string;
  error_signature?: string;
  selected_model?: string;
  target_agent_chain?: string[];
  target_agent?: string;
  risk_level?: string;
  reason?: string;
  claude_task?: string;
  claude_repair_task?: string;
  child_tasks?: ChildTask[];
};

/** Decision JSON iš modelio atsakymo: grynas JSON, ```json fence arba pirmas {...} blokas. */
export function extractDecisionJson(text: string): RetryDecision {
  const trimmed = text.trim();

  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as RetryDecision;
    } catch {
      // krentam žemyn
    }
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim()) as RetryDecision;
    } catch {
      // krentam žemyn
    }
  }

  const braceStart = trimmed.indexOf("{");
  if (braceStart !== -1) {
    const braceEnd = trimmed.lastIndexOf("}");
    if (braceEnd > braceStart) {
      try {
        return JSON.parse(trimmed.slice(braceStart, braceEnd + 1)) as RetryDecision;
      } catch {
        // krentam žemyn
      }
    }
  }

  return {};
}
