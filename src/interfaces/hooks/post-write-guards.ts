// PostToolUse guard'ų paleidimas (etalonas: AG_loop hooks/post-write-guards.ts).
//
// Du kontraktai, kurie čia yra svarbesni už patį fan-out'ą. Pirma, PostToolUse NIEKADA
// neblokuoja: nepavykęs guard'as tik patenka į žurnalą, o blokavimas paliekamas Stop hook'ui —
// kitaip kiekvienas rašymas taptų vartais, ir agentas negalėtų dirbti eigoje. Antra, guard'as
// paleidžiamas TIK jei jo produkto šaknis realiai egzistuoja: `frontend` guard'as repo be
// frontend'o būtų tuščias procesas kiekvienam rašymui.

import {
  DEFAULT_GUARD_ROOT_PATHS,
  type GuardRootKey,
} from "../../domain/project/index.js";
import type { HookFsPort } from "./protocol.js";

export type HookGuardDefinition = {
  /** CLI komandos vardas (`hook-secret-scan` ir pan.). */
  command: string;
  args: string[];
  /** Produkto šaknis, be kurios guard'as neturi ko tikrinti. */
  requiresRoot?: GuardRootKey;
};

/**
 * Guard'ų registras. `frontend`/`mobile` gauna eksplicitinį `post`, kad jų stop režimo
 * lint/typecheck subprocesai PostToolUse metu NEBŪTŲ paleisti; `backend` jo neturi, nes jo
 * hook'as režimo neskaito ir visada dirba post režimu.
 */
export const POST_WRITE_GUARDS: readonly HookGuardDefinition[] = Object.freeze([
  { command: "hook-secret-scan", args: [] },
  { command: "hook-package-guard", args: [] },
  { command: "hook-migration-guard", args: [] },
  { command: "hook-frontend-guard", args: ["post"], requiresRoot: "frontend" },
  { command: "hook-backend-guard", args: [], requiresRoot: "backend" },
  { command: "hook-mobile-guard", args: ["post"], requiresRoot: "mobile" },
]);

/** Grynas filtras: guard'as taikomas, kai jam šaknies nereikia arba ta šaknis egzistuoja. */
export function applicableGuards<T extends { requiresRoot?: GuardRootKey }>(
  guards: readonly T[],
  roots: Record<GuardRootKey, boolean>,
): T[] {
  return guards.filter((guard) => guard.requiresRoot === undefined || roots[guard.requiresRoot]);
}

export type PostWriteGuardPorts = {
  fs: HookFsPort;
  /** Išspręsti guard root keliai (sanitizuoti per resolveGuardRootPaths). */
  guardRoots(projectRoot: string): Promise<Record<GuardRootKey, string>>;
  /** Paleidžia guard'ą kaip atskirą CLI procesą; grąžina jo exit kodą. */
  runGuard(command: string, args: string[], projectRoot: string): Promise<number>;
  now?: () => Date;
};

export type PostWriteGuardsDeps = {
  ports: PostWriteGuardPorts;
  projectRoot: string;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot?: string;
  guards?: readonly HookGuardDefinition[];
};

/** Kurios produkto šaknys realiai egzistuoja diske. */
export async function detectGuardRoots(
  ports: PostWriteGuardPorts,
  projectRoot: string,
): Promise<Record<GuardRootKey, boolean>> {
  const resolved = await ports.guardRoots(projectRoot);
  const keys = Object.keys(DEFAULT_GUARD_ROOT_PATHS) as GuardRootKey[];
  const entries = await Promise.all(
    keys.map(async (key) => [key, await ports.fs.exists(`${projectRoot}/${resolved[key]}`)] as const),
  );
  return Object.fromEntries(entries) as Record<GuardRootKey, boolean>;
}

/**
 * Paleidžia visus taikomus guard'us lygiagrečiai. Grąžina 0 VISADA: nesėkmė yra žurnalo
 * įrašas, ne rašymo blokada (žr. modulio antraštę).
 */
export async function runPostWriteGuards(deps: PostWriteGuardsDeps): Promise<number> {
  const guards = deps.guards ?? POST_WRITE_GUARDS;
  const roots = await detectGuardRoots(deps.ports, deps.projectRoot);
  const hooksLog = `${deps.runtimeRoot ?? `${deps.projectRoot}/vq`}/logs/hooks.log`;
  const stamp = (deps.ports.now?.() ?? new Date()).toISOString();

  await Promise.all(
    applicableGuards(guards, roots).map(async (guard) => {
      const code = await deps.ports.runGuard(guard.command, guard.args, deps.projectRoot);
      if (code !== 0) {
        await deps.ports.fs.appendTextFile(hooksLog, `[${stamp}] post-write guard ${guard.command} exit=${code}\n`);
      }
    }),
  );

  return 0;
}
