// Agentų vaidmenų modelis — formalizuoja task'o `## Agentai` lauką į valdymo kontraktą:
// role -> leistini execution adapteriai + numatytasis model hint. Grandinės skaidymo
// taisyklės (istoriškai 4 vietos su 3 nesuderinamomis separator taisyklėmis — DUP-04)
// inline'intos čia kaip VIENINTELIS šaltinis (WBR VQ-203). Sekcijos ekstrakcija — per
// shared/markdown extractSection (FQC-12: vienas section extractor visame repo).
// Behaviour etalon: AG_loop domain/policies/agent-selection.ts + core/agent-chain.ts.

import { extractSection } from "../../shared/markdown.js";

export type AgentModelHint = "haiku" | "sonnet" | "opus";
export type AgentAdapterKind = "dry-run" | "codex" | "claude";

export type AgentRoleConfig = {
  allowed_adapters: AgentAdapterKind[];
  default_model_hint: AgentModelHint;
  can_write_code: boolean;
  // `| undefined` eksplicitiškai: zod optional() inferuoja būtent šią formą, o su
  // exactOptionalPropertyTypes siauresnis tipas neleistų schema rezultato (E3 loader).
  enabled?: boolean | undefined;
  max_attempts?: number | undefined;
  requires_human_review_for_global_changes?: boolean | undefined;
};

export type AgentPolicy = {
  version: string;
  default_role: string;
  roles: Record<string, AgentRoleConfig>;
};

export type AgentSelection = {
  primary?: string;
  supporting: string[];
  adapter?: string;
  model_hint?: string;
};

export const MODEL_HINTS: AgentModelHint[] = ["haiku", "sonnet", "opus"];
export const ADAPTERS: AgentAdapterKind[] = ["dry-run", "codex", "claude"];

// --- Grandinės skaidymas (buvęs core/agent-chain.ts) ---------------------------------

/** Separatoriai: ASCII `->`, unicode `→`, kablelis, newline (`->` prieš `→` sąmoningai). */
const CHAIN_SEPARATOR = /->|→|,|\r?\n/;

/** Leading markdown bullet (`- ` / `* `) stripped from a chain token. */
const BULLET_PREFIX = /^[-*]\s+/;

/** Markdown emfazė aplink agento vardą (`` `coder` ``, `**coder**`, `_coder_`). */
const EMPHASIS_WRAPPER = /^[`*_]+|[`*_]+$/g;

/**
 * Sakinio skirtukas, nuo kurio prasideda PROZA po grandinės (`.`/`;`/`(`). Dvitaškis
 * SĄMONINGAI neįtrauktas: jis yra etiketės skirtukas, po kurio eina pats agentas.
 */
const TRAILING_PROSE = /[.;(].*$/s;

/**
 * VEDANTI etiketė iki paskutinio dvitaškio — „privaloma grandinė šia tvarka: readme-guard"
 * pirmas agentas yra `readme-guard`, o ne keturi prozos žodžiai. Iki task 138 deklaruota
 * intencija (žr. TRAILING_PROSE komentarą) neturėjo implementacijos: legacy šaka segmentą
 * dar skaidė per whitespace, ir UI grandinė rodė čipus „privaloma", „grandinė", „šia",
 * „tvarka:" (2026-09-01 gyvas incidentas 097 dispatch'e).
 */
const LEADING_LABEL = /^.*:\s*/s;

export const DEFAULT_AGENT_CHAIN_SEPARATOR = " -> ";

/**
 * Agento vardo forma: `[a-z-]`, kartais su skaičiais/underscore (registro role raktai).
 * Naudojama TIK kaip apsauga `splitBareRoleLine` viduje — realūs lietuviški sakiniai beveik
 * visada turi bent vieną žodį su diakritiku arba kitu ne-ASCII simboliu, tad šis testas
 * atskiria istorinį „coder reviewer tester" bare-list formatą nuo prozos.
 */
const BARE_ROLE_WORD = /^[a-z][a-z0-9_-]*$/i;

/** Kiek žodžių dar laikoma tikėtinu bare-list, o ne pasiklydusiu sakiniu be skyrybos. */
const MAX_BARE_ROLE_WORDS = 8;

/**
 * Task 138 (2026-09-01 incidentas): `parseAgentBlock` legacy šaka po `parseAgentChain`
 * DAR skaidė kiekvieną segmentą per whitespace, kad išsaugotų istorinį „coder reviewer
 * tester" (role'ai atskirti tik tarpais, be strėlių/kablelių) formatą. Bet tas pats
 * whitespace-split tiek pat entuziastingai išskaidydavo IR pilną prozos sakinį be
 * strėlių („readme-guard eina pirmas ir grąžina ribų santrauką.") į vieną „vaidmenį" už
 * kiekvieną žodį — UI grandinė rodydavo čipus iš sakinio žodžių.
 *
 * Sprendimas: whitespace-split taikomas TIK kai VISI segmento žodžiai jau atrodo kaip
 * role vardai (žr. `BARE_ROLE_WORD`) ir jų nedaug (`MAX_BARE_ROLE_WORDS`). Kitaip segmentas
 * grąžinamas nepaliestas kaip vienas tokenas — jis vėliau tiesiog nepataikys į registrą
 * (`knownRoles`), bet nebeišgimdys N prozos čipų.
 */
function splitBareRoleLine(segment: string): string[] {
  const words = segment.split(/\s+/).filter((word) => word.length > 0);
  if (words.length <= 1 || words.length > MAX_BARE_ROLE_WORDS) return [segment];
  return words.every((word) => BARE_ROLE_WORD.test(word)) ? words : [segment];
}

/** Skaido žalią `## Agentai` grandinę į tokenus (verbatim, be case foldingo). */
export function parseAgentChain(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(CHAIN_SEPARATOR)
    .map((token) =>
      token.trim().replace(BULLET_PREFIX, "").replace(LEADING_LABEL, "").replace(EMPHASIS_WRAPPER, "").replace(TRAILING_PROSE, "").trim(),
    )
    .filter((token) => token.length > 0);
}

/** Serializuoja grandinę atgal į vieno separatoriaus tekstą; tušti tokenai numetami. */
export function serializeAgentChain(chain: string[], separator: string = DEFAULT_AGENT_CHAIN_SEPARATOR): string {
  return chain.filter((token) => token.trim().length > 0).join(separator);
}

// --- `## Agentai` bloko parsinimas ----------------------------------------------------

/**
 * Parsina task'o `## Agentai` bloką: legacy forma (eilutės su role vardais, pirmas =
 * primary), `key: value` laukai (primary/supporting/adapter/model_hint) ir grandinės
 * su strėlėmis. Grąžina struktūruotą AgentSelection.
 */
export function parseAgentBlock(taskText: string): AgentSelection {
  const section = extractSection(taskText, "## Agentai");
  const selection: AgentSelection = { supporting: [] };
  if (!section) return selection;

  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.replace(/^[-*]\s+/, "").trim();
    if (!line) continue;

    const kv = line.match(/^([a-z_]+)\s*:\s*(.+)$/i);
    const kvKey = kv?.[1];
    const kvValue = kv?.[2];
    if (kvKey !== undefined && kvValue !== undefined) {
      const key = kvKey.toLowerCase();
      const val = kvValue.trim();
      if (key === "primary") selection.primary = roleToken(val);
      else if (key === "supporting") selection.supporting.push(...val.split(/[,\s]+/).map(roleToken).filter(Boolean));
      else if (key === "adapter" || key === "adapter_policy") selection.adapter = val.toLowerCase();
      else if (key === "model_hint" || key === "model_policy_hint" || key === "model_policy") selection.model_hint = val.toLowerCase();
      continue;
    }

    // Legacy: bare role token(s), gali būti grandinė su strėlėmis. Pirmas = primary,
    // likę = supporting; whitespace-split (žr. splitBareRoleLine) išsaugo istorinį
    // „role role role" formatą, bet nebeišskaido prozos sakinio į žodžius (task 138).
    for (const token of parseAgentChain(line).flatMap(splitBareRoleLine).map(roleToken).filter(Boolean)) {
      if (!selection.primary) selection.primary = token;
      else selection.supporting.push(token);
    }
  }
  return selection;
}

function roleToken(value: string): string {
  return value.trim().toLowerCase().replace(/[`"']/g, "");
}

function selectionRoles(selection: AgentSelection): string[] {
  return [selection.primary, ...selection.supporting].filter((role): role is string => Boolean(role));
}

function knownRoles(selection: AgentSelection, policy: AgentPolicy): string[] {
  return selectionRoles(selection).filter(
    (role) => Object.prototype.hasOwnProperty.call(policy.roles, role) && policy.roles[role]?.enabled !== false,
  );
}

/**
 * Efektyvus pirminis vaidmuo: pirmas registre žinomas NE-readme-guard vaidmuo (guard yra
 * privalomas pirmas gate'as, ne darbą atliekantis vaidmuo), kitaip registry default_role.
 */
export function effectiveAgentRole(selection: AgentSelection, policy: AgentPolicy): string {
  const known = knownRoles(selection, policy);
  return known.find((role) => role !== "readme-guard") ?? known[0] ?? policy.default_role;
}

/**
 * Validuoja `## Agentai` bloką lanksčiai: bent vienas REGISTRE žinomas vaidmuo (proza su
 * role vardu — ok; vien nežinomi tokenai — atmesti); eksplicitinis adapteris turi būti
 * leistinas efektyviam vaidmeniui. Klaidų tekstai — baitinis kontraktas.
 */
export function validateAgentSelection(selection: AgentSelection, policy: AgentPolicy): string[] {
  const errors: string[] = [];
  const roles = selectionRoles(selection);
  const known = knownRoles(selection, policy);

  if (roles.length === 0) {
    errors.push("## Agentai: nenurodytas joks vaidmuo");
  } else if (known.length === 0) {
    errors.push(`## Agentai: nerasta žinomo vaidmens (${roles.join(", ")})`);
  }

  const firstKnown = known[0];
  if (selection.adapter && selection.adapter !== "auto") {
    if (!ADAPTERS.includes(selection.adapter as AgentAdapterKind)) {
      errors.push(`## Agentai: nežinomas adapter '${selection.adapter}'`);
    } else if (
      firstKnown !== undefined &&
      !(policy.roles[firstKnown]?.allowed_adapters ?? []).includes(selection.adapter as AgentAdapterKind)
    ) {
      errors.push(`## Agentai: adapter '${selection.adapter}' neleistinas vaidmeniui '${firstKnown}'`);
    }
  }
  return errors;
}

/** Numatytasis model hint efektyviam vaidmeniui (arba registry default_role). */
export function resolveAgentModelHint(selection: AgentSelection, policy: AgentPolicy): AgentModelHint {
  if (selection.model_hint && MODEL_HINTS.includes(selection.model_hint as AgentModelHint)) {
    return selection.model_hint as AgentModelHint;
  }
  return policy.roles[effectiveAgentRole(selection, policy)]?.default_model_hint ?? "sonnet";
}
