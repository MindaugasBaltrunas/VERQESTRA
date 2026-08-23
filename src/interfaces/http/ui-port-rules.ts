// ANT KOKIO PORTO gyvena ŠIO projekto dashboard'as — GRYNOSIOS taisyklės (etalonas: AG_loop
// ui/ui-port.ts, task 0065).
//
// Kodėl viso to reikia: kai portas buvo konstanta, o „already-running" įrodinėjo VIENU faktu
// (portas klauso), operatorius su dviem projektais matydavo PIRMOJO projekto duomenis antrojo
// lange — būsenos melas, kurio niekas nesignalizuoja. Todėl galioja du invariantai:
//
//   1. PORTAS IŠVEDAMAS IŠ PROJEKTO ŠAKNIES. Ta pati šaknis → tas pats portas (bookmark'as
//      neišjuda po restarto), skirtingos šaknys → beveik visada skirtingi portai. Hash'as, o ne
//      „pirmas laisvas": „pirmas laisvas" duotų portą pagal paleidimo EILĘ, tad tas pats projektas
//      kaskart atsidurtų kitur.
//   2. SAVU PRIPAŽĮSTAMAS TIK SAVO PROJEKTO SERVERIS. Vien „portas klauso" nebėra įrodymas —
//      kandidato porte klausantis procesas apklausiamas identifikacijos maršrutu.
//
// PRIIMTA RIZIKA: fingerprint'as yra NEAUTENTIFIKUOTAS teiginys, ne paslaptis. Lokalus procesas gali
// juo apsimesti. Kriptografijos čia nėra sąmoningai: (a) token'as tokiam procesui neatitenka — į jį
// siunčiamas tik GET be credential'ų; (b) pasitikėjimo riba yra ta pati mašina ir tas pats
// vartotojas, o toks aktorius jau gali rašyti į `vq/state`; (c) anksčiau buvo BLOGIAU — „portas
// klauso" reiškė „mūsų", tad apsimetinėti net nereikėjo.

import { createHash } from "node:crypto";
import path from "node:path";

export const UI_PORT_ENV = "AG_UI_PORT";

export const UI_PORT_RANGE_START = 4173;
export const UI_PORT_RANGE_SIZE = 100;
export const UI_PORT_RANGE_END = UI_PORT_RANGE_START + UI_PORT_RANGE_SIZE - 1;

export const UI_IDENTITY_ROUTE = "/api/identity";
export const UI_IDENTITY_SERVICE = "verqestra-ui";

const MIN_OVERRIDE_PORT = 1024;
const MAX_OVERRIDE_PORT = 65535;

/** Netinkamas AIŠKUS nurodymas. Meta, o ne krenta į kitą šaltinį — žr. `parseUiPortOverride`. */
export class InvalidUiPortError extends Error {}

/** Iš kur atėjo galutinis portas — reikšmė keliauja į žurnalą ir į dashboard'ą. */
export type UiPortSource = "env" | "config" | "state" | "derived";

export type UiPortProbeResult =
  /** Porte niekas neklauso — jį galima imti. */
  | { state: "free" }
  /**
   * Porte kažkas klauso. `fingerprint` užpildomas TIK kai atsakė mūsų UI su savo projekto tapatybe;
   * tuščias laukas reiškia „svetimas arba neatpažįstamas procesas", ir tai NĖRA tas pats, kas
   * „mūsų serveris" — būtent šis skirtumas yra viso modulio esmė.
   */
  | { state: "occupied"; fingerprint?: string | undefined };

export type UiPortResolution =
  | { status: "available"; port: number; url: string; source: UiPortSource; fingerprint: string }
  | { status: "already-running"; port: number; url: string; source: UiPortSource; fingerprint: string }
  | { status: "failed"; reason: string };

export function uiUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * Projekto šaknies normalizavimas prieš hash'ą. Windows keliai case-insensitive ir gali ateiti su
 * abiem skirtukais, tad be normalizavimo TAS PATS projektas, paleistas iš skirtingai užrašyto kelio,
 * gautų du skirtingus portus ir du UI serverius.
 */
function normalizeProjectRoot(projectRoot: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(projectRoot).replace(/[\\/]+$/, "");
  return platform === "win32" ? resolved.replace(/\\/g, "/").toLowerCase() : resolved;
}

/**
 * Projekto tapatybė, kurią saugu paskelbti per loopback: sha256 nuo normalizuotos šaknies,
 * apkirptas iki 64 bitų. Absoliutus kelias per identifikacijos maršrutą NEIŠEINA — svetimas
 * procesas turi sužinoti tik tiek, ar serveris yra JO projekto, o ne kur tas projektas guli diske.
 */
export function projectFingerprint(projectRoot: string, platform: NodeJS.Platform = process.platform): string {
  return createHash("sha256").update(normalizeProjectRoot(projectRoot, platform)).digest("hex").slice(0, 16);
}

/** Deterministinis pageidaujamas portas: ta pati šaknis → visada tas pats diapazono narys. */
export function derivePreferredUiPort(projectRoot: string, platform: NodeJS.Platform = process.platform): number {
  const fingerprint = projectFingerprint(projectRoot, platform);
  return UI_PORT_RANGE_START + (Number.parseInt(fingerprint.slice(0, 8), 16) % UI_PORT_RANGE_SIZE);
}

/**
 * Visi diapazono portai, pradedant pageidaujamu ir apsukant ratą. Eilė deterministinė, tad du
 * projektai, kurių hash'ai susidūrė, konfliktą sprendžia stabiliai: pirmasis pasilieka pageidaujamą,
 * antrasis kaskart gauna tą patį kitą kandidatą.
 */
export function uiPortCandidates(projectRoot: string, platform: NodeJS.Platform = process.platform): number[] {
  const preferred = derivePreferredUiPort(projectRoot, platform);
  return Array.from(
    { length: UI_PORT_RANGE_SIZE },
    (_unused, offset) => UI_PORT_RANGE_START + ((preferred - UI_PORT_RANGE_START + offset) % UI_PORT_RANGE_SIZE),
  );
}

/**
 * Override reikšmės validacija. META, o ne apkerpa ir ne ignoruoja: `AG_UI_PORT=4173abc` yra rašybos
 * klaida, o tyliai iš jos išvestas portas reikštų, kad operatorius atsidaro ne tą URL ir mano, jog
 * override veikia. Klaidos žinutėje reikšmė rodoma, nes ją pats operatorius ir įrašė.
 */
export function parseUiPortOverride(raw: string, source: string): number {
  const value = raw.trim();
  if (!/^[0-9]+$/.test(value)) {
    throw new InvalidUiPortError(`${source} must be an integer port number, got "${raw}"`);
  }
  const port = Number.parseInt(value, 10);
  if (port < MIN_OVERRIDE_PORT || port > MAX_OVERRIDE_PORT) {
    throw new InvalidUiPortError(`${source} must be between ${MIN_OVERRIDE_PORT} and ${MAX_OVERRIDE_PORT}, got ${port}`);
  }
  return port;
}

/** Ar portu galima UŽIMTI vietą: efemeriniai portai priklauso OS pool'ui ir po restarto atitenka bet kam. */
export function isBindableUiPort(port: number): boolean {
  return port >= UI_PORT_RANGE_START && port <= UI_PORT_RANGE_END;
}

/**
 * Identifikacijos atsakymo tapatybė. Neatpažintas kūnas duoda `undefined` — ir tai NĖRA „mūsų":
 * priešinga prielaida („neatsakė, tai turbūt mūsų") grąžintų būtent tą klaidą, kurią modulis taiso.
 */
export function identityFingerprint(body: string): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const fingerprint = record["project_fingerprint"];
  if (record["service"] !== UI_IDENTITY_SERVICE || typeof fingerprint !== "string" || !fingerprint) {
    return undefined;
  }
  return fingerprint;
}

/**
 * Identifikacijos maršruto kūnas — VIENINTELĖ vieta, kur ši forma statoma. Iki 2026-08-23 tai
 * buvo netiesa: router'is formą statė pats (su `schema_version`), o ši funkcija be kvietėjų
 * gamino SIAURESNĘ kopiją — dvi formos vienam kontraktui. Dabar router'is eina per ją.
 */
export function uiIdentityPayload(fingerprint: string): {
  schema_version: number;
  service: string;
  project_fingerprint: string;
} {
  return { schema_version: 1, service: UI_IDENTITY_SERVICE, project_fingerprint: fingerprint };
}

/** JSON eilutės forma zondų/testų pusei — ta pati `uiIdentityPayload` forma, ne kopija. */
export function buildUiIdentityBody(fingerprint: string): string {
  return JSON.stringify(uiIdentityPayload(fingerprint));
}
