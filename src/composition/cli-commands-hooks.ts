// Hook'ų registro pjuvis (VQ-504). Visi Claude Code hook įėjimai vienoje vietoje, atskirti nuo
// `cli-registry.ts` pagal tą pačią taisyklę kaip kiti `cli-commands-*` pjūviai: registre lieka
// SURINKIMAS ir tvarka, o portų surišimas gyvena teminiame pjūvyje.
//
// Šių komandų NEKVIEČIA operatorius — jas kviečia Claude Code pagal `.claude/settings.json`,
// paduodamas payload'ą per stdin. Todėl `usage` čia nerašomas: rankinis paleidimas be stdin
// payload'o nėra palaikomas scenarijus, ir help eilutė, siūlanti argumentus, klaidintų.
//
// TVARKA YRA KONTRAKTAS: pirma blokuojantys `PreToolUse` vartai, paskui neblokuojantys
// `PostToolUse` hook'ai. Ji atspindi realią vykdymo seką ir tą patį skirtumą, kurį `help`
// skaitantis operatorius turi pamatyti iš karto — vienas šių dviejų rinkinių gali nutraukti
// darbą, kitas negali niekada.

import type { CliCommand } from "../interfaces/cli/registry.js";
import type { CliRegistryDeps } from "./cli-registry-types.js";
import { hookPreBash, hookPreWrite } from "../interfaces/hooks/pre-hooks.js";
import { hookPostBash, hookPostBashSync, hookPostRead } from "../interfaces/hooks/post-hooks.js";
import { hookPostWrite } from "../interfaces/hooks/post-write.js";
import { hookSecretScan } from "../interfaces/hooks/secret-scan.js";
import { hookPackageGuard } from "../interfaces/hooks/package-guard.js";
import { hookMigrationGuard } from "../interfaces/hooks/migration-guard.js";
import { hookBackendGuard, hookFrontendGuard, hookMobileGuard } from "../interfaces/hooks/scope-guards.js";
import { hookSessionStart } from "../interfaces/hooks/session-start.js";
import { hookSessionEnd } from "../interfaces/hooks/session-end.js";
import { hookSessionSummary } from "../interfaces/hooks/session-summary.js";
import { hookOnStop } from "../interfaces/hooks/on-stop.js";
import { stopHookPorts } from "./stop-hook-adapters.js";
import { hookUserPrompt } from "../interfaces/hooks/user-prompt.js";
import { sessionHookPorts, sessionSummaryPorts, userPromptDeps } from "./session-hook-adapters.js";
import {
  migrationGuardPorts,
  packageGuardPorts,
  postWriteGuardPorts,
  scopeGuardPorts,
  secretScanPorts,
} from "./guard-hook-adapters.js";
import { postHookPorts } from "./hook-adapters.js";
import { preHookPorts } from "./pre-hook-adapters.js";

export function hookCommands(deps: CliRegistryDeps): CliCommand[] {
  const io = deps.io;
  const runtimeRoot = deps.roots.runtimeRoot;
  const shared = {
    projectRoot: deps.roots.projectRoot,
    runtimeRoot,
    ...(io === undefined ? {} : { io }),
  };

  // Portai kuriami VIENĄ kartą kiekvienam rinkiniui, o ne komandai: viename procese įvykdoma
  // lygiai viena hook komanda, tad antra kopija būtų tik dubliuotas objektas.
  const preDeps = { ports: preHookPorts(runtimeRoot), ...shared };
  const postDeps = { ports: postHookPorts(), ...shared };
  const scopeDeps = { ports: scopeGuardPorts(runtimeRoot), ...shared };
  const sessionDeps = { ports: sessionHookPorts(runtimeRoot), ...shared };

  return [
    {
      name: "hook-pre-bash",
      description: "PreToolUse: bash komandų politika, git mutacijų nuosavybė (BLOKUOJA)",
      run: () => hookPreBash(preDeps),
    },
    {
      name: "hook-pre-write",
      description: "PreToolUse: rašymo politika, readme guard'as, runtime nuosavybė (BLOKUOJA)",
      run: () => hookPreWrite(preDeps),
    },
    {
      name: "hook-post-bash",
      description: "PostToolUse: Bash žurnalas ir digest shadow telemetrija",
      run: () => hookPostBash(postDeps),
    },
    {
      name: "hook-post-bash-sync",
      description: "PostToolUse: sinchroninis Bash išvesties digest kelias",
      run: () => hookPostBashSync(postDeps),
    },
    {
      name: "hook-post-read",
      description: "PostToolUse: readme skaitymo įrodymas",
      run: () => hookPostRead(postDeps),
    },
    {
      // `guards` PADUODAMI eksplicitiškai: be jų `hookPostWrite` guard'ų fan-out'ą praleidžia
      // TYLIAI (portas neprivalomas), ir visi šeši guard'ai liktų negyvi, nors kiekvienas jų
      // turi savo CLI įėjimą. Tai tas pats „neprijungto sluoksnio" defektas, tik viena pakopa
      // giliau nei registro spraga, dėl kurios ši dalis apskritai atsirado.
      name: "hook-post-write",
      description: "PostToolUse: sesijos rašymų ledger'is, KPI įvykiai ir guard'ų fan-out",
      run: () =>
        hookPostWrite({
          ...postDeps,
          guards: { ports: postWriteGuardPorts(runtimeRoot), projectRoot: deps.roots.projectRoot, runtimeRoot },
        }),
    },
    {
      name: "hook-secret-scan",
      description: "Guard: kredencialų skenavimas pakeistuose failuose (radinys → exit 1)",
      run: () => hookSecretScan({ ports: secretScanPorts(runtimeRoot), ...shared }),
    },
    {
      name: "hook-package-guard",
      description: "Guard: package.json ir lockfile pakeitimų pagrindimas",
      run: () => hookPackageGuard({ ports: packageGuardPorts(runtimeRoot), ...shared }),
    },
    {
      name: "hook-migration-guard",
      description: "Guard: DB migracijų pakeitimai ir destruktyvus SQL",
      run: () => hookMigrationGuard({ ports: migrationGuardPorts(runtimeRoot), ...shared }),
    },
    {
      name: "hook-backend-guard",
      description: "Guard: Express backend saugumo taisyklės",
      run: () => hookBackendGuard(scopeDeps),
    },
    {
      // `args` PERDUODAMI: `args[0]` yra režimas, o jo numatytoji reikšmė šiuose dviejuose
      // guard'uose yra `stop` — t. y. su lint/typecheck žingsniu. Nepersiuntus argumentų
      // PostToolUse fan-out'as (jis siunčia `post`) gautų stop režimą po KIEKVIENO rašymo, ir
      // pusiau parašytas failas blokuotų darbą eigoje. `hook-backend-guard` argumentų neima —
      // jo režimas fiksuotas `post`.
      name: "hook-frontend-guard",
      usage: "[post|stop]",
      description: "Guard: frontend komponentų taisyklės (stop režimu ir lint)",
      run: (args) => hookFrontendGuard(scopeDeps, args),
    },
    {
      name: "hook-mobile-guard",
      usage: "[post|stop]",
      description: "Guard: mobile aplikacijos taisyklės (stop režimu ir typecheck)",
      run: (args) => hookMobileGuard(scopeDeps, args),
    },
    {
      name: "hook-session-start",
      description: "SessionStart: įrodymų reset'as su trimis stabdžiais ir git baseline",
      run: () => hookSessionStart(sessionDeps),
    },
    {
      name: "hook-session-end",
      description: "SessionEnd: sesijos apimtis ir runtime įrašo atlaisvinimas",
      run: () => hookSessionEnd(sessionDeps),
    },
    {
      name: "hook-session-summary",
      description: "Sesijos santrauka: patikros, pakeisti failai, guard'ų būsena",
      run: () => hookSessionSummary({ ports: sessionSummaryPorts(runtimeRoot), ...shared }),
    },
    {
      // Vienintelis hook'as, kurio deps sudaromi ASINCHRONIŠKAI: agentų santrauka ateina iš
      // `vq/config/agents.json`, o ne iš modulyje įrašyto sąrašo. Tas sąrašas yra šios
      // repozitorijos agentų kopija ir target projekte meluotų.
      name: "hook-user-prompt",
      description: "UserPromptSubmit: vienkartinis orkestratoriaus konteksto blokas",
      run: async () => hookUserPrompt(await userPromptDeps(runtimeRoot, io)),
    },
    {
      // PASKUTINIS ir DIDZIAUSIAS: vienintelis hook'as, kuris RASO i git istorija. Iki VQ-701
      // jis buvo perkeltas ir istestuotas, bet be CLI ijejimo -- t. y. `.claude/settings.json`
      // Stop eilute butu kvietusi neegzistuojancia komanda, ir visa commit/push darbo eiga
      // butu tyliai nedirbusi. Registre jis eina PO visu kitu, nes toks ir yra jo laikas.
      name: "hook-on-stop",
      description: "Stop: vartai, commit ir push darbo eiga sesijos pabaigoje",
      run: () => hookOnStop({ ports: stopHookPorts(deps.roots.projectRoot, runtimeRoot), ...shared }),
    },
  ];
}
