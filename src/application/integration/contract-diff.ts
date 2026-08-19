// Public contract diff (spec IVER-2, design §11 „Integration verifier"). Behaviour etalon:
// AG_loop application/integration/contract-diff.ts (etalono 937 eil. failas skaidomas į
// contract-model / contract-scan / contract-extract-code / contract-extract-data /
// contract-diff pagal 500 eil. gate; taisyklės 1:1; kelių klasifikacija —
// contract-paths.ts, FQC-12).
//
// `create-integration-plan.ts` atsako į klausimą „KURIE commit'ai ir kokia tvarka sudaro
// bangą". Jis nieko nesako apie tai, ar tų commit'ų TURINYS yra tarpusavyje suderinamas.
// Šis modulis yra tas trūkstamas turinio vartas: palygina bangos DVI revizijas (prieš ir
// po) ir grąžina kiekvieno public kontrakto pokytį su breaking-risk verdiktu ir įrodymais.
//
// TRYS savybės, kurios čia yra taisyklė, o ne įgyvendinimo detalė:
//
//   1. FAILŲ DIFF NĖRA ĮRODYMAS. Pakeistas kontraktus galintis nešti failas, kurio TURINIO
//      modulis negavo, virsta `unverified` įrašu — ne tyliu „suderinama". `unverified`
//      blokuoja lygiai taip pat kaip `breaking`; įrodymo nebuvimas niekada nevirsta leidimu.
//   2. ANALIZĖ YRA FORMOS, NE SEMANTIKOS. Tik tokia analizė yra atkuriama: tas pats įėjimas
//      visada duoda tą patį verdiktą ir tą patį `diff_hash`. Semantinė (LLM) peržiūra pagal
//      spec IVER-3 leidžiama TIK atskirai ir tik esant `review-required` rizikai.
//   3. MODULIS YRA GRYNAS. Jokio FS, git, laikrodžio ar atsitiktinumo: revizijų turinį
//      paduoda kvietėjas, todėl tą patį verdiktą galima perskaičiuoti po restart'o.

import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "../../shared/json.js";
import { toComparablePosixPath as toPosix } from "../../shared/paths.js";
import type {
  ContractBreakingRisk,
  ContractDescriptor,
  ContractDiffEntry,
  ContractDiffInput,
  ContractDiffReport,
  ContractEvidence,
  ContractKind,
  ContractRevision,
  ContractSourceFile,
} from "./contract-model.js";
import {
  isContractBearingPath,
  isGeneratedPath,
  isJsonContractPath,
  isMigrationPath,
  isPrismaContractPath,
  isSqlContractPath,
  isTsContractPath,
} from "./contract-paths.js";
import { extractApiRoutes, extractTsExports } from "./contract-extract-code.js";
import {
  extractConfigKeys,
  extractJsonRoutes,
  extractMigration,
  extractPrismaModels,
  extractSqlEntities,
  // Destruktyvumo taisyklės savininkas — extract-data (FQC-12); čia tik jos taikymas
  // pridėjimo rizikai.
  migrationIsDestructive,
} from "./contract-extract-data.js";

/** Diff taisyklių versija. Įeina į `diff_hash`, tad pakeitus taisykles seni verdiktai tampa stale. */
export const CONTRACT_DIFF_VERSION = 1;

// ---------------------------------------------------------------------------
// Ištraukimas iš vieno failo
// ---------------------------------------------------------------------------

/** Visi kontraktai, kuriuos galima įrodyti iš vieno failo turinio. */
export function extractContracts(file: ContractSourceFile): ContractDescriptor[] {
  const filePath = toPosix(file.path);
  const text = file.text;
  if (!filePath || text === undefined) return [];

  const out: ContractDescriptor[] = [];
  if (isTsContractPath(filePath)) {
    out.push(...extractTsExports(filePath, text));
    out.push(...extractApiRoutes(filePath, text));
  }
  if (isJsonContractPath(filePath)) {
    out.push(...extractConfigKeys(filePath, text));
    out.push(...extractJsonRoutes(filePath, text));
  }
  if (isSqlContractPath(filePath)) {
    out.push(...extractSqlEntities(filePath, text));
    if (isMigrationPath(filePath)) out.push(extractMigration(filePath, text));
  }
  if (isPrismaContractPath(filePath)) {
    out.push(...extractPrismaModels(filePath, text));
  }
  return out;
}

/** Failas, kurio kontraktų ištraukti nepavyko, nors kelias juos nešti gali. */
function isUnparsable(file: ContractSourceFile, descriptors: readonly ContractDescriptor[]): boolean {
  if (file.text === undefined) return true;
  if (descriptors.length > 0) return false;
  // Tuščias TS failas be eksportų yra teisėtas „nėra kontrakto"; sugadintas JSON — ne.
  if (isJsonContractPath(toPosix(file.path))) {
    try {
      JSON.parse(file.text);
      return false;
    } catch {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

type RevisionIndex = {
  byId: Map<string, ContractDescriptor>;
  paths: Map<string, ContractSourceFile>;
  unparsable: Set<string>;
};

function indexRevision(files: readonly ContractSourceFile[]): RevisionIndex {
  const byId = new Map<string, ContractDescriptor>();
  const paths = new Map<string, ContractSourceFile>();
  const unparsable = new Set<string>();
  // Rūšiuojama pagal kelią, nes kelių failų dalijamasi tapatybe (tas pats maršrutas ar
  // lentelė gali būti deklaruota dviejose vietose). Be rūšiavimo verdiktas priklausytų nuo
  // to, kokia tvarka kvietėjas padavė failus — o `diff_hash` privalo priklausyti tik nuo turinio.
  const ordered = [...files].sort((a, b) => toPosix(a.path).localeCompare(toPosix(b.path)));
  for (const file of ordered) {
    const filePath = toPosix(file.path);
    if (!filePath) continue;
    paths.set(filePath, file);
    const descriptors = extractContracts(file);
    if (isUnparsable(file, descriptors)) unparsable.add(filePath);
    for (const descriptor of descriptors) {
      // Tas pats `id` dviejuose failuose (pvz. tas pats maršrutas dviejose vietose) — pirmas
      // laimi, bet abu keliai lieka `paths` žemėlapyje, tad įrodymai nedingsta.
      if (!byId.has(descriptor.id)) byId.set(descriptor.id, descriptor);
    }
  }
  return { byId, paths, unparsable };
}

function evidenceOf(descriptor: ContractDescriptor | undefined, revision: ContractRevision): ContractEvidence[] {
  if (!descriptor) return [];
  return [{ revision, path: descriptor.path, line: descriptor.line, excerpt: descriptor.signature }];
}

/**
 * Rizikos taisyklės. Kiekviena remiasi TIK palyginamais faktais, tad verdiktas yra atkuriamas.
 *
 * - pašalintas kontraktas → `breaking`; dingę nariai → `breaking`; pasikeitęs parašas →
 *   `breaking`; TIK pridėti nariai → `potential`; pridėtas kontraktas → `none`, IŠSKYRUS
 *   config raktą (`potential`) ir destruktyvią migraciją (`breaking`).
 */
function riskForChange(
  kind: ContractKind,
  before: ContractDescriptor,
  after: ContractDescriptor,
): { risk: ContractBreakingRisk; reasons: string[] } {
  const reasons: string[] = [];
  const beforeMembers = new Set(before.members);
  const afterMembers = new Set(after.members);
  const removed = before.members.filter((member) => !afterMembers.has(member));
  const added = after.members.filter((member) => !beforeMembers.has(member));

  if (removed.length > 0) {
    reasons.push(`removed ${kind} member(s): ${removed.join(", ")}`);
  }
  if (before.signature !== after.signature) {
    reasons.push(`signature changed: "${before.signature}" -> "${after.signature}"`);
  }
  if (added.length > 0) {
    reasons.push(`added ${kind} member(s): ${added.join(", ")}`);
  }

  if (removed.length > 0 || before.signature !== after.signature) {
    return { risk: "breaking", reasons };
  }
  if (added.length > 0) {
    return { risk: "potential", reasons };
  }
  // Nė vieno palyginamo skirtumo: kontraktas nepasikeitė, nors failas galėjo.
  return { risk: "none", reasons };
}

function riskForAdded(descriptor: ContractDescriptor): { risk: ContractBreakingRisk; reasons: string[] } {
  if (descriptor.kind === "config-key") {
    return {
      risk: "potential",
      reasons: [`new config key "${descriptor.id}" is absent from existing configuration files`],
    };
  }
  if (descriptor.kind === "db-migration" && migrationIsDestructive(descriptor)) {
    return { risk: "breaking", reasons: [`new migration contains a destructive statement`] };
  }
  return { risk: "none", reasons: [`added ${descriptor.kind}`] };
}

/**
 * Generated-drift taisyklė. Generuojamo artefakto kontraktas yra IŠVESTINIS. Jei bangoje
 * pasikeitė TIK generuojami artefaktai, o nė vienas šaltinio kontraktas — tai reiškia arba
 * ranka redaguotą generuojamą failą, arba pasenusį generatorių. Nė vieno iš jų negalima
 * įrodyti suderinamu iš paties artefakto, todėl įrašai virsta `unverified`.
 */
function applyGeneratedDrift(entries: ContractDiffEntry[]): void {
  const changed = entries.filter((entry) => entry.change !== "unverified");
  if (changed.length === 0) return;
  const generated = changed.filter((entry) => isGeneratedPath(entry.after?.path ?? entry.before?.path ?? ""));
  if (generated.length === 0 || generated.length !== changed.length) return;
  for (const entry of generated) {
    entry.breaking_risk = "unverified";
    entry.reasons.push("generated-drift: generated artifact changed with no corresponding source contract change");
  }
}

function unverifiedEntry(filePath: string, reason: string, revision: ContractRevision): ContractDiffEntry {
  return {
    kind: "ts-export",
    id: `unverified:${filePath}`,
    change: "unverified",
    breaking_risk: "unverified",
    reasons: [reason],
    evidence: [{ revision, path: filePath, excerpt: reason }],
  };
}

/**
 * Palygina dvi bangos revizijas ir grąžina pilną kontraktų pokyčių sąrašą.
 *
 * Rezultatas grąžinamas VISADA — sprendimą, ką daryti su nesuderinamu kontraktu, priima
 * bangos vartai (`run-wave-gates.ts`), ne šis modulis. `compatible: false` reiškia „banga
 * negali būti priimta be žmogaus sprendimo", o ne „diff nepavyko".
 */
export function diffContracts(input: ContractDiffInput): ContractDiffReport {
  const before = indexRevision(input.before);
  const after = indexRevision(input.after);
  const entries: ContractDiffEntry[] = [];

  const ids = [...new Set([...before.byId.keys(), ...after.byId.keys()])].sort();
  for (const id of ids) {
    const beforeDescriptor = before.byId.get(id);
    const afterDescriptor = after.byId.get(id);
    const kind = (afterDescriptor ?? beforeDescriptor)!.kind;
    const evidence = [...evidenceOf(beforeDescriptor, "before"), ...evidenceOf(afterDescriptor, "after")];

    if (beforeDescriptor && !afterDescriptor) {
      entries.push({
        kind,
        id,
        change: "removed",
        before: beforeDescriptor,
        breaking_risk: "breaking",
        reasons: [`removed ${kind} "${id}"`],
        evidence,
      });
      continue;
    }
    if (!beforeDescriptor && afterDescriptor) {
      const verdict = riskForAdded(afterDescriptor);
      entries.push({
        kind,
        id,
        change: "added",
        after: afterDescriptor,
        breaking_risk: verdict.risk,
        reasons: verdict.reasons,
        evidence,
      });
      continue;
    }
    if (!beforeDescriptor || !afterDescriptor) continue;

    const verdict = riskForChange(kind, beforeDescriptor, afterDescriptor);
    if (verdict.risk === "none" && verdict.reasons.length === 0) continue;
    entries.push({
      kind,
      id,
      change: "changed",
      before: beforeDescriptor,
      after: afterDescriptor,
      breaking_risk: verdict.risk,
      reasons: verdict.reasons,
      evidence,
    });
  }

  applyGeneratedDrift(entries);

  // Nepatikrinti keliai. Du atvejai, abu vienodai blokuojantys:
  //   a) failas revizijoje YRA, bet turinys nepateiktas arba neišnagrinėjamas;
  //   b) bangos paliestas kontraktus galintis nešti kelias, apie kurį nėra NIEKO.
  const unverifiedPaths = new Set<string>();
  for (const filePath of before.unparsable) unverifiedPaths.add(filePath);
  for (const filePath of after.unparsable) unverifiedPaths.add(filePath);
  for (const rawPath of input.changedPaths ?? []) {
    const filePath = toPosix(rawPath);
    if (!filePath || !isContractBearingPath(filePath)) continue;
    if (before.paths.has(filePath) || after.paths.has(filePath)) continue;
    unverifiedPaths.add(filePath);
  }
  for (const filePath of [...unverifiedPaths].sort()) {
    const known = after.paths.get(filePath) ?? before.paths.get(filePath);
    const reason = known
      ? `contract content for "${filePath}" is unavailable or unparsable, so compatibility cannot be proven`
      : `changed path "${filePath}" was not supplied in either revision, so a file diff is the only evidence`;
    entries.push(unverifiedEntry(filePath, reason, after.paths.has(filePath) ? "after" : "before"));
  }

  const blocking = entries.filter(
    (entry) => entry.breaking_risk === "breaking" || entry.breaking_risk === "unverified",
  );

  const report: Omit<ContractDiffReport, "diff_hash"> = {
    diff_version: CONTRACT_DIFF_VERSION,
    entries,
    unverified_paths: [...unverifiedPaths].sort(),
    compatible: blocking.length === 0,
    blocking,
  };

  return { ...report, diff_hash: computeContractDiffHash(report) };
}

/**
 * Kontraktų TAPATYBĖS, kurias pokytis rašo — conflict detector'iaus įėjimas.
 *
 * Į rinkinį patenka kiekvienas įrašas, kuris NĖRA `unverified`: pridėtas, pašalintas ar
 * pakeistas kontraktas yra šio task'o write scope, net jei jo rizika yra `none`.
 * Nepatikrinti įrašai čia praleidžiami sąmoningai — jie nėra „kontraktas, kurį rašome",
 * o įrodymo spraga, ir juos neša {@link unverifiedContractPaths}.
 */
export function changedContractIds(report: ContractDiffReport): string[] {
  return [...new Set(report.entries.filter((entry) => entry.change !== "unverified").map((entry) => entry.id))].sort();
}

/**
 * Keliai, kurių kontraktų suderinamumo nebuvo iš ko įrodyti. Detektoriui tai yra kieta
 * paralelizavimo kliūtis: neįrodytas kontraktas negali būti įrodytas ir nepersidengiančiu.
 */
export function unverifiedContractPaths(report: ContractDiffReport): string[] {
  return [...report.unverified_paths].sort();
}

/**
 * Diff atspaudas. Hash'uojama tik tai, kas keičia VERDIKTĄ — kontrakto tapatybė, pokyčio
 * tipas, rizika ir abiejų pusių parašai. Įrodymų nuorodos ir priežasčių tekstai iš jų
 * išvedami, todėl į atspaudą neįeina: tas pats `diff_hash` visada reiškia „tas pats
 * suderinamumo sprendimas", o ne „ta pati formuluotė".
 */
export function computeContractDiffHash(report: Omit<ContractDiffReport, "diff_hash">): string {
  const payload = {
    version: report.diff_version,
    entries: report.entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      change: entry.change,
      risk: entry.breaking_risk,
      before: entry.before ? { signature: entry.before.signature, members: entry.before.members } : null,
      after: entry.after ? { signature: entry.after.signature, members: entry.after.members } : null,
    })),
    unverified: report.unverified_paths,
  };
  const digest = createHash("sha256").update(canonicalJsonStringify(payload), "utf8").digest("hex");
  return `cd${CONTRACT_DIFF_VERSION}:${digest.slice(0, 16)}`;
}
