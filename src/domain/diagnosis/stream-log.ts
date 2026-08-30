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
 * Vykdytojo markerio paieška ta pačia DVIGUBA paieška visiems markeriams (etalono 1048/1049
 * pamoka): markeris istoriškai tikrintas eilutės-pradžios regex'u ant ŽALIO log'o — bet
 * dispatch log'as yra stream-json, kuriame sesijos tekstas gyvena JSON string'ų viduje ir
 * NIEKADA neprasideda eilutės pradžioje, todėl markeris nebuvo aptinkamas niekada. Čia
 * markeris papildomai ieškomas išparsintame result envelope (result laukas turi tikrus
 * newline'us). Plain-text šaka palikta seniems/ne-stream log'ams.
 *
 * `marker` privalo būti be `g` vėliavos — `RegExp.test` su `g` neša `lastIndex` būseną tarp
 * kvietimų ir tas pats log'as duotų skirtingus atsakymus.
 */
function logHasLineStartMarker(logText: string, marker: RegExp): boolean {
  if (!logText) return false;
  if (marker.test(logText)) return true;
  const envelope = extractResultEnvelopeFromStreamJsonLog(logText);
  const result = envelope && typeof envelope["result"] === "string" ? envelope["result"] : "";
  return marker.test(result);
}

// `(?:[*_`]{1,3})?` — markdown įvyniojimo tolerancija (2026-08-30, task 072 antras bėgimas):
// vykdytojas markerį parašė `**ALREADY_IMPLEMENTED**:` ir eilutės-pradžios regex jo nebematė —
// sąžiningas ALREADY_IMPLEMENTED su įrodymais parkavosi human-review. Tolerancija neatlaisvina
// vartų: dispozicija tebereiklauja antro, NEPRIKLAUSOMO įrodymo (no-writes + švarus medis).
const ALREADY_IMPLEMENTED_MARKER = /^\s*(?:[*_`]{1,3})?ALREADY_IMPLEMENTED\b/m;

const AUDIT_COMPLETE_MARKER = /^\s*(?:[*_`]{1,3})?AUDIT_COMPLETE\b/m;

/**
 * Tai yra `DiagnosisRulesPort.hasAlreadyImplementedMarker` kanoninė implementacija:
 * „darbo nedariau, nes jis jau buvo padarytas".
 */
export function logHasAlreadyImplementedMarker(logText: string): boolean {
  return logHasLineStartMarker(logText, ALREADY_IMPLEMENTED_MARKER);
}

/**
 * Task 095: sėkmingas auditas, kuris nieko taisytino neranda, iki šiol negalėjo užsidaryti kaip
 * done — commit'o nėra (nėra ko keisti), o ALREADY_IMPLEMENTED jo deliverable neatitinka
 * SEMANTIŠKAI: audito užduotis nebuvo „jau įgyvendinta", ji buvo ĮVYKDYTA, o jos rezultatas —
 * ataskaita, kad radinių nėra. Toks bėgimas parkuodavosi human-review.
 *
 * `AUDIT_COMPLETE: <santrauka>` yra atskiras vykdytojo žodis būtent tam atvejui. Kaip ir
 * ALREADY_IMPLEMENTED, jis vienas nieko neuždaro — dispozicijos pusėje
 * (`resolveNoCommitDisposition`) reikalaujamas antras, NEPRIKLAUSOMAS įrodymas.
 */
export function logHasAuditCompleteMarker(logText: string): boolean {
  return logHasLineStartMarker(logText, AUDIT_COMPLETE_MARKER);
}
