// Rašymo politikos GRYNOSIOS taisyklės (etalonas: AG_loop hooks/write-policy.ts evaluate
// pusė). Jokio IO ir jokio node API — kelio sutraukimą daro savos funkcijos, nes architektūros
// vartai domain'e draudžia visus builtin'us.
//
// Du normalizavimai, kurie ATRODO vienodai ir niekada nesuliejami:
//   • `normalizeForPolicy` — saugomų prefiksų atitikimui: sutraukia `..`, nukerpa `./` ir
//     VISADA lowercase'ina. Etalone tai buvo pataisyta klaida: platformos sąlyga tyliai
//     išjungdavo kiekvieną mišraus registro saugomą prefiksą Linux/macOS target'uose.
//   • `normalizeReadEventPath` — skaitymo įrodymų tapatybei: sutraukia lygiai taip pat, bet
//     registrą lanksto TIK drive-letter keliams (VERQESTRA shared/paths konvencija), kad
//     verdiktas nepriklausytų nuo to, kurioje OS bėga hook'as. Etalonas čia žiūrėjo
//     `process.platform`, o domain sluoksnis proceso būsenos neskaito.

export type WritePolicyBlock = {
  reason: string;
  stderr: string;
};

const BLOCKED_FILES = [".env", ".env.local", ".env.production", ".env.staging"];
/** Bet koks `.env` ar `.env.<suffix>`: konkretus sąrašas praleisdavo nestandartinius variantus. */
const BLOCKED_ENV_FILE_PATTERN = /^\.env(\..+)?$/i;
/**
 * Vienintelis `.env*` vardas, kuris pagal apibrėžimą slaptukų NETURI: `.env.example` yra
 * placeholder'ių šablonas (kintamųjų vardai su „change-me" reikšmėmis) ir industrijos standartas
 * (`cp .env.example .env`). Be šios išimties `BLOCKED_ENV_FILE_PATTERN` blokuoja ir jį, tad
 * env kintamųjų nebūdavo kur dokumentuoti — taisyklė, sukurta kredencialams saugoti, stabdydavo
 * failą, kuris kredencialų neneša.
 *
 * Sąrašas sąmoningai vieno įrašo: kiekvienas papildomas šablonas (`.env.sample`,
 * `.env.template`) yra papildomas kelias, kurį reikia pagrįsti atskirai. Lyginamas TIKSLUS
 * lowercase basename, tad `.env.example.local` ir `.env.exampleX` lieka blokuoti, o plėtinių
 * (`BLOCKED_EXTENSIONS`) ir kelių (`node_modules/`, `.git/`, `..`) patikros eina PO šios ir
 * išimties nepaliečia.
 */
export const ALLOWED_ENV_TEMPLATE_BASENAMES: readonly string[] = [".env.example"];
const BLOCKED_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".secret", ".keystore"];
const BLOCKED_PATHS = ["node_modules/", ".git/"];
/** Sugeneruotas hook runtime: hook'ai vykdomi iš jo, tad tiesioginis rašymas apeitų build'ą. */
const BLOCKED_GENERATED_RUNTIME_PATHS = ["dist/"];

const PROTECTED_ORCHESTRATOR = [
  ".claude/settings.json",
  // Claude `settings.local.json` krauna tuo pačiu autoritetu kaip `settings.json`: agentas,
  // galintis jį rašyti, gali pakeisti ar ištuštinti hook bloką ir nuginkluoti KIEKVIENĄ guard'ą
  // kitai sesijai. Tas pats galioja `.claude/hooks/`.
  ".claude/settings.local.json",
  ".claude/hooks/",
  "vq/state/",
  "vq/supervisor/decision.json",
  "vq/supervisor/reformulated-task.md",
  "vq/supervisor/repair-task.md",
  // quality-policy.json deklaruoja komandas, kurias pre-bash allowlist paskui priima — savitarnos
  // redagavimas būtų allowlist plėtimo primityvas, tad jis keičiamas tik per policy-proposal kelią.
  "vq/config/quality-policy.json",
  // project profilio source roots interpoliuojami į guard'ų shell komandas; rašomas profilis yra
  // command-injection primityvas Stop kelyje.
  "vq/project/profile.json",
];

const PROTECTED_LOGS = [
  "vq/logs/session.md",
  "vq/logs/history.log",
  "vq/logs/hooks.log",
  "vq/logs/changes.log",
  "vq/logs/typecheck.log",
  "vq/logs/.readme-guard-ok",
  "vq/state/readme-read-events.json",
];

/**
 * RT-10 carve-out: audito task'ai turi rašyti mašininio skaitymo rezultatus, bet `vq/state/`
 * prefiksas blokuodavo VISUS tokius rašymus — task kontraktas ir guard'as prieštaraudavo.
 * Leidžiama TIK `vq/state/audit/*.json`; visi kiti control failai (task-ledger, retry-counts,
 * stable-ref, readme-read-events, claude-stop-status) lieka saugomi.
 */
const AUDIT_STATE_WRITE_ALLOW_PATTERN = /(^|\/)vq\/state\/audit\/[^/]+\.json$/i;

function isAllowedAuditStateWrite(normalizedFilePath: string): boolean {
  // `..` niekada neleidžiamas: includes-match neišsprendžia traversal'o, tad
  // "vq/state/audit/../retry-counts.json" kitaip pralįstų pro carve-out atgal į control būseną.
  if (normalizedFilePath.includes("..")) return false;
  return AUDIT_STATE_WRITE_ALLOW_PATTERN.test(normalizedFilePath);
}

/** Paskutinis kelio segmentas (POSIX semantika po separatorių normalizavimo). */
export function pathBaseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/**
 * Sutraukia `//`, `/./` ir `/../` taip, kaip tai padarys failų sistema, kad prefiksų atitikimas
 * matytų kelią, į kurį rašymas REALIAI nusileis. Be šito `vq/tasks/../state/task-ledger.json`
 * neturi `vq/state/` substring'o, pralenda pro kiekvieną saugomą prefiksą ir vis tiek įrašo į
 * saugomą control būseną. Segmentai, lipantys virš kelio pradžios, paliekami kaip vedantys `..`,
 * kad kvietėjas galėtų juos atmesti (žr. {@link escapesRoot}).
 */
export function collapseTraversal(unixPath: string): string {
  const leadingSlash = unixPath.startsWith("/");
  const drive = unixPath.match(/^[A-Za-z]:\//)?.[0] ?? "";
  const body = drive ? unixPath.slice(drive.length) : unixPath;
  const resolved: string[] = [];

  for (const segment of body.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      const last = resolved[resolved.length - 1];
      if (last !== undefined && last !== "..") resolved.pop();
      else if (!drive && !leadingSlash) resolved.push("..");
      continue;
    }
    resolved.push(segment);
  }

  return `${drive}${!drive && leadingSlash ? "/" : ""}${resolved.join("/")}`;
}

/** `true`, kai kelias lipa virš savo starto taško (`../../x`) — visada atmetama. */
export function escapesRoot(unixPath: string): boolean {
  return collapseTraversal(unixPath).split("/")[0] === "..";
}

/** Saugomų prefiksų lyginimo forma: sutraukta ir VISADA lowercase (žr. modulio antraštę). */
export function normalizeForPolicy(filePath: string): string {
  return collapseTraversal(filePath.replace(/\\/g, "/"))
    .replace(/^\.?\//, "")
    .toLowerCase();
}

/** Skaitymo įrodymo tapatybė: registras lankstomas TIK drive-letter keliams. */
export function normalizeReadEventPath(filePath: string): string {
  const collapsed = collapseTraversal(filePath.replace(/\\/g, "/")).replace(/^\.?\//, "");
  return /^[A-Za-z]:\//.test(collapsed) ? collapsed.toLowerCase() : collapsed;
}

/**
 * Suplokštėjusio Windows kelio detekcija (GeoGravity 2026-07: šaknyje atsirado failai
 * `D:ReactgeodesiGeoGravitylogscommit-msg.md` — pilnas kelias, praradęs backslash'us). Du signalai:
 *   1. drive-relative forma `X:foo` (po dvitaškio nėra separatoriaus) — legalus rašymas visada
 *      `X:/...` arba paprastas santykinis kelias;
 *   2. failo vardas prasideda suplokštėjusiu projekto root'u — vienareikšmis mangling artefaktas.
 */
function mangledWindowsPathBlock(filePath: string, projectRoot?: string): WritePolicyBlock | undefined {
  const normalized = filePath.replace(/\\/g, "/");
  const firstSegment = normalized.split("/")[0] ?? "";
  if (/^[A-Za-z]:./.test(firstSegment)) {
    return {
      reason: "sugadintas kelias",
      stderr:
        `BLOCKED: '${filePath}' yra Windows kelias, praradęs backslash separatorius (drive-relative forma).\n` +
        "  Naudok forward slash (D:/kelias/failas) arba santykinį kelią nuo projekto šaknies.",
    };
  }

  if (projectRoot) {
    const collapsedRoot = projectRoot.replace(/^[A-Za-z]:/, "").replace(/[\\/]/g, "");
    const base = pathBaseName(normalized);
    if (collapsedRoot.length >= 8 && base.startsWith(collapsedRoot)) {
      return {
        reason: "sugadintas kelias",
        stderr:
          `BLOCKED: '${filePath}' failo vardas sutampa su suplokštėjusiu projekto keliu — separatoriai pradingo.\n` +
          "  Naudok forward slash arba santykinį kelią nuo projekto šaknies.",
      };
    }
  }

  return undefined;
}

export function evaluateWritePolicy(
  filePath: string,
  options: { projectRoot?: string } = {},
): WritePolicyBlock | undefined {
  const basename = pathBaseName(filePath);
  const normalizedFilePath = normalizeForPolicy(filePath);

  const mangled = mangledWindowsPathBlock(filePath, options.projectRoot);
  if (mangled) return mangled;

  if (escapesRoot(filePath.replace(/\\/g, "/"))) {
    return {
      reason: "kelias uz projekto ribu",
      stderr:
        `BLOCKED: '${filePath}' iseina uz starto katalogo ribu ('..').\n` +
        "  Rasyk tik projekto viduje, naudodamas kelia nuo projekto saknies.",
    };
  }

  // Slaptukus nešantys vardai tikrinami case-insensitive VISOSE platformose: `.ENV` ar `key.PEM`
  // Linux'e laiko lygiai tuos pačius kredencialus kaip Windows'e. Vienintelė išimtis —
  // `.env.example` šablonas (žr. ALLOWED_ENV_TEMPLATE_BASENAMES).
  const lowerBasename = basename.toLowerCase();
  const isEnvTemplate = ALLOWED_ENV_TEMPLATE_BASENAMES.includes(lowerBasename);
  if (!isEnvTemplate && (BLOCKED_FILES.includes(lowerBasename) || BLOCKED_ENV_FILE_PATTERN.test(basename))) {
    return { reason: "saugomas failas", stderr: `BLOCKED: '${filePath}' yra saugomas failas (env/secrets).` };
  }

  const extension = BLOCKED_EXTENSIONS.find((ext) => normalizedFilePath.endsWith(ext.toLowerCase()));
  if (extension) {
    return { reason: "saugomas pletinys", stderr: `BLOCKED: Failai su pletiniu '${extension}' yra saugomi (raktai).` };
  }

  const blockedPath = BLOCKED_PATHS.find((prefix) => normalizedFilePath.includes(prefix.toLowerCase()));
  if (blockedPath) {
    return { reason: "saugomas kelias", stderr: `BLOCKED: Negalima rasyti i '${blockedPath}'.` };
  }

  const generatedRuntime = BLOCKED_GENERATED_RUNTIME_PATHS.find((prefix) =>
    normalizedFilePath.startsWith(prefix.toLowerCase()),
  );
  if (generatedRuntime) {
    return {
      reason: "generuotas hook runtime",
      stderr: [
        `BLOCKED: Negalima tiesiogiai rasyti i '${generatedRuntime}'.`,
        "  Hook'ai vykdomi is dist/cli.js.",
        "  Dist failus galima atnaujinti tik paleidus audituojama build is src.",
      ].join("\n"),
    };
  }

  // Gyvo repo konfigai yra saugoma orkestratoriaus būsena, bet kiekvienas jų egzistuoja ir kaip
  // supakuotas install šablonas po `templates/**` — tos kopijos yra paprasti source assetai.
  // Carve-out PRISEGTAS prie šaknies, ne `includes`: laisvas substring'as reikštų, kad bet kuris
  // kelias, kuriame kur nors yra `templates/`, išjungia VISUS saugomus kelius (2026-08-06 auditas).
  const isInstallTemplate = /^templates\//.test(normalizedFilePath);
  const protectedMatch = isInstallTemplate
    ? undefined
    : PROTECTED_ORCHESTRATOR.find((protectedPath) => normalizedFilePath.includes(protectedPath.toLowerCase()));
  if (protectedMatch && !isAllowedAuditStateWrite(normalizedFilePath)) {
    return {
      reason: "orkestratoriaus failas",
      stderr: `BLOCKED: '${filePath}' yra saugoma orkestratoriaus busena/konfiguracija.`,
    };
  }

  const protectedLog = PROTECTED_LOGS.find((logFile) => normalizedFilePath.includes(logFile.toLowerCase()));
  if (protectedLog) {
    return { reason: "zurnalo failas", stderr: `BLOCKED: '${filePath}' yra automatinis zurnalas.` };
  }

  return undefined;
}

/**
 * N4 deadlock'o išvengimas: kai `dist` pasenęs, leidžiami TIK šie priežiūros keliai, kad src
 * taisymą būtų galima užbaigti ir perstatyti (pvz. kai pirmas edit'as palieka laikiną TS klaidą).
 * `dist` pats lieka draudžiamas — kitaip vartai būtų apeinami perrašant sugeneruotą kodą.
 */
export function isMaintenancePath(filePath: string): boolean {
  const normalized = normalizeForPolicy(filePath);
  if (normalized.startsWith("dist/")) return false;
  return normalized.startsWith("src/") || normalized === "tsconfig.json" || normalized === "package.json";
}
