// Kompresijos konfigo digest'as — kanoninė forma TRANSKRIBUOTA, ne importuota.
//
// Benchmark paketas (AG/benchmark) sąmoningai nėra orkestratoriaus priklausomybė, todėl
// algoritmas, kuriuo saugomas digest'as buvo pagamintas, čia perrašytas iš etalono
// `AG/benchmark/src/domain/baseline/canonical-json.ts`. Jis TYČIA nesutampa su
// `shared/json.ts#canonicalJsonStringify`: čia tekstas normalizuojamas (CRLF→LF, NFC),
// masyvo skylė yra klaida (ne `null`), o `-0` sulyginamas su `0` — bet koks dreifas
// paverstų kiekvieną digest'o palyginimą užtikrintai klaidingu, o tai blogiau nei jokio
// palyginimo. Elgesio etalonas: AG_loop
// application/release-readiness/compression-quality-check.ts (kanoninės formos pusė).

import { sha256Hex } from "../../shared/hash.js";

/** Veidrodis benchmark paketo `COMPRESSION_CONFIG_PROJECTION_VERSION`. */
export const COMPRESSION_CONFIG_PROJECTION_VERSION = 2;

/**
 * Veidrodis benchmark paketo `COMPRESSION_CONFIG_SOURCE` — digest'o TAPATYBĖS dalis, ne
 * failo skaitymo kelias. Saugomi sidecar įrašai šitą eilutę neša viduje, tad ji privalo
 * sutapti baitas į baitą su tuo, ką rašo benchmark'as, nors realus dokumentas VERQESTRA
 * medyje gyvena `vq/config/context-compression.json`.
 */
export const COMPRESSION_CONFIG_SOURCE = "AG/config/context-compression.json";

function normalizeCanonicalText(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

function renderCanonical(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(normalizeCanonicalText(value));
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`Cannot canonicalize the non-finite number ${value}.`);
      }
      // `-0` ir `0` yra ta pati reikšmė ir negali hash'uotis skirtingai.
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`Cannot canonicalize a value of type ${typeof value}.`);
  }

  if (Array.isArray(value)) {
    return `[${value
      .map((element: unknown) => {
        if (element === undefined) {
          throw new TypeError("Cannot canonicalize an absent array element; a list has no holes.");
        }
        return renderCanonical(element);
      })
      .join(",")}]`;
  }

  // Tik nuosavi raktai, rūšiuoti, `undefined` reikšmės praleistos — tiksliai kaip pakete.
  const record = value as Record<string, unknown>;
  const body = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(normalizeCanonicalText(key))}:${renderCanonical(record[key])}`)
    .join(",");
  return `{${body}}`;
}

/** Tikslūs baitai, virš kurių imamas kompresijos digest'as. Eksportuota, nes neatitikimas diagnozuojamas juos diff'inant. */
export function canonicalCompressionJson(value: unknown): string {
  return renderCanonical(value);
}

/**
 * Kompresijos konfigūracijos dokumento digest'as.
 *
 * Imamas virš RAW parsinto dokumento, niekada virš validuoto/normalizuoto konfigo:
 * benchmark'as digest'uoja tai, ką failas SAKO, o normalizacija užpildo default'us ir
 * pakeičia baitus. Projekcijos versija ir šaltinis keliauja digest'uojamos reikšmės
 * viduje, tad du digest'ai sutampa tik kai tas pats failas perskaitytas taip pat.
 */
export function computeCompressionConfigDigest(document: unknown): string {
  const canonical = canonicalCompressionJson({
    projectionVersion: COMPRESSION_CONFIG_PROJECTION_VERSION,
    source: COMPRESSION_CONFIG_SOURCE,
    document,
  });
  return `sha256:${sha256Hex(canonical)}`;
}
