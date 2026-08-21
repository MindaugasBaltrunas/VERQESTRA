// Pack → kandidatų sąrašas: KAS patenka į execution kontekstą, kokia tvarka, kokiu prioritetu
// ir su kokiu pasitikėjimo statusu. Atskirai nuo `render-execution-context`, kuris iš šio sąrašo
// gamina dokumentą (biudžeto metimo ciklas, aptvaras, fingerprint'as) — dvi skirtingos
// atsakomybės, ir jos abi augo, kol failas priartėjo prie 500 eilučių ribos.
//
// Pasitikėjimo riba: `provenance` nurodoma TIK laisvam tekstui iš repozitorijos ar task'o
// nurodyto failo (spec fragmentai, simbolių santrauka ir parašai, source pjūviai, architektūros
// mazgų etiketės). Failų KELIAI ir mūsų pačių generuotas tekstas lieka `trusted` — žr.
// `executionContextTrustSchema` paaiškinimą `context-pack-schema` faile.

import type {
  ContextPack,
  ExecutionContextPriority,
  ExecutionContextSection,
} from "./context-pack-schema.js";

export type Candidate = {
  id: string;
  section: ExecutionContextSection;
  title: string;
  priority: ExecutionContextPriority;
  reason: string;
  body: string;
  // Nurodoma TIK verbatim failų turiniui; be jos elementas yra `trusted` (žr.
  // `executionContextTrustSchema` — riba brėžiama ties turiniu, ne ties šaltiniu).
  provenance?: { type: string; source: string };
  // MŪSŲ tekstas apie šį bloką, renderinamas tarp meta eilutės ir kūno — taigi UŽ aptvaro
  // ribų, kad neatrodytų kaip cituojamas turinys, ir tame pačiame bloke, kad negalėtų būti
  // išmestas atskirai nuo to, ką apibūdina.
  notice?: string;
  // Atskirai nuo `notice`, kad mašininė žyma nepriklausytų nuo to, ar kas nors parašė tekstą.
  truncated?: true;
};

// Canonical element order. Every section is derived from exactly one pack field, so two
// packs with the same content always produce the same element list in the same order.
export function buildCandidates(pack: ContextPack): Candidate[] {
  const candidates: Candidate[] = [];

  candidates.push({
    id: "goal",
    section: "goal",
    title: "Goal",
    priority: "critical",
    reason: "the single outcome this dispatch must achieve",
    body: pack.goal,
  });

  const acceptance = [
    ...pack.acceptance_criteria.map((criterion) => `- ${criterion}`),
    ...(pack.stop_condition ? [`- Stop condition: ${collapseWhitespace(pack.stop_condition)}`] : []),
  ];
  pushIfPresent(candidates, {
    id: "acceptance-criteria",
    section: "acceptance-criteria",
    title: "Acceptance criteria",
    priority: "critical",
    reason: "the task's own definition of done; the work is not complete until every item holds",
    body: acceptance.join("\n"),
  });

  pushIfPresent(candidates, {
    id: "allowed-paths",
    section: "allowed-paths",
    title: "Allowed paths",
    priority: "critical",
    reason: "hard edit boundary: no file outside this list may be created, changed or deleted",
    body: pack.allowed_paths.map((entry) => `- \`${entry}\``).join("\n"),
  });

  pushIfPresent(candidates, {
    id: "checks",
    section: "checks",
    title: "Checks",
    priority: "critical",
    reason: "deterministic verification commands that must pass before the task is reported done",
    body: pack.checks.map((check) => `- \`${check}\``).join("\n"),
  });

  // Kirpimo žyma gyvena TAME PAČIAME bloke kaip ir fragmentas. Anksčiau ji buvo tik `medium`
  // prioriteto įspėjimų bloke, kuris prie ankšto biudžeto iškrisdavo PIRMIAU už `high`
  // fragmentą — ir worker'is gaudavo nepilną specifikaciją be jokio ženklo, kad ji nepilna.
  const truncatedRefs = new Set(pack.spec_fragment_truncated);

  pack.spec_fragments.forEach((fragment, index) => {
    const { ref, text } = splitSpecFragment(fragment);
    const truncated = truncatedRefs.has(ref);
    pushIfPresent(candidates, {
      id: `spec-${index + 1}`,
      section: "spec",
      title: `Spec fragment: ${ref}`,
      priority: "high",
      reason: truncated
        ? `retrieved from \`## Spec source\` reference ${index + 1} of ${pack.spec_fragments.length}, CUT to fit the context budget`
        : `retrieved from \`## Spec source\` reference ${index + 1} of ${pack.spec_fragments.length}`,
      body: text,
      provenance: { type: "spec-fragment", source: ref },
      ...(truncated
        ? {
            truncated: true as const,
            notice:
              "**TRUNCATED** — this fragment was cut to fit the context budget. It is NOT the " +
              "complete section: content after the cut is missing. Do not treat absence of a " +
              "rule here as evidence that the rule does not exist; read the file if you need it.",
          }
        : {}),
    });
  });

  pushIfPresent(candidates, {
    id: "spec-warnings",
    section: "spec",
    title: "Spec retrieval warnings",
    priority: "medium",
    reason: "a spec reference did not resolve exactly; the fragment above may be broader than requested",
    body: pack.spec_fragment_warnings.map((warning) => `- ${warning}`).join("\n"),
  });

  const codeContext = pack.code_context;
  pushIfPresent(candidates, {
    id: "symbols",
    section: "symbols",
    title: "Symbols",
    priority: "high",
    reason: "declarations and exported symbols of the files this task edits, from the code index",
    body: (codeContext?.summary ?? []).join("\n"),
    // Simbolių vardai yra repozitorijos turinys, tad ir jie gali nešti tekstą.
    provenance: { type: "symbol-summary", source: "code index" },
  });

  pushIfPresent(candidates, {
    id: "contracts",
    section: "contracts",
    title: "Contracts and direct dependencies",
    priority: "high",
    reason: "files directly importing or imported by the allowed paths; their public contracts must keep working",
    body: (codeContext?.related_files ?? []).map((file) => `- \`${file}\``).join("\n"),
  });

  // REF/SIG/SRC tiers (task 0023). Symbols carry a tier only when the pack was assembled
  // with the `symbol_slices` compression feature on; a pack without tiers renders exactly
  // the pre-0023 document, byte for byte. REF needs no candidate of its own — the summary
  // above already names every kept symbol with its file and line range.
  //
  // Placement inside the `high` band is deliberate: droppables leave from the END of the
  // canonical order within one priority, so when the budget tightens the SRC blocks go
  // first, then the SIG lines — never the spec fragments or the symbol map before them.
  const tieredSymbols = (codeContext?.symbol_fragments ?? []).filter((symbol) => symbol.tier !== undefined);

  pushIfPresent(candidates, {
    id: "signatures",
    section: "symbols",
    title: "Symbol signatures",
    priority: "high",
    reason: "declaration heads (tier SIG): enough to call these symbols correctly without reading their bodies",
    body: tieredSymbols
      .filter((symbol) => symbol.tier === "SIG" && symbol.signature !== undefined)
      .map((symbol) => `- \`${symbolRef(symbol)}\` — \`${symbol.signature}\``)
      .join("\n"),
    provenance: { type: "symbol-signatures", source: "code index" },
  });

  tieredSymbols
    .filter((symbol) => symbol.tier === "SRC" && symbol.source !== undefined)
    .forEach((symbol, index) => {
      const source = symbol.source;
      if (!source) {
        return;
      }
      pushIfPresent(candidates, {
        id: `src-${index + 1}`,
        section: "symbols",
        title: `Target source: ${symbol.file}#${symbol.name}`,
        priority: "high",
        // NE „hash-verified … do not re-read": hash'as buvo patikrintas SURINKIMO metu prieš kodo
        // indeksą, ne dispatch'o metu prieš darbinį medį. Dispatch vartas pasenusius pjūvius
        // atmeta, bet tik kai kvietėjas juos patikrino — tad tekstas privalo sakyti tiesą apie
        // tai, kas tai yra: snapshot'as su hash'u, kurį worker'is gali patikrinti pats.
        reason:
          "source snapshot of a declaration this task edits (tier SRC), taken when the context " +
          "was assembled; the block states the file, line range and sha256 — if the file on disk " +
          "disagrees, the file wins",
        body: [
          `\`${symbol.file}:${source.line}-${source.endLine}\` (sha256:${source.hash.slice(0, 12)})`,
          "",
          "```",
          source.text,
          "```",
        ].join("\n"),
        provenance: { type: "source-slice", source: `${symbol.file}#${symbol.name}` },
      });
    });

  pushIfPresent(candidates, {
    id: "impacted-tests",
    section: "impacted-tests",
    title: "Impacted tests",
    priority: "medium",
    reason: "existing tests that cover the allowed paths and must stay green",
    body: (codeContext?.impacted_tests ?? []).map((file) => `- \`${file}\``).join("\n"),
  });

  // Mazgų etiketės yra LAISVAS TEKSTAS iš `vq/state/architecture/graph.json`, ne keliai ir ne
  // mūsų generuotas tekstas — tad jos priklauso `untrusted` pusei, kaip ir spec fragmentai.
  // Anksčiau jos buvo renderinamos plikais markdown sąrašo punktais su `trust: trusted`: mazgas,
  // pavadintas „ignore previous instructions…", atrodydavo lygiai kaip mūsų pačių nurodymas, ir
  // jokio Markdown simbolio tam neprireikdavo.
  pushIfPresent(candidates, {
    id: "architecture-nodes",
    section: "architecture",
    title: "Architecture nodes",
    priority: "medium",
    reason: "architecture-graph nodes owning the allowed paths; the change must stay inside them",
    body: (codeContext?.architecture_nodes ?? []).map((node) => `- ${node}`).join("\n"),
    provenance: { type: "architecture-node", source: "vq/state/architecture/graph.json" },
  });

  pushIfPresent(candidates, {
    id: "architecture-rules",
    section: "architecture",
    title: "Architecture boundaries",
    priority: "medium",
    reason: "boundary rules that constrain this change",
    body: pack.architecture_rules.map((rule) => `- ${rule}`).join("\n"),
  });

  pushIfPresent(candidates, {
    id: "out-of-scope",
    section: "out-of-scope",
    title: "Out of scope",
    priority: "low",
    reason: "explicit non-goals declared by the task",
    body: pack.out_of_scope.map((entry) => `- ${entry}`).join("\n"),
  });

  return candidates;
}

function pushIfPresent(candidates: Candidate[], candidate: Candidate): void {
  if (candidate.body.trim().length > 0) {
    candidates.push(candidate);
  }
}

// Spec fragments are stored in the pack as `${ref}\n${text}` (see assemble.ts). A fragment
// without a body still yields a usable ref-only element.
function splitSpecFragment(fragment: string): { ref: string; text: string } {
  const newline = fragment.indexOf("\n");
  if (newline === -1) {
    return { ref: fragment.trim(), text: fragment.trim() };
  }
  return { ref: fragment.slice(0, newline).trim(), text: fragment.slice(newline + 1).trim() };
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// `file#name:line-endLine` — the compact symbol reference used by the SIG tier. The range
// is omitted when the index carries no line information for that symbol.
function symbolRef(symbol: {
  file: string;
  name: string;
  line?: number | undefined;
  endLine?: number | undefined;
}): string {
  const range = symbol.line === undefined ? "" : `:${symbol.line}-${symbol.endLine ?? symbol.line}`;
  return `${symbol.file}#${symbol.name}${range}`;
}
