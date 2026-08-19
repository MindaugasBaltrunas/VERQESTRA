// Duomenų kontraktų ekstrakcija: JSON config raktai, OpenAPI maršrutai, SQL lentelės,
// Prisma modeliai ir migracijų teiginiai. Behaviour etalon: AG_loop
// application/integration/contract-diff.ts config/DB blokai (1:1; skaidymas
// scan/extract/diff pagal 500 eil. gate).

import type { ContractDescriptor } from "./contract-model.js";
import { balancedBlock, dedupeById, lineAt, normalizeSignature, topLevelSegments } from "./contract-scan.js";
import { routeDescriptor } from "./contract-extract-code.js";

// ---------------------------------------------------------------------------
// Config schema (JSON)
// ---------------------------------------------------------------------------

function jsonValueKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function flattenJson(prefix: string, value: unknown, out: Map<string, { kind: string; members: string[] }>): void {
  const kind = jsonValueKind(value);
  if (kind === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    out.set(prefix, { kind, members: keys });
    for (const key of keys) {
      flattenJson(prefix ? `${prefix}.${key}` : key, record[key], out);
    }
    return;
  }
  if (kind === "array") {
    // Masyvo nariai yra reikšmės, ne indeksai: konfigūracijose masyvas beveik visada yra
    // AIBĖ (leidžiami keliai, blokuojami šablonai), tad įrašo pašalinimas iš jos yra
    // kontrakto atėmimas, o ilgio pokytis pats savaime — ne.
    const items = (value as unknown[])
      .filter((item) => item === null || typeof item !== "object")
      .map((item) => String(item))
      .sort();
    out.set(prefix, { kind, members: items });
    return;
  }
  out.set(prefix, { kind, members: [] });
}

export function extractConfigKeys(filePath: string, text: string): ContractDescriptor[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Nevalidus JSON nėra „nėra kontrakto": jo raktų patikrinti negalima, todėl kelias
    // grąžinamas kaip nepatikrintas (žr. `isUnparsable`) per tuščią rezultatą + žymę.
    return [];
  }
  const flat = new Map<string, { kind: string; members: string[] }>();
  flattenJson("", parsed, flat);
  const out: ContractDescriptor[] = [];
  for (const [key, info] of flat) {
    if (!key) continue; // šaknis nėra raktas
    out.push({
      kind: "config-key",
      id: `config-key:${filePath}#${key}`,
      path: filePath,
      signature: info.kind,
      members: info.members,
      line: 1,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** OpenAPI-formos JSON: `paths./x.get` virsta pilnaverčiu maršruto kontraktu. */
export function extractJsonRoutes(filePath: string, text: string): ContractDescriptor[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const paths = (parsed as Record<string, unknown>)["paths"];
  if (paths === null || typeof paths !== "object" || Array.isArray(paths)) return [];
  const out: ContractDescriptor[] = [];
  for (const [routePath, methods] of Object.entries(paths as Record<string, unknown>)) {
    if (methods === null || typeof methods !== "object" || Array.isArray(methods)) continue;
    for (const method of Object.keys(methods)) {
      if (!/^(get|post|put|patch|delete|head|options)$/i.test(method)) continue;
      out.push(routeDescriptor(filePath, method, routePath, 1));
    }
  }
  return dedupeById(out);
}

// ---------------------------------------------------------------------------
// DB entities ir migracijos
// ---------------------------------------------------------------------------

const CREATE_TABLE = /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?["`[]?([A-Za-z_][\w.$]*)["`\]]?\s*\(/gi;
const PRISMA_MODEL = /^\s*model\s+([A-Za-z_][\w]*)\s*\{/gm;
const DESTRUCTIVE_SQL = /\b(?:drop\s+(?:table|column|schema|index|constraint|database)|truncate\s+table)\b/i;
const ALTER_DROP = /\balter\s+table\b[\s\S]{0,400}?\bdrop\b/i;

function sqlColumnNames(block: string): string[] {
  const names: string[] = [];
  for (const segment of topLevelSegments(block)) {
    // Lentelės apribojimai (PRIMARY KEY, CONSTRAINT, ...) nėra stulpeliai.
    if (/^(?:primary|foreign|unique|constraint|check|index|key)\b/i.test(segment)) continue;
    const match = /^["`[]?([A-Za-z_][\w$]*)["`\]]?/.exec(segment);
    if (match?.[1]) names.push(match[1]);
  }
  return [...new Set(names)].sort();
}

export function extractSqlEntities(filePath: string, text: string): ContractDescriptor[] {
  const out: ContractDescriptor[] = [];
  const re = new RegExp(CREATE_TABLE.source, CREATE_TABLE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const table = match[1] as string;
    const block = balancedBlock(text, match.index, "(");
    out.push({
      kind: "db-entity",
      id: `db-entity:${table.toLowerCase()}`,
      path: filePath,
      signature: `table ${table.toLowerCase()}`,
      members: sqlColumnNames(block ?? ""),
      line: lineAt(text, match.index),
    });
  }
  return dedupeById(out);
}

export function extractPrismaModels(filePath: string, text: string): ContractDescriptor[] {
  const out: ContractDescriptor[] = [];
  const re = new RegExp(PRISMA_MODEL.source, PRISMA_MODEL.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const model = match[1] as string;
    const block = balancedBlock(text, match.index, "{");
    // `@@index(...)` / `@@map(...)` bloko atributai neprasideda identifikatoriumi, tad
    // regexas juos praleidžia savaime — jie nėra modelio laukai.
    const fields = (block ?? "")
      .split(/\r?\n/)
      .map((row) => /^\s*([A-Za-z_][\w]*)\s+\S/.exec(row)?.[1])
      .filter((value): value is string => value !== undefined);
    out.push({
      kind: "db-entity",
      id: `db-entity:${model.toLowerCase()}`,
      path: filePath,
      signature: `model ${model.toLowerCase()}`,
      members: [...new Set(fields)].sort(),
      line: lineAt(text, match.index),
    });
  }
  return dedupeById(out);
}

/** Migracijos teiginiai normalizuota forma — jų pokytis reiškia perrašytą migraciją. */
export function extractMigration(filePath: string, text: string): ContractDescriptor {
  const statements = text
    .split(";")
    .map((statement) => normalizeSignature(statement).toLowerCase())
    .filter(Boolean);
  return {
    kind: "db-migration",
    id: `db-migration:${filePath}`,
    path: filePath,
    signature: `migration ${statements.length} statement(s)`,
    members: statements,
    line: 1,
  };
}

export function migrationIsDestructive(descriptor: ContractDescriptor): boolean {
  return descriptor.members.some((statement) => DESTRUCTIVE_SQL.test(statement) || ALTER_DROP.test(statement));
}
