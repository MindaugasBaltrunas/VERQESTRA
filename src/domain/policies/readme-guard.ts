// README-guard GRYNOSIOS taisyklės (etalonas: AG_loop hooks/write-policy.ts readme-guard
// pusė): kuriuos dokumentus privaloma perskaityti prieš liečiant source kodą ir kurie keliai
// tam saugomi. FS pusę (kokie skaitymai užfiksuoti, ar architektūros dokumentas egzistuoja)
// paduoda hook adapteris.

import {
  normalizeForPolicy,
  normalizeReadEventPath,
  type WritePolicyBlock,
} from "./write-policy.js";

/**
 * Numatytojo (profilio neturinčio) target'o saugomi keliai. Sąrašas platus sąmoningai: kodas po
 * `internal/`, `cmd/`, `lib/`, `pkg/`, `app/`, `services/` turi būti saugomas lygiai taip pat kaip
 * po `src/`. Profilis su source roots šį sąrašą pakeičia savo išvestais keliais.
 */
export const DEFAULT_README_GUARD_PATHS = [
  "/src/",
  "/lib/",
  "/internal/",
  "/cmd/",
  "/pkg/",
  "/app/",
  "/apps/",
  "/modules/",
  "/packages/",
  "/workers/",
  "/services/",
  "/tests/",
  "/test/",
];

/**
 * Numatytasis architektūros dokumentas. Profilis gali jį perrašyti, bet skaityti jis
 * REIKALAUJAMAS tik tada, kai realiai egzistuoja — neegzistuojantis failas negali amžinai
 * blokuoti rašymo (task 885).
 */
export const DEFAULT_ARCHITECTURE_DOC = "doc/architecture/README.md";

export type ReadmeGuardRequirements = {
  requiredReads: string[];
  guardedPaths: string[];
};

/** Profilio signalai, iš kurių išvedami reikalavimai (FS pusę tvarko hook adapteris). */
export type ReadmeGuardProfileSignals = {
  /** Profilio source roots; tušti/nenurodyti → numatytieji saugūs keliai. */
  sourceRoots?: string[];
  architectureDoc?: string;
  /** Ar architektūros dokumentas realiai egzistuoja diske. Tik tada jis reikalaujamas. */
  architectureDocExists?: boolean;
};

/** Konservatyvus fallback, kai kvietėjas reikalavimų nepaduoda: reikalaujami abu dokumentai. */
export const DEFAULT_README_GUARD_REQUIREMENTS: ReadmeGuardRequirements = {
  requiredReads: ["README.md", DEFAULT_ARCHITECTURE_DOC],
  guardedPaths: DEFAULT_README_GUARD_PATHS,
};

/**
 * Vieną source root'ą (pvz. `src`, `apps/**`, `./packages/*`) paverčia `includes`-suderinamu
 * fragmentu (`/src/`). Glob segmentai nukerpami — saugomas tik tvirtas, be `*`, prefiksas.
 */
function toGuardFragment(root: string): string | undefined {
  const solid: string[] = [];
  for (const segment of root.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment.includes("*")) break;
    solid.push(segment);
  }
  if (solid.length === 0) return undefined;
  return `/${solid.join("/")}/`;
}

function deriveGuardedPaths(sourceRoots: string[] | undefined): string[] {
  if (!sourceRoots || sourceRoots.length === 0) return [...DEFAULT_README_GUARD_PATHS];
  const fragments = sourceRoots
    .map(toGuardFragment)
    .filter((fragment): fragment is string => fragment !== undefined);
  // Profilis be jokio panaudojamo source root → grįžtame į saugius numatytuosius.
  if (fragments.length === 0) return [...DEFAULT_README_GUARD_PATHS];
  return [...new Set(fragments)];
}

export function resolveReadmeGuardRequirements(signals: ReadmeGuardProfileSignals = {}): ReadmeGuardRequirements {
  const requiredReads = ["README.md"];
  const architectureDoc = signals.architectureDoc?.trim() || DEFAULT_ARCHITECTURE_DOC;
  if (signals.architectureDocExists) requiredReads.push(architectureDoc);
  return { requiredReads, guardedPaths: deriveGuardedPaths(signals.sourceRoots) };
}

/**
 * Blokuoja saugomo kelio rašymą, kol nėra ĮRODYMO, kad reikalaujami dokumentai perskaityti per
 * Read įrankį. Rankinis įrodymų failo rašymas leidimo nesuteikia — tai pasakyta ir žinutėje,
 * nes kitaip agentas bando „pataisyti" guard'ą vietoj to, kad perskaitytų dokumentą.
 */
export function evaluateReadmeGuardPolicy(
  filePath: string,
  readPaths: string[],
  requirements: ReadmeGuardRequirements = DEFAULT_README_GUARD_REQUIREMENTS,
): WritePolicyBlock | undefined {
  // Vedantis `/` pridedamas SĄMONINGAI. Saugomi fragmentai yra `/src/` formos, tad plikas
  // `includes` atitinka tik kelius su vidiniais brūkšniais — absoliutus `/repo/src/app.ts`
  // praeina, o repo-santykinis `src/app.ts` NE, ir guard'as tyliai neįsijungia. Etalone tas
  // pats fail-open, nes hook'as ten visada gauna absoliutų kelią; čia jis uždaromas, nes
  // vartas negali priklausyti nuo to, kokios formos kelią kvietėjas atsiuntė. Kryptis tik
  // griežtinanti: naujų praleidimų neatsiranda, tik nebelieka senų.
  const normalizedFilePath = `/${normalizeForPolicy(filePath)}`;
  const needsGuard = requirements.guardedPaths.some((guarded) => normalizedFilePath.includes(guarded.toLowerCase()));
  if (!needsGuard) return undefined;

  const normalizedReads = new Set(readPaths.map(normalizeReadEventPath));
  const missingReads = requirements.requiredReads.filter(
    (required) => !normalizedReads.has(normalizeReadEventPath(required)),
  );
  if (missingReads.length === 0) return undefined;

  return {
    reason: "readme-guard skaitymo irodymas nera",
    stderr: [
      "BLOCKED: readme-guard dar nepaleistas siai sesijai.",
      `  Pries kodo keitima privaloma per Read tool perskaityti: ${missingReads.join(", ")}.`,
      "  Rankinis vq/logs/.readme-guard-ok ar vq/state/readme-read-events.json rasymas nesuteikia leidimo.",
    ].join("\n"),
  };
}
