// Kodo kontraktų ekstrakcija: TypeScript public eksportai ir API maršrutai. Behaviour
// etalon: AG_loop application/integration/contract-diff.ts TS/route blokai (1:1;
// skaidymas scan/extract/diff pagal 500 eil. gate).

import type { ContractDescriptor } from "./contract-model.js";
import { balancedBlock, dedupeById, lineAt, memberNames, normalizeSignature, scanHeader } from "./contract-scan.js";

// ---------------------------------------------------------------------------
// TypeScript public exports
// ---------------------------------------------------------------------------

const EXPORT_ANCHOR = /^[ \t]*export\b/gm;
const STAR_EXPORT = /^export\s+\*(?:\s+as\s+([A-Za-z_$][\w$]*))?\s+from\s+["']([^"']+)["']/;
const NAMED_EXPORT = /^export\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s*["']([^"']+)["'])?/;
const DECLARED_EXPORT =
  /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let|var|namespace)\s*\*?\s*([A-Za-z_$][\w$]*)/;

/**
 * Regionas, kuriame gyvena viena eksporto deklaracija: iki kito top-level `export`. Riba
 * yra konservatyvi — geriau paimti per daug teksto (jį apkarpo `scanHeader`) nei nutraukti
 * daugiaeilę deklaraciją per vidurį ir prarasti narius.
 */
function declarationRegion(text: string, start: number): string {
  const next = /\n[ \t]*export\b/g;
  next.lastIndex = start + 1;
  const match = next.exec(text);
  return text.slice(start, match ? match.index : text.length);
}

export function extractTsExports(filePath: string, text: string): ContractDescriptor[] {
  const out: ContractDescriptor[] = [];
  const anchor = new RegExp(EXPORT_ANCHOR.source, EXPORT_ANCHOR.flags);
  let anchorMatch: RegExpExecArray | null;

  while ((anchorMatch = anchor.exec(text)) !== null) {
    const start = anchorMatch.index + anchorMatch[0].indexOf("export");
    const region = declarationRegion(text, start);
    const line = lineAt(text, start);

    const star = STAR_EXPORT.exec(region);
    if (star) {
      const alias = star[1] ?? "*";
      out.push({
        kind: "ts-export",
        id: `ts-export:${filePath}#${alias}`,
        path: filePath,
        signature: normalizeSignature(`export * as ${alias} from ${star[2] ?? ""}`),
        members: [],
        line,
      });
      continue;
    }

    const named = NAMED_EXPORT.exec(region);
    if (named) {
      const source = named[2] ?? "";
      for (const specifier of (named[1] ?? "").split(",")) {
        const parts = specifier.trim().split(/\s+as\s+/);
        const local = parts[0]?.trim();
        const exported = (parts[1] ?? parts[0])?.trim();
        if (!exported) continue;
        out.push({
          kind: "ts-export",
          id: `ts-export:${filePath}#${exported}`,
          path: filePath,
          signature: normalizeSignature(`export ${local} as ${exported}${source ? ` from ${source}` : ""}`),
          members: [],
          line,
        });
      }
      continue;
    }

    const declared = DECLARED_EXPORT.exec(region);
    if (!declared) continue;
    const keyword = declared[1] as string;
    const name = declared[2] as string;
    out.push(describeTsDeclaration(filePath, region, keyword, name, line));
  }

  return dedupeById(out);
}

function describeTsDeclaration(
  filePath: string,
  region: string,
  keyword: string,
  name: string,
  line: number,
): ContractDescriptor {
  const id = `ts-export:${filePath}#${name}`;

  if (keyword === "function") {
    // Antgalvis iki kūno; nariai = parametrų vardai, nes parametro dingimas yra atėmimas
    // net tada, kai likusi parašo dalis nepasikeitė.
    const header = scanHeader(region, "{;");
    return {
      kind: "ts-export",
      id,
      path: filePath,
      signature: normalizeSignature(header.header),
      members: memberNames(balancedBlock(region, 0, "(")),
      line,
    };
  }

  if (keyword === "type") {
    // Tipo aliasas neturi kūno skliaustuose, kai jis yra union/intersection, todėl visas
    // regionas yra parašas. Objekto literalo raktai papildomai tampa nariais.
    const terminated = scanHeader(region, ";");
    return {
      kind: "ts-export",
      id,
      path: filePath,
      signature: normalizeSignature(terminated.header),
      members: memberNames(balancedBlock(region, 0, "{")),
      line,
    };
  }

  if (keyword === "interface" || keyword === "class" || keyword === "enum" || keyword === "namespace") {
    const header = scanHeader(region, "{");
    return {
      kind: "ts-export",
      id,
      path: filePath,
      signature: normalizeSignature(header.header),
      members: memberNames(balancedBlock(region, 0, "{")),
      line,
    };
  }

  // const/let/var: parašas iki `=`, o iniciatoriaus pirmo objekto literalo raktai — nariai.
  // Būtent tai paverčia `export const xSchema = z.object({...})` rakto pašalinimą matomu
  // kontrakto atėmimu, o ne nematomu iniciatoriaus pokyčiu.
  const header = scanHeader(region, "=;");
  return {
    kind: "ts-export",
    id,
    path: filePath,
    signature: normalizeSignature(header.header),
    members: memberNames(balancedBlock(region, header.index, "{")),
    line,
  };
}

// ---------------------------------------------------------------------------
// API maršrutai
// ---------------------------------------------------------------------------

// Gavėjas apribotas žinomais serverio/rūterio vardais: be šito `map.delete("k")` ar
// `cache.get("k")` virstų „pašalintu maršrutu" ir vartai skambėtų dėl nieko.
const ROUTE_CALL =
  /\b(?:app|api|router|routes|route|server|fastify|express|instance|hono)\s*\.\s*(get|post|put|patch|delete|head|options|all)\s*\(\s*(["'`])([^"'`]+)\2/gi;
const ROUTE_OBJECT_METHOD_FIRST =
  /method\s*:\s*["'`](get|post|put|patch|delete|head|options|all)["'`][\s\S]{0,200}?\bpath\s*:\s*["'`]([^"'`]+)["'`]/gi;
const ROUTE_OBJECT_PATH_FIRST =
  /\bpath\s*:\s*["'`]([^"'`]+)["'`][\s\S]{0,200}?method\s*:\s*["'`](get|post|put|patch|delete|head|options|all)["'`]/gi;

export function routeDescriptor(filePath: string, method: string, routePath: string, line: number): ContractDescriptor {
  const normalized = `${method.toUpperCase()} ${routePath}`;
  return {
    kind: "api-route",
    id: `api-route:${normalized}`,
    path: filePath,
    signature: normalized,
    members: [],
    line,
  };
}

export function extractApiRoutes(filePath: string, text: string): ContractDescriptor[] {
  const out: ContractDescriptor[] = [];
  for (const pattern of [ROUTE_CALL, ROUTE_OBJECT_METHOD_FIRST, ROUTE_OBJECT_PATH_FIRST]) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const line = lineAt(text, match.index);
      if (pattern === ROUTE_CALL) {
        out.push(routeDescriptor(filePath, match[1] as string, match[3] as string, line));
      } else if (pattern === ROUTE_OBJECT_METHOD_FIRST) {
        out.push(routeDescriptor(filePath, match[1] as string, match[2] as string, line));
      } else {
        out.push(routeDescriptor(filePath, match[2] as string, match[1] as string, line));
      }
    }
  }
  return dedupeById(out);
}
