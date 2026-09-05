// Produkto formos guard'ų eilučių TAISYKLĖS (etalonas: AG_loop hooks/{backend,frontend,
// mobile}-guard.ts taisyklių masyvai 1:1). Grynos duomenų struktūros virš `line-rules`
// variklio — jokio IO, jokio node API.
//
// BLOCK vs WARN skirtumas yra kontraktas, ne skonis: BLOCK stabdo Stop hook'ą ir reikalauja
// žmogaus, WARN tik patenka į guard'o žurnalą. Todėl blokuojama tik tada, kai eilutė yra
// vienareikšmis saugumo pažeidimas (eval, dangerouslySetInnerHTML, slaptukai AsyncStorage),
// o heuristikos (business logika komponente, trūkstama validacija) lieka įspėjimais.

import { numberedLine, type LineRule } from "./line-rules.js";
import { hasDisableReason } from "./file-classification.js";

// ---------------------------------------------------------------------------
// backend (Express API)
// ---------------------------------------------------------------------------

/**
 * Shell vykdymas per `child_process` modulio receiverį: `child_process.exec(...)`,
 * `cp.execSync(...)` arba `require("child_process").exec(...)` — pastarojo receiveris yra `)`,
 * tad plikos formos regex'as jo nemato.
 */
const MODULE_EXEC_CALL =
  /(?:\b(?:child_process|childProcess|cp)|["']child_process["']\s*\))\.exec(?:Sync|FileSync|File)?\s*\(([^)]*)/;

/**
 * Plika `exec(...)` forma. Prieš `exec` reikalaujamas ne `\w$.` simbolis turi vieną tikslą:
 * NEgaudyti metodo kvietimo `pattern.exec(line)` (RegExp.prototype.exec). Etalono `\bexec\s*\(`
 * čia klydo — `\b` tarp `.` ir `e` YRA žodžio riba, tad kiekvienas regex'ą naudojantis backend
 * failas gaudavo BLOCK'ą (pilnas auditas 2026-09-05, D3).
 */
const BARE_EXEC_CALL = /(?:^|[^\w$.])exec(?:Sync|FileSync|File)?\s*\(([^)]*)/;

/** Naudotojo įtakos pėdsakas argumentų lange (etalono sąrašas 1:1). */
const USER_INFLUENCED_ARGUMENT = /req\.|request\.|body|params|query|\$\{/;

/** Ar `child_process` minimas toje pačioje eilutėje (`require`, `import` ar `node:` forma). */
const MENTIONS_CHILD_PROCESS = /child_process/;

/**
 * Pirmas argumentas nėra fiksuota komanda. Eilutės literalas (`"ls -la"`) saugus; template
 * literalas — tik jei jame nėra interpoliacijos; visa kita (kintamasis, konkatenacija) yra
 * kintamas įėjimas. Tuščias argumentų langas laikomas saugiu: be įėjimo nėra ir injekcijos.
 */
function hasVariableFirstArgument(callArguments: string): boolean {
  const trimmed = callArguments.trimStart();
  const opening = trimmed[0];
  if (opening === undefined) return false;
  if (opening === '"' || opening === "'") return false;
  if (opening === "`") return trimmed.includes("${");
  return true;
}

/**
 * Taisyklė šauna TIK shell vykdymo kontekste. Trys formos: (a) plika `exec(`/`execSync(`/
 * `execFile(` su ne-literaliu pirmu argumentu arba naudotojo įtakotais argumentais;
 * (b) `child_process`/`childProcess`/`cp` receiveris — besąlygiškai, nes tai jau vienareikšmis
 * shell kvietimas; (c) eilutė mini `child_process`, tad literalo išimtis nebegalioja nė (a)
 * formai. `x.exec(...)` su bet kokiu kitu receiveriu — niekada, ir tai galioja net tada, kai
 * `child_process` minimas komentare toje pačioje eilutėje: (c) reikalauja exec KVIETIMO formos,
 * ne vien žodžio.
 */
function usesShellExecWithVariableInput(line: string): boolean {
  if (MODULE_EXEC_CALL.test(line)) return true;

  const bare = BARE_EXEC_CALL.exec(line);
  if (!bare) return false;
  if (MENTIONS_CHILD_PROCESS.test(line)) return true;

  const callArguments = bare[1] ?? "";
  return hasVariableFirstArgument(callArguments) || USER_INFLUENCED_ARGUMENT.test(callArguments);
}

export const backendLineRules: readonly LineRule[] = Object.freeze([
  {
    matches: ({ line }) => /\beval\s*\(/.test(line),
    findings: (context) => [numberedLine(context), `BLOCK: ${context.file} uses eval()`],
    blocks: true,
  },
  {
    matches: ({ line }) => usesShellExecWithVariableInput(line),
    findings: (context) => [
      numberedLine(context),
      `BLOCK: ${context.file} uses child_process.exec with variable/user-influenced input`,
    ],
    blocks: true,
  },
  {
    matches: ({ line }) => line.includes("console.log"),
    findings: (context) => [numberedLine(context), `WARN: ${context.file} uses console.log; prefer the project logger`],
  },
  {
    matches: ({ line }) => /throw new Error|throw new [A-Za-z]*Error/.test(line),
    findings: (context) => [
      numberedLine(context),
      `WARN: ${context.file} throws errors directly; verify central error middleware handles this path`,
    ],
  },
  {
    matches: ({ file, line }) =>
      (file.includes("controller") || file.endsWith(".routes.ts")) && /\bdb\.(query|execute|transaction)\b/.test(line),
    findings: (context) => [
      numberedLine(context),
      `WARN: ${context.file} accesses DB directly in route/controller; prefer repository layer`,
    ],
  },
  {
    matches: ({ line }) => /app\.use\(cors\(\s*\)\)|cors\(\s*\)/.test(line),
    findings: (context) => [numberedLine(context), `WARN: ${context.file} uses cors() without explicit origin configuration`],
  },
  {
    matches: ({ line }) => /router\.(post|put|patch|delete)\(/.test(line) && !/validate\(/.test(line),
    findings: (context) => [`WARN: ${context.file} route may lack request validation: ${numberedLine(context)}`],
  },
]);

/** Mutuojantis maršrutas be jokio matomo auth signalo — įspėjimas, ne blokas (heuristika). */
export function isUnauthenticatedMutatingRoute(file: string, content: string): boolean {
  return (
    (file.endsWith(".routes.ts") || file.includes("/routes/")) &&
    /router\.(post|put|patch|delete)\(/.test(content) &&
    !/(auth|login|register|public)/.test(file) &&
    !/authenticate|requireAuth|requireRoles|router\.use\(auth/.test(content)
  );
}

// ---------------------------------------------------------------------------
// frontend (React)
// ---------------------------------------------------------------------------

export const frontendLineRules: readonly LineRule[] = Object.freeze([
  {
    matches: ({ line }) => line.includes("dangerouslySetInnerHTML"),
    findings: (context) => [numberedLine(context), `BLOCK: ${context.file} uses dangerouslySetInnerHTML`],
    blocks: true,
  },
  {
    // Hooks taisyklių išjungimas BE priežasties blokuoja; su priežastimi — praeina, nes
    // sąmoningas, paaiškintas nukrypimas yra inžinerinis sprendimas, o ne pažeidimas.
    matches: ({ line }) =>
      /eslint-disable(-next-line)?.*react-hooks\/rules-of-hooks/.test(line) && !hasDisableReason(line),
    findings: (context) => [
      `BLOCK: ${context.file} disables react-hooks/rules-of-hooks without a clear reason: ${numberedLine(context)}`,
    ],
    blocks: true,
  },
  {
    matches: ({ line }) => /eslint-disable(-next-line)?.*react-hooks\/exhaustive-deps/.test(line),
    findings: (context) => [
      numberedLine(context),
      `WARN: ${context.file} disables react-hooks/exhaustive-deps; verify dependencies are intentional`,
    ],
  },
  {
    matches: ({ line }) => /https?:\/\/|localhost:[0-9]+|\/api\//.test(line),
    findings: (context) => [numberedLine(context), `WARN: ${context.file} appears to hardcode an API URL/path in a component`],
  },
  {
    matches: ({ line }) =>
      /filter\(|reduce\(|sort\(|forEach\(|new Map\(|new Set\(|calculate|validate|normalize|transform/.test(line),
    findings: (context) => [
      numberedLine(context),
      `WARN: ${context.file} may contain business/data logic directly in the component`,
    ],
  },
]);

// ---------------------------------------------------------------------------
// mobile (React Native)
// ---------------------------------------------------------------------------

export const mobileLineRules: readonly LineRule[] = Object.freeze([
  {
    matches: ({ line }) => /dangerouslySetInnerHTML/.test(line),
    findings: (context) => [
      numberedLine(context),
      `BLOCK: ${context.file} uses dangerouslySetInnerHTML -- not valid in React Native`,
    ],
    blocks: true,
  },
  {
    matches: ({ line }) =>
      /AsyncStorage\.(setItem|getItem|removeItem)/.test(line) && /token|secret|password|refresh|jwt|key/i.test(line),
    findings: (context) => [
      numberedLine(context),
      `BLOCK: ${context.file} uses AsyncStorage for secrets -- use expo-secure-store`,
    ],
    blocks: true,
  },
  {
    matches: ({ line }) => /http:\/\/localhost|http:\/\/127\./.test(line),
    findings: (context) => [numberedLine(context), `BLOCK: ${context.file} hardcodes localhost -- use the api module`],
    blocks: true,
  },
  {
    matches: ({ line }) => /\beval\s*\(/.test(line),
    findings: (context) => [numberedLine(context), `BLOCK: ${context.file} uses eval() -- forbidden in React Native`],
    blocks: true,
  },
  {
    matches: ({ line }) => /console\.log\(/.test(line) && !/(catch|error|warn)/.test(line),
    findings: (context) => [numberedLine(context), `WARN: ${context.file} uses console.log() -- remove before production`],
  },
  {
    matches: ({ line }) => /style=\{\{[^}]{80,}\}\}/.test(line),
    findings: (context) => [
      numberedLine(context),
      `WARN: ${context.file} has large inline styles -- prefer StyleSheet.create`,
    ],
  },
  {
    matches: ({ line }) =>
      /setInterval|setTimeout|addEventListener|addListener/.test(line) && !/clear|remove|return/.test(line),
    findings: (context) => [numberedLine(context), `WARN: ${context.file} -- timer/listener without visible cleanup in return`],
  },
]);

/** Bendra riba, nuo kurios failas laikomas per dideliu komponentu (WARN abiem UI guard'ams). */
export const LARGE_COMPONENT_LINE_LIMIT = 300;

/** `app.json` su `debug: true` produkcijos konfige — WARN (etalono mobile extraFile patikra). */
export function hasMobileDebugFlag(appJsonContent: string): boolean {
  return /"debug"\s*:\s*true/.test(appJsonContent);
}
