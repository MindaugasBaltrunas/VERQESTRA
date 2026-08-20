// Stream-json sesijos log'o skaitytojas — VIENINTELIS šio formato parserių namas E3+
// (etalono core/claude-headless.ts ekstrakcijos pusė; usage skaitikliai — E4, importuoja iš čia).
// Grynas tekstas → objektas: jokio IO.

/**
 * Paskutinio `"type":"result"` įvykio pilnas envelope iš stream-json log'o — marker
 * paieškai (žemiau), o vėliau usage ekstrakcijai ir limit/error klasifikacijai (E4).
 * Ne-JSON eilutės (stderr, launcher antraštės) tyliai praleidžiamos; skenuojama nuo GALO,
 * nes būtent paskutinis result envelope sumuoja visą dispatch sesiją.
 */
export function extractResultEnvelopeFromStreamJsonLog(logText: string): Record<string, unknown> | undefined {
  const lines = logText.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (!line.includes('"type":"result"')) {
      continue;
    }
    try {
      const outer = JSON.parse(line) as Record<string, unknown>;
      if (outer["type"] === "result") {
        return outer;
      }
    } catch {
      // dalinė/ne-JSON eilutė — ieškom toliau aukštyn
    }
  }
  return undefined;
}

/**
 * ALREADY_IMPLEMENTED markerio paieška vykdytojo log'e (etalono 1048/1049 pamoka):
 * markeris istoriškai tikrintas /^\s*ALREADY_IMPLEMENTED\b/m regex'u ant ŽALIO log'o —
 * bet dispatch log'as yra stream-json, kuriame sesijos tekstas gyvena JSON string'ų viduje
 * ir NIEKADA neprasideda eilutės pradžioje, todėl markeris nebuvo aptinkamas niekada.
 * Čia markeris papildomai ieškomas išparsintame result envelope (result laukas turi tikrus
 * newline'us). Plain-text šaka palikta seniems/ne-stream log'ams.
 *
 * Tai yra `DiagnosisRulesPort.hasAlreadyImplementedMarker` kanoninė implementacija.
 */
export function logHasAlreadyImplementedMarker(logText: string): boolean {
  if (!logText) return false;
  if (/^\s*ALREADY_IMPLEMENTED\b/m.test(logText)) return true;
  const envelope = extractResultEnvelopeFromStreamJsonLog(logText);
  const result = envelope && typeof envelope["result"] === "string" ? envelope["result"] : "";
  return /^\s*ALREADY_IMPLEMENTED\b/m.test(result);
}
