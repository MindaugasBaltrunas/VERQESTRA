// UI serverio SAUGOS RIBA (etalonas: AG_loop interfaces/http/ui-server.ts saugos blokas).
//
// Du vartai, ir abu būtini:
//
//   1. LOOPBACK `Host` — apsauga nuo DNS rebinding. Serveris klauso 127.0.0.1, bet be `Host`
//      validacijos kenkėjiškas domenas, rezolvuojamas į 127.0.0.1, per naršyklę galėtų same-origin
//      pasiekti UI, ištraukti token'ą ir vykdyti mutacijas.
//   2. SESIJOS TOKEN'AS — per-server-start paslaptis. Lyginama pastovaus laiko palyginimu: eilučių
//      `===` nutekintų prefikso ilgį per laiką.
//
// Vienintelė išimtis be token'o yra projekto TAPATYBĖS maršrutas: klausiantysis yra KITO projekto
// orkestratorius, kuris prieš pripažindamas šį serverį savu turi sužinoti, kieno jis, o token'o
// pagal apibrėžimą neturi. Atsakymas neša TIK vienkryptį šaknies fingerprint'ą — nei kelio, nei
// token'o, nei jokių projekto duomenų.

import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";

export const UI_TOKEN_HEADER = "x-vq-ui-token";

/**
 * `<meta>` vardas, per kurį per-start token'as pasiekia SPA.
 *
 * Kodėl meta, o ne cookie ar atskiras `/api/token` maršrutas: cookie keliautų su KIEKVIENA
 * užklausa (įskaitant `<img>` iš svetimo puslapio), o atskiras maršrutas turėtų būti be token'o
 * — t. y. atiduotų paslaptį bet kam, kas pasiekia prievadą. Meta reikšmė gyvena TAME PAČIAME
 * dokumente, kurį serveris ką tik pats atidavė, ir jos negali perskaityti kita kilmė.
 *
 * Vardas privalo sutapti su `ui-app/index.html` ir `ui-app/src/model/api.ts` — tai kliento ir
 * serverio kontraktas, tad jis gyvena čia, o ne dviejose vietose po eilutę.
 */
export const UI_TOKEN_META_NAME = "vq-ui-token";

const UI_TOKEN_META_EMPTY = `name="${UI_TOKEN_META_NAME}" content=""`;

/**
 * Įrašo token'ą į app shell'o `<meta>`.
 *
 * Reikšmė ekranuojama, nors `createUiToken` gamina base64url (jame nėra nei kabučių, nei `<`):
 * ekranavimas yra pigus, o prielaida „token'as visada saugus" yra būtent ta rūšis, kuri lūžta
 * tyliai, kai token'o gamintojas kada nors pasikeis.
 *
 * Nerastas žymeklis grąžina dokumentą NEPAKEISTĄ — kvietėjas apie tai praneša atskirai. Tylus
 * „įrašiau" būtų blogiausias variantas: puslapis atsidarytų, o kiekviena API užklausa grįžtų 401
 * be jokios nuorodos, kodėl.
 */
export function injectUiToken(html: string, uiToken: string): { html: string; injected: boolean } {
  if (!html.includes(UI_TOKEN_META_EMPTY)) return { html, injected: false };
  const escaped = uiToken.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  return { html: html.replace(UI_TOKEN_META_EMPTY, `name="${UI_TOKEN_META_NAME}" content="${escaped}"`), injected: true };
}

/** Per-server-start paslaptis. 32 baitai — jokio deterministinio šaltinio. */
export function createUiToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Pastovaus laiko palyginimas; skirtingas ilgis atmetamas be `timingSafeEqual` (jis mestų). */
export function tokenMatches(value: string | undefined, expected: string): boolean {
  if (!value) return false;
  const actualBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export type RequestHeaders = { [key: string]: string | string[] | undefined };

/** Antraštė gali ateiti kaip masyvas — imamas pirmas įrašas, ne visas sąrašas. */
export function headerToken(headers: RequestHeaders): string | undefined {
  const header = headers[UI_TOKEN_HEADER];
  return Array.isArray(header) ? header[0] : header;
}

/**
 * `Host` privaloma (HTTP/1.1) ir turi būti loopback. IPv6 forma ateina laužtiniuose skliaustuose,
 * tad jis nuimamas prieš lyginimą; be to `[::1]:4173` porto dalis nepainiojama su adresu.
 */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.startsWith("[")
    ? hostHeader.slice(1, hostHeader.indexOf("]"))
    : hostHeader.split(":")[0];
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function hasValidApiToken(headers: RequestHeaders, uiToken: string): boolean {
  return tokenMatches(headerToken(headers), uiToken);
}

/**
 * Atsakymo antraštės. CSP čia nėra kosmetika: dashboard'as renderina laisvą tekstą iš logų, tad
 * `script-src 'self'` ir `object-src 'none'` yra riba tarp „rodoma" ir „vykdoma".
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function responseHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

/**
 * Statinio failo kelias arba `undefined`, kai jis išeitų už dist katalogo ribų.
 *
 * `path.resolve` sutraukia `..` LEKSIŠKAI, tad `/../../etc/passwd` niekada netampa realiu
 * skaitymu — bet tik tada, kai rezultatas dar patikrinamas prieš šaknį. Vien `join` be patikros
 * yra klasikinis path traversal.
 */
export function resolveStaticPath(distDir: string, urlPath: string, sep: string = path.sep): string | undefined {
  // Šaknis NORMALIZUOJAMA prieš lyginimą. Be to `D:/repo/ui/dist` (pasvirieji brūkšniai) niekada
  // nesutaptų su `D:\repo\ui\dist\assets\app.js` prefiksu, ir KIEKVIENAS asset'as tyliai
  // iškristų į SPA fallback'ą — puslapis atrodytų gyvas, o `app.js` grįžtų kaip HTML. Vartas
  // negali priklausyti nuo to, kokia forma kvietėjas parašė kelią.
  const root = path.resolve(distDir);
  const resolved = path.resolve(root, `.${urlPath}`);
  return resolved === root || resolved.startsWith(root + sep) ? resolved : undefined;
}
