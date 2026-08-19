// Vienas bendras execution-context fingerprint kontraktas producer'iui ir consumer'iui
// (2026-08-04 integracijos incidentas): rendereris rašė execution-context.md BE fingerprint
// antraštės, o dispatch gate jos reikalavo — dvi atskirai žalios pusės kartu užrakino
// KIEKVIENĄ dispatch'ą ("no fingerprint header" refuse). Antraštę stato assemble per
// buildExecutionContextMarker, o dispatch parsina per parseExecutionContextMetadata — abu
// iš ŠIO modulio, todėl kontraktas nebegali išsiskirti. Behaviour etalon: AG_loop
// application/context-pack/execution-context-fingerprint.ts (1:1, įsk. `ag:` markerio žymę
// — ji yra artefakto formato dalis, kurią pin'ina compact-dsl fixture).

import { createHash } from "node:crypto";

/** Execution context artefaktas, kurį renderina context-pack grandinė (task 1101). */
export const EXECUTION_CONTEXT_FILENAME = "execution-context.md";

/**
 * Fingerprint antraštė, kurią execution-context.md PRIVALO nešti, kad dispatch
 * galėtų įrodyti, jog kontekstas atitinka BŪTENT šį task'ą ir šį context-pack'ą:
 *
 * ```text
 * <!-- ag:execution-context task_id=1102-x task_sha256=<64hex> context_pack_sha256=<64hex> -->
 * ```
 */
export const EXECUTION_CONTEXT_MARKER = /<!--\s*ag:execution-context\s+([^>]*?)-->/;

export type ExecutionContextMetadata = {
  taskId?: string;
  taskSha256?: string;
  contextPackSha256?: string;
};

/**
 * Artefakto fingerprint: sha256 nuo normalizuoto teksto. Normalizuojami CRLF ir
 * uodegos tarpai, kad Windows/Linux checkout'as ar redaktoriaus pridėta nauja
 * eilutė nepaverstų galiojančio konteksto "neatitinkančiu".
 */
export function contextArtifactSha256(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n").replace(/\s+$/, ""), "utf8").digest("hex");
}

export function parseExecutionContextMetadata(markdown: string): ExecutionContextMetadata | undefined {
  const match = EXECUTION_CONTEXT_MARKER.exec(markdown);
  if (!match) {
    return undefined;
  }
  const fields = new Map<string, string>();
  for (const pair of (match[1] ?? "").trim().split(/\s+/)) {
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    fields.set(pair.slice(0, separator), pair.slice(separator + 1).replace(/^"(.*)"$/, "$1"));
  }
  const taskId = fields.get("task_id");
  const taskSha256 = fields.get("task_sha256");
  const contextPackSha256 = fields.get("context_pack_sha256");
  return {
    ...(taskId === undefined ? {} : { taskId }),
    ...(taskSha256 === undefined ? {} : { taskSha256 }),
    ...(contextPackSha256 === undefined ? {} : { contextPackSha256 }),
  };
}

/**
 * Sudeda fingerprint antraštės eilutę iš pačių artefaktų tekstų. Producer'is
 * NIEKADA nerašo hash reikšmių ranka — jos visada skaičiuojamos tuo pačiu
 * contextArtifactSha256, kurį dispatch naudoja tikrindamas.
 */
export function buildExecutionContextMarker(input: {
  taskId: string;
  taskText: string;
  contextPackText: string;
}): string {
  const taskSha = contextArtifactSha256(input.taskText);
  const packSha = contextArtifactSha256(input.contextPackText);
  return `<!-- ag:execution-context task_id=${input.taskId} task_sha256=${taskSha} context_pack_sha256=${packSha} -->`;
}
