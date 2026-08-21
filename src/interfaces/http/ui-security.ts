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
  const resolved = path.resolve(distDir, `.${urlPath}`);
  return resolved === distDir || resolved.startsWith(distDir + sep) ? resolved : undefined;
}
