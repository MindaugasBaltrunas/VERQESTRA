// Claude CLI įrankių schemų argumentai ir dispatch tool auditas (etalonas: AG_loop
// core/claude-headless.ts tool pusė; task 0028). `--disallowed-tools` su plikais vardais
// pašalina įrankio schemą IŠ KONTEKSTO — o kontekstas replay'inamas kiekviename turn'e,
// tad kiekvienas pašalintas tokenas taupo kartotinai (2026-08-06 auditas: preflight
// cache_creation ~38–40k tokenų, iš kurių prompt'as tik ~6k).

/**
 * Įrankiai, kurių semantinė peržiūra (preflight, diagnozė) NETURI naudoti pagal savo
 * pačios prompt'ą. Skaitymo įrankiai (Read/Glob/Grep) SĄMONINGAI paliekami: peržiūra
 * turi galėti pasitikrinti faktus repo medyje.
 */
export const SEMANTIC_REVIEW_DISALLOWED_TOOLS = [
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
  "Task",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
] as const;

/** `--disallowed-tools` argumentai; tuščias masyvas, kai ribojimas išjungtas. */
export function claudeDisallowedToolsArgs(disallowTools: boolean | undefined): string[] {
  return disallowTools === true ? ["--disallowed-tools", SEMANTIC_REVIEW_DISALLOWED_TOOLS.join(",")] : [];
}

/**
 * Grynas `--max-turns` argumentų builderis: tik teigiamas sveikas skaičius virsta flag'u.
 * Validacija čia pat, nes win32 kelias reikšmę interpoliuoja į PowerShell komandos eilutę.
 */
export function claudeMaxTurnsArgs(maxTurns?: number): string[] {
  return typeof maxTurns === "number" && Number.isInteger(maxTurns) && maxTurns > 0
    ? ["--max-turns", String(maxTurns)]
    : [];
}

/**
 * Įrankiai, be kurių dispatch worker'is negali atlikti savo darbo. Sąrašas yra GRINDYS,
 * ne leidimų sąrašas: nieko neįjungia, tik neleidžia pašalinti. `PowerShell` — Windows
 * harness'o shell (tas pats vaidmuo kaip `Bash`).
 */
export const DISPATCH_BASELINE_TOOLS = [
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "MultiEdit",
  "NotebookEdit",
  "PowerShell",
  "Read",
  "Write",
] as const;

/** Vieno dispatch'o įrankių pjūvis iš stream-json log'o. */
export type DispatchToolUsage = {
  /**
   * Ar log'as atpažintas kaip stream-json (bent viena eilutė su `type`). `false` reiškia
   * „NĖRA DUOMENŲ", NE „įrankiai nenaudoti" — nutrūkusi ar svetimo formato sesija negali
   * pateisinti nė vienos schemos pašalinimo.
   */
  parsed: boolean;
  /** Unikalūs `tool_use` įvykiai (streaming dublikatai suskaičiuojami vieną kartą). */
  events: number;
  /** Eilutės, kurios atrodė kaip įvykiai, bet neišsiparsino. */
  unknownEvents: number;
  /** `system`/`init` paskelbti PRIEINAMI įrankiai (TOS sesijos matavimas, ne įvestis). */
  offered: string[];
  /** Pagrindinės sesijos naudoti įrankiai (`parent_tool_use_id` nėra). */
  mainUsed: string[];
  /** Agent/`Task` sub-sesijų naudoti įrankiai — atskira kohorta. */
  agentUsed: string[];
  /** `mainUsed` ∪ `agentUsed`. */
  used: string[];
};

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Įrankių naudojimo pjūvis iš stream-json log'o. Kohortos atskyrimas —
 * `parent_tool_use_id`: įvykis, gimęs `Task` sub-agento viduje, jį turi; būtent dėl to
 * `Task` niekada nešalinamas vien todėl, kad pagrindinė sesija jo nekvietė.
 */
export function extractDispatchToolUsage(logText: string): DispatchToolUsage {
  const offered: string[] = [];
  const mainUsed: string[] = [];
  const agentUsed: string[] = [];
  const seenEventIds = new Set<string>();
  let parsedEvents = 0;
  let unknownEvents = 0;
  let anonymousEvents = 0;

  for (const rawLine of logText.split(/\r?\n/)) {
    const line = rawLine.trim();
    // Launcher antraštės ir stderr NĖRA įvykiai — jų skaičiavimas kaip „nežinomų"
    // paverstų kiekvieną normalų log'ą įtartinu.
    if (!line.startsWith("{")) continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      unknownEvents += 1;
      continue;
    }
    if (typeof event["type"] !== "string") {
      unknownEvents += 1;
      continue;
    }
    parsedEvents += 1;

    if (event["type"] === "system" && event["subtype"] === "init" && Array.isArray(event["tools"])) {
      for (const tool of event["tools"]) {
        if (typeof tool === "string" && tool.trim()) offered.push(tool.trim());
      }
    }

    const message = event["message"] as { content?: unknown } | undefined;
    const content = message && Array.isArray(message.content) ? message.content : undefined;
    if (!content) continue;

    const parentToolUseId = event["parent_tool_use_id"];
    const fromAgent = typeof parentToolUseId === "string" && parentToolUseId.trim().length > 0;

    for (const rawBlock of content) {
      if (typeof rawBlock !== "object" || rawBlock === null) continue;
      const block = rawBlock as Record<string, unknown>;
      if (block["type"] !== "tool_use") continue;
      const name = typeof block["name"] === "string" ? block["name"].trim() : "";
      if (!name) continue;
      // Tas pats `tool_use` pasirodo ir streaming, ir galutiniame `assistant` įvykyje —
      // id yra vienintelis būdas nesuskaičiuoti jo dukart.
      const id = typeof block["id"] === "string" ? block["id"] : "";
      if (id) {
        if (seenEventIds.has(id)) continue;
        seenEventIds.add(id);
      } else {
        anonymousEvents += 1;
      }
      (fromAgent ? agentUsed : mainUsed).push(name);
    }
  }

  const main = sortedUnique(mainUsed);
  const agent = sortedUnique(agentUsed);
  return {
    parsed: parsedEvents > 0,
    events: seenEventIds.size + anonymousEvents,
    unknownEvents,
    offered: sortedUnique(offered),
    mainUsed: main,
    agentUsed: agent,
    used: sortedUnique([...main, ...agent]),
  };
}

/**
 * Ar pjūvis yra tinkamas ĮRODYMAS: atpažintas formatas IR bent vienas įvykis. Tyli sesija
 * gali reikšti nukirstą log'ą — ji niekada nevirsta sprendimu „šito nereikia".
 */
export function hasDispatchToolEvidence(usage: DispatchToolUsage): boolean {
  return usage.parsed && usage.events > 0;
}

/**
 * `tool-budget.json` profilio sprendimas apie įrankių šeimas. `false` = biudžetas šeimą
 * JAU draudžia; `true`/`undefined` = leidžia, ir tada schemos nešalinamos (šis modulis
 * politikos nekuria, tik ją vykdo).
 */
export type DispatchToolPolicyDecision = {
  browser?: boolean;
  scraper?: boolean;
  mcp?: boolean;
};

/**
 * Web/research/MCP kandidatai iš biudžeto profilio. Dinaminiai `mcp__*` vardai imami TIK
 * iš deterministinio task-lokalaus pjūvio (task 0041 — context-pack
 * mcp-capability-registry); `known:false` = „nežinau" ir NIEKADA nevirsta kandidatu —
 * fail-open į pilnas schemas.
 */
export function dispatchDisallowedToolCandidates(
  policy: DispatchToolPolicyDecision,
  mcp: { known: boolean; tools: readonly string[] },
): string[] {
  const candidates: string[] = [];
  if (policy.browser === false) candidates.push("WebSearch");
  if (policy.scraper === false) candidates.push("WebFetch");
  if (policy.mcp === false && mcp.known) {
    for (const tool of mcp.tools) {
      if (tool.startsWith("mcp__")) candidates.push(tool);
    }
  }
  return sortedUnique(candidates);
}

/**
 * Saugus įrankio vardas. Sąrašas keliauja į CLI kaip VIENA kableliais atskirta reikšmė,
 * tad vardas su kableliu (ar tarpu) leistų stebimam `init` sąrašui apeiti grindis.
 */
const SAFE_TOOL_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Galutinis dispatch `--disallowed-tools` sąrašas: kandidatai MINUS grindys
 * ({@link DISPATCH_BASELINE_TOOLS} + kvietėjo agentų maršrutizavimo įrankiai).
 */
export function buildDispatchDisallowedTools(input: {
  candidates: readonly string[];
  protectedTools?: readonly string[];
}): string[] {
  const floor = new Set<string>([...DISPATCH_BASELINE_TOOLS, ...(input.protectedTools ?? [])]);
  return sortedUnique(
    input.candidates.map((tool) => tool.trim()).filter((tool) => SAFE_TOOL_NAME.test(tool) && !floor.has(tool)),
  );
}

/** `--disallowed-tools` argumentai iš aiškaus sąrašo; tuščias sąrašas — jokio flag'o. */
export function claudeDispatchDisallowedToolsArgs(tools: readonly string[] = []): string[] {
  return tools.length > 0 ? ["--disallowed-tools", tools.join(",")] : [];
}

/**
 * Ar procesas krito dėl NEATPAŽINTO flag'o (o ne dėl modelio atsakymo). Tada ribojimas
 * nuimamas ir kvietimas kartojamas vieną kartą — pigus kelias bandomas, bet niekada
 * netampa vienintelis. Tą patį fallback kontraktą privalo turėti ir dispatch kelias.
 */
export function isUnknownFlagFailure(result: { code: number; stderr: string; stdout: string }): boolean {
  if (result.code === 0) return false;
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return output.includes("unknown option") || output.includes("unknown argument") || output.includes("unrecognized");
}
