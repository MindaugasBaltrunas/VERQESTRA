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
import { postHookPorts } from "./hook-adapters.js";
import { preHookPorts } from "./pre-hook-adapters.js";

export function hookCommands(deps: CliRegistryDeps): CliCommand[] {
  const io = deps.io;
  const shared = {
    projectRoot: deps.roots.projectRoot,
    runtimeRoot: deps.roots.runtimeRoot,
    ...(io === undefined ? {} : { io }),
  };

  // Portai kuriami VIENĄ kartą kiekvienam rinkiniui, o ne komandai: viename procese įvykdoma
  // lygiai viena hook komanda, tad antra kopija būtų tik dubliuotas objektas.
  const preDeps = { ports: preHookPorts(deps.roots.runtimeRoot), ...shared };
  const postDeps = { ports: postHookPorts(), ...shared };

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
      name: "hook-post-write",
      description: "PostToolUse: sesijos rašymų ledger'is ir KPI įvykiai",
      run: () => hookPostWrite(postDeps),
    },
  ];
}
