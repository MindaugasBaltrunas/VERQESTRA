// Runtime nuosavybės vartai (etalonas: AG_loop hooks/pre-hooks.ts evaluateRuntimeOwnership +
// carve-out FS šonas). Trys sluoksniai vienoje vietoje, nes jie turi kristi kartu:
//   1. carve-out — ar vartai šiam keliui apskritai taikomi (gryna klasifikacija domain'e);
//   2. worker lease — ar procesas vis dar savininkas, o be claim'o — ar svetimo gyvo lease'o
//      APRĖPTIS dengia šį kelią (0026);
//   3. scope lock — tikrinamas tik valdomame režime: be lease'o nėra su kuo lock'ą palyginti.
//
// SUBTILIAUSIA VIETA visame hook'ų rinkinyje — `..` segmentas ir symlink'ai. `path.resolve`
// sutraukia `..` LEKSIŠKAI, o POSIX branduolys jį taiko JAU išspręstam symlink'ui. Todėl
// `AG/tasks/queue/<symlink>/../x.ts` klasifikatoriui atrodytų kaip naujas eilės failas, o
// rašymas nusileistų ten, kur rodo symlink'as — į produkto medį. Dėl to `..` segmentas
// ATIMA carve-out'ą besąlygiškai, ir taip elgiamasi VISOSE platformose, nors Windows kelius
// sutraukia leksiškai: vartai turi būti vienodi visur.

import path from "node:path";
import {
  classifyForeignLeaseGuardScope,
  type ForeignLeaseGuardScopeReason,
  type WritePolicyBlock,
} from "../../domain/policies/index.js";
import { isProjectRelativePath, normalizeProjectPath } from "../../shared/paths.js";

/** `..` segmentas deklaruotame kelyje — fail-closed žyma (žr. modulio antraštę). */
const TRAVERSAL_SEGMENT_PATTERN = /(^|[\\/])\.\.([\\/]|$)/;

/** Struktūrinis lease sprendimo vaizdas — domain `RuntimeAuthority` jį tenkina. */
export type RuntimeAuthorityView = {
  status: string;
  ok: boolean;
  reason: string;
  lease?: { lease_id: string } | undefined;
};

/** Struktūrinis scope lock sprendimo vaizdas. */
export type ScopeLockAuthorityView = {
  status: string;
  ok: boolean;
  reason: string;
};

export type RuntimeOwnershipPorts = {
  /**
   * Giliausio EGZISTUOJANČIO protėvio `realpath` + likusi (dar nesukurta) uodega. Be jo
   * symlink ar NTFS junction iš izoliuotos kopijos atgal į pirminį medį leistų apsimesti
   * carve-out keliu.
   */
  resolveDeepestRealPath(absolutePath: string): Promise<string>;
  /**
   * Ar vardas UŽIMTAS. Privalo remtis `lstat`, ne „ar failas skaitomas": nulūžęs symlink
   * queue vardu kitaip gautų „naujo eilės failo" carve-out'ą, o `open()` sukurtų failą ten,
   * kur rodo symlink'as — už queue ribų.
   */
  pathIsTaken(absolutePath: string): Promise<boolean>;
  /** Gyvų (held, neišsibaigusių, su GYVU savininko procesu) lease'ų worktree keliai, realpath forma. */
  liveLeaseWorktreePaths(projectRoot: string): Promise<string[]>;
  authorizeWorkerRuntimeMutation(input: {
    projectRoot: string;
    taskId?: string;
    guardedPath?: string;
  }): Promise<RuntimeAuthorityView>;
  authorizeScopedWrite(input: {
    projectRoot: string;
    repoRelativePath: string;
    leaseId?: string;
  }): Promise<ScopeLockAuthorityView>;
  /** Best-effort žurnalas; jo klaida verdikto NEKEIČIA. */
  appendHookLog(line: string): Promise<void>;
};

export type RuntimeOwnershipInput = {
  filePath?: string;
  taskId?: string;
  /** Ką bandoma daryti — patenka į blokavimo žinutę. */
  subject: string;
};

/**
 * FS šonas carve-out klasifikacijai. BET KOKIA klaida (neperskaitomas ar sugadintas lease
 * store) reiškia „carve-out netaikomas" — vartai lieka tokie, kokie buvo. Carve-out niekada
 * neatsiranda dėl NESĖKMĖS.
 */
async function foreignLeaseGuardCarveOut(
  ports: RuntimeOwnershipPorts,
  projectRoot: string,
  filePath: string,
): Promise<ForeignLeaseGuardScopeReason | undefined> {
  if (TRAVERSAL_SEGMENT_PATTERN.test(filePath)) return undefined;
  try {
    const resolvedRoot = await ports.resolveDeepestRealPath(path.resolve(projectRoot));
    const declared = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(resolvedRoot, filePath);
    const resolvedPath = await ports.resolveDeepestRealPath(declared);
    const verdict = classifyForeignLeaseGuardScope({
      filePath: resolvedPath,
      projectRoot: resolvedRoot,
      targetExists: (await ports.pathIsTaken(declared)) || (await ports.pathIsTaken(resolvedPath)),
      liveWorktreePaths: await ports.liveLeaseWorktreePaths(projectRoot),
    });
    return verdict.bypass ? verdict.reason : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rašymo kelias repo-relative forma — įvestis lease APRĖPTIES patikrai (0026). `undefined`
 * reiškia „nustatyti nepavyko": tada kvietėjas aprėpties NESIAURINA ir gyvi lease'ai gina visą
 * medį, kaip iki 0026.
 */
async function guardedRepoRelativePath(
  ports: RuntimeOwnershipPorts,
  projectRoot: string,
  filePath: string,
): Promise<string | undefined> {
  if (TRAVERSAL_SEGMENT_PATTERN.test(filePath)) return undefined;
  try {
    const resolvedRoot = await ports.resolveDeepestRealPath(path.resolve(projectRoot));
    const declared = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(resolvedRoot, filePath);
    const relative = normalizeProjectPath(resolvedRoot, await ports.resolveDeepestRealPath(declared));
    if (!relative || !isProjectRelativePath(relative) || relative.split("/").includes("..")) return undefined;
    return relative;
  } catch {
    return undefined;
  }
}

/**
 * Carve-out yra vartų SUSILPNINIMAS, todėl jis palieka pėdsaką: be įrašo žurnale praleistas
 * rašymas neatskiriamas nuo tokio, kuriam vartai apskritai negaliojo.
 */
async function logCarveOut(
  ports: RuntimeOwnershipPorts,
  filePath: string,
  reason: ForeignLeaseGuardScopeReason,
): Promise<void> {
  try {
    await ports.appendHookLog(`lease vartai netaikomi: ${filePath} (${reason})`);
  } catch {
    // Žurnalas nėra sprendimo dalis.
  }
}

export async function evaluateRuntimeOwnership(
  ports: RuntimeOwnershipPorts,
  projectRoot: string,
  input: RuntimeOwnershipInput,
): Promise<WritePolicyBlock | undefined> {
  // 0014: vartai saugo ŠIO medžio produkto failus nuo lygiagrečių rašytojų. Keliai už projekto
  // šaknies, kitos worktree kopijos ir NAUJI queue failai nė vieno rašytojo darbo neliečia —
  // kitaip vienas gyvas lease paralyžiuotų visą lygiagretų darbą.
  if (input.filePath) {
    const carveOut = await foreignLeaseGuardCarveOut(ports, projectRoot, input.filePath);
    if (carveOut) {
      await logCarveOut(ports, input.filePath, carveOut);
      return undefined;
    }
  }

  // 0026: kai rašymo kelias žinomas, gyvas SVETIMAS lease blokuoja tik savo aprėptį. Be kelio
  // (commit'ai, task būsenos perėjimai) vartai lieka viso medžio pločio — toks veiksmas ir
  // liečia visą medį.
  const guardedPath = input.filePath
    ? await guardedRepoRelativePath(ports, projectRoot, input.filePath)
    : undefined;

  const authority = await ports.authorizeWorkerRuntimeMutation({
    projectRoot,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(guardedPath === undefined ? {} : { guardedPath }),
  });

  if (!authority.ok) {
    return {
      reason: `worker lease: ${authority.status}`,
      stderr: [
        `BLOCKED: ${input.subject} neturi galiojančios worker lease (${authority.status}).`,
        `  ${authority.reason}`,
        "  Praradęs nuosavybę workeris negali rašyti, commitinti ar keisti task būsenos.",
      ].join("\n"),
    };
  }

  // `unmanaged` BE lease'o = „lease runtime neįjungtas": scope lock'ų nėra su kuo palyginti, ir
  // tai kelias, kuriuo veikia numatytas vienas workeris (elgesys nepakitęs). `unmanaged` SU
  // lease'u yra 0026 aprėpties šaka — lock'ai vis tiek klausiami, kad siauresnė lease aprėptis
  // netyliai nepanaikintų antro sluoksnio.
  if ((authority.status === "unmanaged" && !authority.lease) || !input.filePath) return undefined;

  const scope = await ports.authorizeScopedWrite({
    projectRoot,
    repoRelativePath: normalizeProjectPath(projectRoot, input.filePath),
    ...(authority.status !== "unmanaged" && authority.lease
      ? { leaseId: authority.lease.lease_id }
      : {}),
  });
  if (!scope.ok) {
    return {
      reason: `scope lock: ${scope.status}`,
      stderr: [
        `BLOCKED: ${input.subject} nepriklauso šio workerio scope lock'ams.`,
        `  ${scope.reason}`,
      ].join("\n"),
    };
  }

  return undefined;
}
