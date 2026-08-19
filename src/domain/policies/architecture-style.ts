// Forbidden-dependency įrodymų gradacija: scope kelias → confirmed, code-graph briauna →
// confirmed, teksto paminėjimas → possible, kitaip — jokio violation (none = tyla).
// R2 inversija: policy tipas apibrėžtas ČIA kaip domain view (zod schema vėlesniame
// sluoksnyje jį tenkina). Behaviour etalon: AG_loop domain/policies/architecture-style.ts.

/** Domain view: vienintelis šio modulio vartojamas laukas + passthrough likusiems. */
export type ArchitectureStylePolicy = {
  forbidden_dependencies: string[];
} & Record<string, unknown>;

export type ArchitectureEvidenceLevel = "possible" | "confirmed";

/**
 * Papildomi įrodymų šaltiniai be task'o allowed paths: `taskText` paminėjimas — silpnas
 * (`possible`); `codeGraphEdges` ("from -> to" eilutės) reali briauna — stiprus
 * (`confirmed`). Abu neprivalomi, kad preflight paduotų tik tai, ką turi.
 */
export type ArchitectureEvidenceContext = {
  taskText?: string;
  codeGraphEdges?: string[];
};

export type ForbiddenDependencyViolation = {
  /** The raw forbidden_dependencies entry that was matched. */
  dependency: string;
  /** The normalized endpoint token whose path segments matched the evidence. */
  endpoint: string;
  /** Allowed file providing scope evidence, or null for text/graph-only evidence. */
  file: string | null;
  evidence: ArchitectureEvidenceLevel;
  /** Human-readable evidence descriptions (scope path, text mention, graph edge). */
  sources: string[];
};

// Edge endpoints may be separated by an arrow; a single token is a one-endpoint edge.
const EDGE_SEPARATOR = /\s*(?:->|→|=>|➔|-->)\s*/;

function normalizeScopeToken(token: string): string {
  return token
    .trim()
    .replace(/^[`'"]+/, "")
    .replace(/[`'"]+$/, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .trim();
}

function pathSegments(token: string): string[] {
  return normalizeScopeToken(token)
    .split("/")
    .filter((segment) => segment.length > 0);
}

/** Split a forbidden dependency edge into its normalized endpoint tokens. */
export function forbiddenDependencyEndpoints(dependency: string): string[] {
  return dependency
    .split(EDGE_SEPARATOR)
    .map((part) => normalizeScopeToken(part))
    .filter((part) => part.length > 0);
}

/**
 * True when the allowed file lies inside (or equals) the endpoint, matched as a
 * contiguous run of path segments — unrelated substring shares are never evidence.
 */
export function scopeTouchesEndpoint(file: string, endpoint: string): boolean {
  const fileSegments = pathSegments(file);
  const endpointSegments = pathSegments(endpoint);
  if (fileSegments.length === 0 || endpointSegments.length === 0) return false;
  for (let start = 0; start + endpointSegments.length <= fileSegments.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < endpointSegments.length; offset += 1) {
      if (fileSegments[start + offset] !== endpointSegments[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/** True when two tokens overlap as a contiguous run of path segments, either way. */
function endpointsOverlap(a: string, b: string): boolean {
  return scopeTouchesEndpoint(a, b) || scopeTouchesEndpoint(b, a);
}

/**
 * True when the task text mentions the endpoint as a path token: contiguous slash-run
 * with a path boundary on each side (`apps/web` nesutampa su `myapps/website`, bet
 * sutampa su `apps/web/home.ts`).
 */
export function taskTextMentionsEndpoint(taskText: string, endpoint: string): boolean {
  const normalizedEndpoint = pathSegments(endpoint).join("/");
  if (!normalizedEndpoint) return false;
  const normalizedText = taskText.replace(/\\/g, "/");
  const escaped = normalizedEndpoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[^\\w.-])${escaped}(?![\\w.-])`, "i");
  return pattern.test(normalizedText);
}

/**
 * When an available code-graph edge realizes a forbidden two-endpoint edge, return the
 * forbidden target endpoint; otherwise null (single-token entries have no real edge).
 */
function codeGraphEdgeConfirms(edges: string[], forbiddenEndpoints: string[]): string | null {
  if (forbiddenEndpoints.length < 2) return null;
  const [from, to] = forbiddenEndpoints as [string, string];
  for (const edge of edges) {
    const parts = forbiddenDependencyEndpoints(edge);
    if (parts.length < 2) continue;
    const fromMatch = parts.some((part) => endpointsOverlap(part, from));
    const toMatch = parts.some((part) => endpointsOverlap(part, to));
    if (fromMatch && toMatch) return to;
  }
  return null;
}

/**
 * Grade each forbidden dependency by the strongest evidence linking it to the task.
 * Empty result = no evidence links the task to any forbidden edge; preflight must not flag.
 */
export function detectForbiddenDependencyViolations(
  policy: ArchitectureStylePolicy,
  allowedFiles: string[],
  context: ArchitectureEvidenceContext = {},
): ForbiddenDependencyViolation[] {
  const taskText = context.taskText ?? "";
  const codeGraphEdges = context.codeGraphEdges ?? [];
  const violations: ForbiddenDependencyViolation[] = [];

  for (const dependency of policy.forbidden_dependencies) {
    const endpoints = forbiddenDependencyEndpoints(dependency);
    if (endpoints.length === 0) continue;

    // Strongest evidence: an allowed file lies inside a forbidden endpoint.
    let touchedFile: string | null = null;
    let touchedEndpoint: string | null = null;
    for (const file of allowedFiles) {
      const endpoint = endpoints.find((candidate) => scopeTouchesEndpoint(file, candidate));
      if (endpoint) {
        touchedFile = file;
        touchedEndpoint = endpoint;
        break;
      }
    }
    if (touchedFile && touchedEndpoint) {
      violations.push({
        dependency,
        endpoint: touchedEndpoint,
        file: touchedFile,
        evidence: "confirmed",
        sources: [`scope path "${touchedFile}" is inside forbidden endpoint "${touchedEndpoint}"`],
      });
      continue;
    }

    // Strong evidence: a real code-graph edge realizes the forbidden edge.
    const graphEndpoint = codeGraphEdgeConfirms(codeGraphEdges, endpoints);
    if (graphEndpoint) {
      violations.push({
        dependency,
        endpoint: graphEndpoint,
        file: null,
        evidence: "confirmed",
        sources: [`code-graph edge realizes forbidden dependency "${dependency}"`],
      });
      continue;
    }

    // Weak evidence: the task text mentions a forbidden endpoint.
    const mentioned = endpoints.find((candidate) => taskTextMentionsEndpoint(taskText, candidate));
    if (mentioned) {
      violations.push({
        dependency,
        endpoint: mentioned,
        file: null,
        evidence: "possible",
        sources: [`task text mentions forbidden endpoint "${mentioned}"`],
      });
    }
  }
  return violations;
}
