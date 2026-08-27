# Task

## Spec source
openspec/changes/verqestra-backlog-v1
Kontekstas: src/application/quality-gates/gates-memo.ts (tapatybės komentaras, 11-19 eil.)

## Tikslas
Quality-gates memo tapatybės `tree` hash'as neturi anuliuotis nuo failų, kurių vartų
komandos net neskaito. Dabar VIENAS task failo perkėlimas (requeue, bucket judinimas)
pakeičia viso medžio hash'ą, memo prašauna, ir stop guard'as suka pilną ~4 min
`pnpm build && pnpm test` — lygiagrečiai su gyvu dispatch'u, kur apkrova jau vertė
UI testą į timeout (2026-08-27 08:13 stop blokas).

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/process/gates-memo-store.ts`
- `src/application/quality-gates/gates-memo.ts`
- `src/tests/process-gates-memo-store.test.ts`
- `src/tests/quality-gates.test.ts`

Draudžiama:
- `src/application/quality-gates/quality-gates.ts` (use case logika teisinga — keičiasi tik tapatybės skaičiavimas)
- `src/interfaces/hooks/**`
- `.env`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- FAKTAI: memo tapatybė = `tree` (git add -A + write-tree per laikiną indeksą, visas
  worktree be gitignore'intų) + `dist` + `config`. Orkestratoriaus gyvavimo ciklas
  (`AG/tasks/**` bucket judinimas, `AG/state/**`) keičia `tree` kas kelias minutes, nors
  vartų komandos (`pnpm build`, `pnpm test`) šių kelių NESKAITO — jos tikrina `src`,
  `ui-app` ir paketo konfigus. Rezultatas: memo hit'ų beveik nebūna, kiekvienas stop
  perleidžia pilną suite, o du lygiagretūs suite bėgimai vienoje mašinoje gimdo
  timeout flake'us.
- SPRENDIMO KRYPTIS: laikino indekso konstrukcijoje (`gates-memo-store.identify`)
  iš `tree` hash'o pašalinti aiškų, dokumentuotą orkestratoriaus lifecycle kelių sąrašą:
  `AG/tasks/**`, `AG/state/**`, `AG/logs/**`. Sąrašas yra SIAURAS ir baigtinis —
  numatytoji kryptis lieka „viskas įeina į hash'ą" (fail-closed): nauji keliai memo
  nepraleidžiami, kol kas nors jų explicitai neįtraukė į išimtis su pagrindimu.
- Architektui spręsti: išimtis realizuoti indekso lygiu (neįtraukti kelių į `git add`)
  ar po `write-tree` (pathspec exclude) — bet kuriuo atveju determinizmas ir
  „untracked produkto failai ĮEINA" savybė (gates-memo.ts 12-14 eil.) privalo išlikti.
- `AG/openspec/**` ir `AG/benchmark/**` į išimtis NEĮTRAUKTI: benchmark yra atskiras
  paketas su savo vartais, o openspec turinys gali tapti gate komandų įvestimi —
  abejonė sprendžiama į brangesnę pusę, kaip visame memo dizaine.
- Atnaujinti gates-memo.ts tapatybės komentarą (11-19 eil.), kad jis nemeluotų apie
  „viso medžio" semantiką.
- Testai: (1) `process-gates-memo-store.test.ts` — failo perkėlimas AG/tasks viduje
  NEkeičia `tree` tapatybės; (2) `src` ar `ui-app` failo pakeitimas — keičia;
  (3) untracked produkto failas `src` viduje toliau keičia (savybė išlieka);
  (4) esamas raudono/hit/corrupted elgesys nepakitęs (`quality-gates.test.ts`).

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei sprendimas imtų reikalauti plėsti išimčių
sąrašą už trijų įvardintų kelių arba keisti memo schema_version semantiką — tai
operatoriaus sprendimai.

## Neįtraukta
- Stop guard'o srautas (`stop-guards.ts`) — jis teisingai kviečia vartus; problema tik
  tapatybės jautrume.
- UI testų timeout kalibracija — jau padaryta atskirai (`ui-app/vitest.config.ts` 15s).
- Vartų bėgimo serializacija tarp stop guard'o ir dispatch'o (vienos mašinos lock) —
  atskiro task'o kandidatas, jei flake'ai kartotųsi ir po memo pataisos.
