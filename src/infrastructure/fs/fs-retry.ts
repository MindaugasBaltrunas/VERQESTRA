// Win32 contention retry aplink `rename` (etalonas: AG_loop core/fs.ts, task 0047 klasė,
// 0058 pataisa). `MoveFileEx` per failą, kurį kas nors laiko atidarytą (kitas procesas,
// UI serveris, antivirusinė, indeksuoklis), lūžta su EPERM/EACCES/EBUSY tol, kol handle
// užsidarys. Be retry vienas momentinis susidūrimas paverčia atominį rašymą meta klaida —
// o skaitytojui tai atrodo kaip „įrašo nėra". Kelios dešimtys ms retry paverčia tai
// neįvykiu.
//
// POSIX elgesys NEKINTA: ten rename per atidarytą failą teisėtas, o EPERM reiškia tikrą
// teisių klaidą — kartoti ją būtų tik uždelstas tas pats gedimas.
//
// Biudžetas 10 × 25 ms (linijinis backoff, worst case ~1.1 s): etalono 5 × 20 ms
// neatlaikė 20 lygiagrečių rašytojų į tą patį kelią apkrautoje mašinoje (2026-08-11 gate).

import { isErrnoCode } from "../../shared/errors.js";

export const win32RenameRetryTiming = { attempts: 10, delayMs: 25 } as const;

export function isWin32ContentionError(error: unknown, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return false;
  return isErrnoCode(error, "EPERM") || isErrnoCode(error, "EACCES") || isErrnoCode(error, "EBUSY");
}

/**
 * `platform` yra parametras TIK tam, kad testas galėtų įrodyti abiejų platformų elgesį
 * bet kurioje mašinoje; produkcinis kelias visada naudoja numatytąjį `process.platform`.
 */
export async function withWin32RenameRetry(
  operation: () => Promise<void>,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      if (attempt >= win32RenameRetryTiming.attempts || !isWin32ContentionError(error, platform)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, win32RenameRetryTiming.delayMs * attempt));
    }
  }
}
