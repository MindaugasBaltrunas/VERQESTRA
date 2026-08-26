// Deterministinis dviejų task'ų nepriklausomumo detektorius (task 1119; spec PAR-1/PAR-2/WRK-3,
// design §13 „Maximum two workers"). Behaviour etalon: AG_loop
// application/scheduling/conflict-detector.ts (1:1).
//
// Iki šio modulio klausimas „ar šiuos du task'us galima vykdyti vienu metu" atsakymo neturėjo, todėl
// atsakymas buvo vienintelis saugus — ne. Lease (`worker-lease.ts`) įrodo, KAS yra savininkas, scope
// lock (domain `scope-lock-rules.ts`) — KAS kam priklauso vykdymo metu, worktree manager — kad
// kopijos atskiros. Nė vienas jų neatsako į klausimą PRIEŠ paleidimą: ar dviejų kandidatų write
// scope apskritai nesikerta. Čia gimsta būtent tas verdiktas.
//
// Trys taisyklės, kurios yra kontraktas, o ne įgyvendinimo detalė:
//
//   1. **Įrodymo nebuvimas niekada nevirsta leidimu.** Nedeklaruotas scope, **neribotos apimties**
//      wildcard šablonas, neišsprendžiamas kelias ar nepatikrintas kontraktas yra `evidence gap`, ir
//      bet kuris gap'as vienoje pusėje reiškia nuoseklų vykdymą — lygiai taip pat, kaip reali
//      sankirta. Tai tiesioginis spec PAR-2 reikalavimas. Ribotos apimties šablonas
//      (`isBoundedGlobPattern`) spragos nebeuždeda: jo aprėptis yra apskaičiuojama, tad įrodymas
//      YRA — o klaidingas įrodymo trūkumas kainuoja lygiagretumą lygiai taip pat tyliai.
//   2. **Scope semantika viena visai sistemai.** Kelių persidengimas skaičiuojamas per
//      domain `scope-lock-rules.ts#scopesConflict`, o „ar tai migracija / generuotas artefaktas" —
//      per `integration/contract-paths.ts`. Antra tų taisyklių kopija reikštų, kad detektorius
//      leidžia tai, ką lock'as vėliau blokuoja (arba atvirkščiai), ir vartai prasilenktų.
//   3. **Modulis grynas.** Jokio FS, git, laikrodžio ar atsitiktinumo: tie patys write set'ai
//      visada duoda tą patį verdiktą ir tą patį `verdict_hash`, tad sprendimą galima perskaičiuoti
//      po restart'o ir palyginti su tuo, kuris jau buvo priimtas.
//
// Konfliktų kryptis sąmoningai konservatyvi. Klaidingai serializuoti du nepriklausomus task'us
// kainuoja laiko; klaidingai paleisti du workerius į tą patį failą, simbolį ar kontraktą kainuoja
// tylų darbo praradimą, kurio nepagauna nė vienas vėlesnis vartas.

import { createHash } from "node:crypto";
import { normalizeScopeValue, scopesConflict, type ScopeLockKind } from "../../domain/scheduling/index.js";
import { canonicalJsonStringify } from "../../shared/json.js";
import { isGeneratedPath, isMigrationPath } from "../integration/contract-paths.js";

/** Detektoriaus TAISYKLIŲ versija. Įeina į atspaudus, tad pakeitus taisykles seni verdiktai tampa stale. */
// v2 (035-a-02): ribotos apimties glob'as (`isBoundedGlobPattern`) nebeuždeda `wildcard-scope` spragos.
export const CONFLICT_DETECTOR_VERSION = 2;

/**
 * Write scope rūšys. Pirmosios penkios yra KELIŲ šeima (jų persidengimą sprendžia scope lock
 * semantika), paskutinės trys — TAPATYBIŲ šeima (lyginama tiksliai, nes simbolis, kontraktas ir
 * architektūros mazgas nėra keliai ir kelių containment jiems nereiškia nieko).
 */
export const WRITE_SCOPE_KINDS = [
  "file",
  "directory",
  "glob",
  "generated",
  "migration-chain",
  "contract",
  "symbol",
  "architecture-node",
] as const;
export type WriteScopeKind = (typeof WRITE_SCOPE_KINDS)[number];

const PATH_FAMILY: readonly WriteScopeKind[] = ["file", "directory", "glob", "generated", "migration-chain"];

/** Iš kur write scope įrašas atsirado — verdikto įrodymo nuoroda. */
export type WriteScopeSource =
  | "allowed-paths"
  | "write-symbols"
  | "contracts"
  | "architecture-nodes"
  | "migration-chains"
  | "generated";

export type WriteScopeEntry = {
  kind: WriteScopeKind;
  /** Normalizuota reikšmė: keliams — POSIX be `./`, tapatybėms — sutraukti tarpai. */
  scope: string;
  source: WriteScopeSource;
};

export type EvidenceGapCode =
  /** Task'as nedeklaruoja nė vieno rašomo kelio — nėra ko lyginti. */
  | "no-declared-scope"
  /**
   * NERIBOTOS apimties wildcard scope: aprėptis neapibrėžta (spec PAR-2).
   *
   * Kelių šeimoje spraga nebeuždedama RIBOTAM šablonui — ≥2 segmentai, literalus katalogo
   * prefiksas, wildcard tik paskutiniame segmente, fiksuotas plėtinys ir ne migracijų kelias
   * (žr. `isBoundedGlobPattern`). Tokio šablono aprėptį `scopesConflict` apskaičiuoja, tad
   * įrodymas yra, ir spraga tik tyliai atimtų lygiagretumą.
   *
   * Tapatybių šeimoje (`pushIdentityEntries`) spraga LIEKA bet kokiam wildcard'ui: tapatybės
   * lyginamos tiksliai, tad wildcard tapatybė niekada nesutampa su konkrečia.
   */
  | "wildcard-scope"
  /** Kelias neišsprendžiamas (absoliutus, už repo ribų, `..`). */
  | "unresolvable-scope"
  /** Kontrakto suderinamumo nebuvo iš ko įrodyti (contract diff `unverified`). */
  | "unverified-contract";

export type EvidenceGap = {
  code: EvidenceGapCode;
  detail: string;
};

export type TaskWriteSet = {
  detector_version: number;
  task_id: string;
  entries: WriteScopeEntry[];
  gaps: EvidenceGap[];
  /**
   * `true` tik kai scope yra pilnai apibrėžtas. Tai BŪTINA, bet nepakankama paralelizavimo
   * sąlyga: neapibrėžtas write set negali būti įrodytas nepersidengiančiu su niekuo.
   */
  determinate: boolean;
  /** Turinio atspaudas: tas pats write set → tas pats verdiktas. */
  write_set_hash: string;
};

export type TaskWriteSetInput = {
  task_id: string;
  /** `## Failai` leistini keliai (`TaskNode.scope`) — vienintelė deklaracija, kurią turi kiekvienas task'as. */
  allowed_paths?: readonly string[] | undefined;
  /** Rašomi simboliai (`<path>#<symbol>` arba eksporto vardas) — `TaskNode.write_symbols`. */
  write_symbols?: readonly string[] | undefined;
  /** Public kontraktų tapatybės (`contract-diff#changedContractIds` forma). */
  contracts?: readonly string[] | undefined;
  /** Architektūros grafo mazgai, kuriuos task'as valdo vykdymo metu. */
  architecture_nodes?: readonly string[] | undefined;
  /** Migracijų grandinės, jei task'as jas liečia atskirai nuo kelių sąrašo. */
  migration_chains?: readonly string[] | undefined;
  /** Generuoti artefaktai, kuriuos task'as perrašo. */
  generated?: readonly string[] | undefined;
  /** Keliai iš contract diff, kurių suderinamumo įrodyti nepavyko (`unverifiedContractPaths`). */
  unverified_contract_paths?: readonly string[] | undefined;
};

// ---------------------------------------------------------------------------
// Normalizacija ir klasifikacija
// ---------------------------------------------------------------------------

function comparable(value: string): string {
  return value.toLowerCase();
}

/** Tapatybės (simbolis, kontraktas, architektūros mazgas): sutraukti tarpai, nukirpti kraštai. */
function normalizeIdentity(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function hasWildcard(value: string): boolean {
  return value.includes("*") || value.includes("?");
}

const FILE_EXTENSION = /\.[A-Za-z0-9]+$/;

/**
 * Ar glob'o šablono APIMTIS yra ribota, t. y. ar jį apskritai verta laikyti įrodytu.
 *
 * Predikatas tikrina TIK ŠABLONO FORMĄ ir NIEKADA neatsakinėja į klausimą „ar du glob'ai
 * kertasi" — tas klausimas lieka domain `scope-lock-rules.ts#scopesConflict` (failo antraštės
 * 2 taisyklė: scope semantika viena visai sistemai).
 *
 * Įėjimas privalo būti `normalizeScopeValue` apdorota reikšmė (`classified.scope`), niekada
 * `raw`: normalizacija nuima `./`, dubliuotus ir galinius `/`, be kurių segmentų skaičiavimas
 * meluotų.
 *
 * Ribotas yra tik šablonas, tenkinantis VISUS punktus:
 *
 *   1. yra bent vienas `*` (be jo tai apskritai ne glob'as);
 *   2. nėra `?`. `globMatches` be-`*` šakoje lygina prefiksu, o `wildcardPatternMatches` `?`
 *      escape'ina kaip RAIDĘ — deklaruota ir apskaičiuota aprėptis prasilenkia, tad `?` turintis
 *      šablonas įrodymu nelaikomas;
 *   3. nėra `**` niekur stringe (ne per segmentus: `src/a**b.ts` irgi turi kristi) — neribotas gylis;
 *   4. bent 2 segmentai. Vieno segmento šablono `solidPrefix` yra tuščias, o `pathContains(x, "")`
 *      visada `false`, tad `scope-lock-rules.ts:185` atsarginė šaka dingsta ir repo šaknį valdantis
 *      scope (`.`) nebesikirstų su `*.ts`;
 *   5. nė vienas segmentas, IŠSKYRUS paskutinį, neturi `*` — katalogo prefiksas privalo būti literalus;
 *   6. paskutinis segmentas turi fiksuotą plėtinį (`FILE_EXTENSION`);
 *   7. tai ne migracijų kelias. `classifyWriteScopePath` wildcard'ą sprendžia PRIEŠ migraciją, tad
 *      `db/migrations/*.sql` yra kind `glob`, o globalios serializacijos taisyklė
 *      (`scope-lock-rules.ts:173`) reikalauja `migration-chain` ABIEJOSE pusėse. Panaikinus spragą
 *      tokia migracija taptų lygiagrečia su kita grandine — būtent to taisyklė ir neleidžia.
 *
 * Kodėl tai saugu keliams: tokiam šablonui `globMatches` patenka į `wildcardPatternMatches` šaką
 * be gylio, o `scopesConflict` glob-vs-kelias šaka papildomai tikrina
 * `pathContains(kelias, solidPrefix(glob))` — tad sankirtą duoda ir katalogas-konteineris
 * (`src` vs `src/tests/a-*.test.ts`), ir bet koks šabloną atitinkantis failas.
 *
 * ĮSPĖJIMAS: šio predikato saugumas remiasi `solidPrefix`/`globMatches` elgesiu. Keičiant juos,
 * šis predikatas privalo būti to paties keitimo dalis.
 */
function isBoundedGlobPattern(normalizedScope: string): boolean {
  if (!normalizedScope.includes("*")) return false;
  if (normalizedScope.includes("?")) return false;
  if (normalizedScope.includes("**")) return false;

  const segments = normalizedScope.split("/");
  if (segments.length < 2) return false;

  const last = segments[segments.length - 1];
  if (last === undefined) return false;
  for (const segment of segments.slice(0, -1)) {
    if (segment.includes("*")) return false;
  }
  if (!FILE_EXTENSION.test(last)) return false;

  return !isMigrationPath(normalizedScope);
}

/**
 * Kelio rūšis. Tvarka yra taisyklė, nes kelias gali atitikti kelis šablonus vienu metu:
 *
 *   1. wildcard — neapibrėžta aprėptis nusveria viską (spec PAR-2). Su viena išlyga: rūšį `glob`
 *      wildcard nusveria besąlygiškai, bet ĮRODYMO SPRAGOS jis nebeuždeda, jei šablono apimtis
 *      ribota (`isBoundedGlobPattern`). Kadangi ši rūšis aplenkia ir migracijų grandinę, ribotumo
 *      predikatas migracijų kelius atmeta atskirai — kitaip `db/migrations/*.sql` prasprūstų pro
 *      globalią serializaciją;
 *   2. migracijų grandinė — serializuojama globaliai, tad rūšis privalo išlikti net generated kelyje;
 *   3. generuotas artefaktas — jo turinys išvestinis, o rašytojų gali būti keli;
 *   4. katalogas — baigiasi `/` arba neturi plėtinio;
 *   5. failas.
 *
 * Žinoma riba, dokumentuojama sąmoningai: plėtinio neturintis FAILAS (`Makefile`, `LICENSE`) bus
 * palaikytas katalogu. Klaida krypsta į perteklinį konfliktą, t. y. į nuoseklų vykdymą.
 */
export function classifyWriteScopePath(rawPath: string): { kind: WriteScopeKind; scope: string } {
  const value = normalizeScopeValue(rawPath);
  if (hasWildcard(value)) return { kind: "glob", scope: value };
  if (isMigrationPath(value)) return { kind: "migration-chain", scope: value };
  if (isGeneratedPath(value)) return { kind: "generated", scope: value };
  const endsWithSeparator = rawPath.trim().replace(/\\/g, "/").endsWith("/");
  if (endsWithSeparator || !FILE_EXTENSION.test(value)) return { kind: "directory", scope: value };
  return { kind: "file", scope: value };
}

function pushPathEntries(
  values: readonly string[] | undefined,
  source: WriteScopeSource,
  forcedKind: WriteScopeKind | undefined,
  entries: WriteScopeEntry[],
  gaps: EvidenceGap[],
): void {
  for (const raw of values ?? []) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let classified: { kind: WriteScopeKind; scope: string };
    try {
      classified = classifyWriteScopePath(trimmed);
    } catch (error: unknown) {
      gaps.push({
        code: "unresolvable-scope",
        detail: `${source}: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const kind = forcedKind ?? classified.kind;
    if (kind === "glob" && !isBoundedGlobPattern(classified.scope)) {
      gaps.push({ code: "wildcard-scope", detail: `${source}: '${classified.scope}' aprėptis neapibrėžta` });
    }
    entries.push({ kind, scope: classified.scope, source });
  }
}

function pushIdentityEntries(
  values: readonly string[] | undefined,
  kind: Extract<WriteScopeKind, "contract" | "symbol" | "architecture-node">,
  source: WriteScopeSource,
  entries: WriteScopeEntry[],
  gaps: EvidenceGap[],
): void {
  for (const raw of values ?? []) {
    const scope = normalizeIdentity(raw);
    if (!scope) continue;
    // Ribotumo predikatas (`isBoundedGlobPattern`) čia SĄMONINGAI netaikomas. `entriesConflict`
    // tapatybes lygina TIKSLIAI (`comparable(a) === comparable(b)`), tad wildcard tapatybė niekada
    // nesutaps su konkrečia: panaikinus spragą ji virstų nemokamu leidimu — `write_symbols:
    // ["src/shared/*.ts"]` prieš `["src/shared/util.ts"]` duotų `independent: true`. Spraga čia yra
    // vienintelis apsaugos mechanizmas ir galios tol, kol tapatybėms atsiras jas suprantantis
    // lygintuvas. Tai sąmoningas nukrypimas nuo užduoties 035-a-02 `## Veiksmas` teksto, kuris
    // predikatą taikė abiem šeimoms.
    if (hasWildcard(scope)) {
      gaps.push({ code: "wildcard-scope", detail: `${source}: '${scope}' aprėptis neapibrėžta` });
    }
    entries.push({ kind, scope, source });
  }
}

function compareEntries(a: WriteScopeEntry, b: WriteScopeEntry): number {
  return a.kind.localeCompare(b.kind) || a.scope.localeCompare(b.scope) || a.source.localeCompare(b.source);
}

function dedupeEntries(entries: readonly WriteScopeEntry[]): WriteScopeEntry[] {
  const byKey = new Map<string, WriteScopeEntry>();
  for (const entry of [...entries].sort(compareEntries)) {
    const key = `${entry.kind}:${comparable(entry.scope)}`;
    if (!byKey.has(key)) byKey.set(key, entry);
  }
  return [...byKey.values()].sort(compareEntries);
}

function dedupeGaps(gaps: readonly EvidenceGap[]): EvidenceGap[] {
  const byKey = new Map<string, EvidenceGap>();
  for (const gap of gaps) byKey.set(`${gap.code}:${gap.detail}`, gap);
  return [...byKey.values()].sort((a, b) => a.code.localeCompare(b.code) || a.detail.localeCompare(b.detail));
}

/**
 * Vieno task'o pilnas write set: failai, simboliai, kontraktai, architektūros mazgai, migracijos ir
 * generuoti artefaktai.
 *
 * Trūkstamos dimensijos NĖRA tuščios dimensijos. Nedeklaruoti keliai yra `no-declared-scope`
 * spraga, nes be jų nėra ko lyginti; nedeklaruoti simboliai spragos nesukuria, nes juos apima tų
 * pačių failų kelių sankirta — simbolių lygmuo tik SUSIAURINA, o ne praplečia, ir jo nebuvimas
 * niekada nepadaro verdikto optimistiškesnio.
 */
export function computeTaskWriteSet(input: TaskWriteSetInput): TaskWriteSet {
  const entries: WriteScopeEntry[] = [];
  const gaps: EvidenceGap[] = [];

  pushPathEntries(input.allowed_paths, "allowed-paths", undefined, entries, gaps);
  pushPathEntries(input.migration_chains, "migration-chains", "migration-chain", entries, gaps);
  pushPathEntries(input.generated, "generated", "generated", entries, gaps);
  pushIdentityEntries(input.write_symbols, "symbol", "write-symbols", entries, gaps);
  pushIdentityEntries(input.contracts, "contract", "contracts", entries, gaps);
  pushIdentityEntries(input.architecture_nodes, "architecture-node", "architecture-nodes", entries, gaps);

  for (const rawPath of input.unverified_contract_paths ?? []) {
    const value = rawPath.trim();
    if (!value) continue;
    gaps.push({ code: "unverified-contract", detail: `kontrakto suderinamumas nepatikrintas: '${value}'` });
  }

  const hasPathScope = entries.some((entry) => PATH_FAMILY.includes(entry.kind));
  if (!hasPathScope) {
    gaps.push({ code: "no-declared-scope", detail: `task ${input.task_id} nedeklaruoja nė vieno rašomo kelio` });
  }

  const normalizedEntries = dedupeEntries(entries);
  const normalizedGaps = dedupeGaps(gaps);
  const writeSet: Omit<TaskWriteSet, "write_set_hash"> = {
    detector_version: CONFLICT_DETECTOR_VERSION,
    task_id: input.task_id,
    entries: normalizedEntries,
    gaps: normalizedGaps,
    determinate: normalizedGaps.length === 0,
  };

  return { ...writeSet, write_set_hash: computeWriteSetHash(writeSet) };
}

/** Write set atspaudas. Hash'uojama tik tai, kas keičia verdiktą — įrašai ir įrodymo spragos. */
export function computeWriteSetHash(writeSet: Omit<TaskWriteSet, "write_set_hash">): string {
  const payload = {
    version: writeSet.detector_version,
    task: writeSet.task_id,
    entries: writeSet.entries.map((entry) => ({ kind: entry.kind, scope: comparable(entry.scope) })),
    gaps: writeSet.gaps.map((gap) => gap.code),
  };
  const digest = createHash("sha256").update(canonicalJsonStringify(payload), "utf8").digest("hex");
  return `ws${CONFLICT_DETECTOR_VERSION}:${digest.slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// Sankirtos
// ---------------------------------------------------------------------------

export type WriteSetConflict = {
  kind: WriteScopeKind;
  left: WriteScopeEntry;
  right: WriteScopeEntry;
  reason: string;
};

export type ScopedEvidenceGap = EvidenceGap & { task_id: string };

export type IndependenceVerdict = {
  detector_version: number;
  left_task_id: string;
  right_task_id: string;
  /** `true` tik kai NĖRA nė vienos sankirtos IR nė vienos įrodymo spragos. */
  independent: boolean;
  conflicts: WriteSetConflict[];
  evidence_gaps: ScopedEvidenceGap[];
  reason: string;
  /** Simetrinis atspaudas: `(a,b)` ir `(b,a)` yra tas pats sprendimas. */
  verdict_hash: string;
};

function isPathFamily(kind: WriteScopeKind): boolean {
  return PATH_FAMILY.includes(kind);
}

/** Kelių šeimos rūšis → scope lock rūšis. Abu vartai privalo reikšti tą patį (žr. failo antraštę). */
function toScopeLockKind(kind: WriteScopeKind): ScopeLockKind {
  switch (kind) {
    case "file":
      return "file";
    case "directory":
      return "directory";
    case "glob":
      return "glob";
    case "generated":
      return "generated";
    case "migration-chain":
      return "migration-chain";
    default:
      // Tapatybių šeima čia niekada nepatenka — `entriesConflict` ją atskiria anksčiau.
      throw new Error(`write scope kind '${kind}' is not a path-family kind`);
  }
}

function conflictReason(left: WriteScopeEntry, right: WriteScopeEntry): string {
  if (left.kind === "migration-chain" && right.kind === "migration-chain") {
    return `migracijų grandinės serializuojamos globaliai: '${left.scope}' ir '${right.scope}'`;
  }
  if (isPathFamily(left.kind)) {
    return `persidengiantis ${left.kind}/${right.kind} scope: '${left.scope}' vs '${right.scope}'`;
  }
  return `tas pats ${left.kind}: '${left.scope}'`;
}

function entriesConflict(left: WriteScopeEntry, right: WriteScopeEntry): boolean {
  const leftIsPath = isPathFamily(left.kind);
  const rightIsPath = isPathFamily(right.kind);

  if (leftIsPath && rightIsPath) {
    return scopesConflict({ kind: toScopeLockKind(left.kind), scope: left.scope }, { kind: toScopeLockKind(right.kind), scope: right.scope });
  }
  // Skirtingos dimensijos nesikerta: simbolis nėra kelias, o architektūros mazgas nėra kontraktas.
  // Kelių sankirta tarp tų pačių failų vis tiek pagaunama kelių šeimoje.
  if (leftIsPath !== rightIsPath) return false;
  if (left.kind !== right.kind) return false;
  return comparable(left.scope) === comparable(right.scope);
}

/** Visos dviejų write set'ų sankirtos, deterministine tvarka. */
export function findWriteSetConflicts(left: TaskWriteSet, right: TaskWriteSet): WriteSetConflict[] {
  const conflicts: WriteSetConflict[] = [];
  for (const leftEntry of left.entries) {
    for (const rightEntry of right.entries) {
      if (!entriesConflict(leftEntry, rightEntry)) continue;
      conflicts.push({
        kind: leftEntry.kind,
        left: leftEntry,
        right: rightEntry,
        reason: conflictReason(leftEntry, rightEntry),
      });
    }
  }
  return conflicts.sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.left.scope.localeCompare(b.left.scope) || a.right.scope.localeCompare(b.right.scope),
  );
}

function verdictHash(left: TaskWriteSet, right: TaskWriteSet): string {
  const hashes = [left.write_set_hash, right.write_set_hash].sort();
  const digest = createHash("sha256")
    .update(canonicalJsonStringify({ version: CONFLICT_DETECTOR_VERSION, sets: hashes }), "utf8")
    .digest("hex");
  return `iv${CONFLICT_DETECTOR_VERSION}:${digest.slice(0, 16)}`;
}

/**
 * Vienintelis vartas, per kurį gimsta sprendimas „šituos du galima vykdyti lygiagrečiai".
 *
 * Verdiktas yra `independent` TIK tada, kai visos write set sankirtos tuščios IR nė viena pusė
 * neturi įrodymo spragos. Bet kuris kitas atvejis — įskaitant tą patį task'ą, paduotą du kartus —
 * reiškia nuoseklų vykdymą. Grąžinamos VISOS priežastys, o ne pirma: operatoriui svarbu matyti,
 * kiek dimensijų persidengia, o ne tik faktą „ne".
 */
export function evaluateWriteSetIndependence(left: TaskWriteSet, right: TaskWriteSet): IndependenceVerdict {
  const gaps: ScopedEvidenceGap[] = [
    ...left.gaps.map((gap) => ({ ...gap, task_id: left.task_id })),
    ...right.gaps.map((gap) => ({ ...gap, task_id: right.task_id })),
  ];
  const sameTask = comparable(left.task_id.trim()) === comparable(right.task_id.trim());
  const conflicts = sameTask ? [] : findWriteSetConflicts(left, right);

  const independent = !sameTask && conflicts.length === 0 && gaps.length === 0;
  const reason = sameTask
    ? `tas pats task'as '${left.task_id}' negali užimti dviejų worker'ių`
    : independent
      ? `write set'ai nesikerta nė vienoje dimensijoje (${left.entries.length}+${right.entries.length} įrašai)`
      : [
          conflicts.length > 0 ? `${conflicts.length} sankirta(-os): ${conflicts.map((entry) => entry.reason).join("; ")}` : "",
          gaps.length > 0 ? `${gaps.length} įrodymo spraga(-os): ${gaps.map((gap) => `${gap.task_id}/${gap.code}`).join(", ")}` : "",
        ]
          .filter(Boolean)
          .join(" | ");

  return {
    detector_version: CONFLICT_DETECTOR_VERSION,
    left_task_id: left.task_id,
    right_task_id: right.task_id,
    independent,
    conflicts,
    evidence_gaps: gaps,
    reason,
    verdict_hash: verdictHash(left, right),
  };
}
