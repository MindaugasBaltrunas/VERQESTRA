// Draudžiamų sluoksnio importų paieška code index'e. Behaviour etalon: AG_loop
// code-index/architecture-boundary.ts; WBR VQ-301 inversija: vietoj core/schema zod tipo —
// domain policy-view (layers + forbidden_dependencies), segmentų atitikimas — iš
// domain/policies/architecture-style (FQC-12: vienas scopeTouchesEndpoint visame repo).

import { forbiddenDependencyEndpoints, scopeTouchesEndpoint } from "../../../domain/policies/architecture-style.js";
import type { CodeIndexData } from "../indexing/types.js";

/** Directory root that layer names in the architecture-style policy are relative to. */
const LAYER_SOURCE_ROOT = "src";

/** Domain view: laukai, kuriuos boundary patikra realiai skaito + passthrough likusiems. */
export type ArchitectureBoundaryPolicyView = {
  layers: string[];
  forbidden_dependencies: string[];
} & Record<string, unknown>;

/**
 * A forbidden-import edge found in the code index: a real `imports` edge whose
 * source file belongs to one architecture layer and whose target belongs to a
 * layer (or external module) that a `forbidden_dependencies` entry disallows.
 */
export type ArchitectureBoundaryViolation = {
  from: string;
  to: string;
  fromLayer: string;
  toLayer: string;
  dependency: string;
};

function classifyLayer(fileOrSpecifier: string, layers: readonly string[]): string | null {
  return layers.find((layer) => scopeTouchesEndpoint(fileOrSpecifier, `${LAYER_SOURCE_ROOT}/${layer}`)) ?? null;
}

/**
 * Sluoksnis iš NAMESPACE nuorodos (2026-08-23, RAG auditas 3).
 *
 * `src/<layer>/**` kelio taisyklė galioja tik toms kalboms, kurių importas yra kelias. C# ir PHP
 * importuoja NAMESPACE'ą (`using Company.Infrastructure;`, `use Vendor\Domain\Rules;`), ir be
 * projekto konfigūracijos jis į kelią neišsprendžiamas — būtent todėl indeksuotojai jį sąmoningai
 * palieka tekstu. Vartui tai reiškė fail-open: `src/domain/Rules.cs`, importuojantis infrastruktūrą,
 * pažeidimų duodavo 0.
 *
 * Namespace segmentas ir yra sluoksnio vardas — tokia pati tiesa kaip katalogas TypeScript pusėje.
 * Taikoma TIK nuorodoms, kurios NĖRA indeksuotas failas: kelias jau turi savo taisyklę, ir be šios
 * sąlygos `domain.ts` repo šaknyje būtų perskaitytas kaip namespace.
 */
function classifyNamespaceLayer(specifier: string, layers: readonly string[], knownFiles: ReadonlySet<string>): string | null {
  if (knownFiles.has(specifier) || specifier.includes("/") || !/[.\\]/.test(specifier)) return null;
  const segments = specifier.split(/[.\\]/).filter(Boolean);
  return layers.find((layer) => segments.some((segment) => segment.toLowerCase() === layer.toLowerCase())) ?? null;
}

function classifyExternalToken(specifier: string, tokens: readonly string[]): string | null {
  return tokens.find((token) => scopeTouchesEndpoint(specifier, token)) ?? null;
}

/**
 * Detect forbidden layer-import edges in a code index against an architecture
 * style policy's `forbidden_dependencies` list.
 *
 * A layer is recognized by files living under `src/<layer>/**`. A
 * `forbidden_dependencies` entry may also name a non-layer token (e.g.
 * `"node:fs"`) to flag a layer importing a specific external module; such
 * tokens are matched against the raw, unresolved import specifier.
 */
export function findArchitectureBoundaryViolations(
  index: CodeIndexData,
  policy: ArchitectureBoundaryPolicyView,
): ArchitectureBoundaryViolation[] {
  const layers = policy.layers;
  if (layers.length === 0 || policy.forbidden_dependencies.length === 0) return [];

  const dependencies = policy.forbidden_dependencies
    .map((dependency) => ({ dependency, endpoints: forbiddenDependencyEndpoints(dependency) }))
    .filter((entry): entry is { dependency: string; endpoints: [string, string] } => entry.endpoints.length === 2);
  if (dependencies.length === 0) return [];

  const externalTokens = Array.from(
    new Set(dependencies.map((entry) => entry.endpoints[1]).filter((token) => !layers.includes(token))),
  );

  const knownFiles = new Set(index.files.map((file) => file.path));
  const violations: ArchitectureBoundaryViolation[] = [];
  for (const edge of index.edges) {
    if (edge.type !== "imports") continue;
    const fromLayer = classifyLayer(edge.from, layers);
    if (!fromLayer) continue;
    const toLayer =
      classifyLayer(edge.to, layers) ??
      classifyNamespaceLayer(edge.to, layers, knownFiles) ??
      classifyExternalToken(edge.to, externalTokens);
    if (!toLayer) continue;

    for (const { dependency, endpoints } of dependencies) {
      if (endpoints[0] === fromLayer && endpoints[1] === toLayer) {
        violations.push({ from: edge.from, to: edge.to, fromLayer, toLayer, dependency });
      }
    }
  }
  return violations;
}
