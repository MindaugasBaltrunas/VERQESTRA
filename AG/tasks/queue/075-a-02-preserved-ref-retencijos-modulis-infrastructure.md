# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
`src/infrastructure/git/rollback-scope.ts:107-110` rašo `refs/verqestra/preserved/<commit>`, bet trynėjo nėra nė vieno (nulis `update-ref -d` per visą `src`) — diske jau 7 ref'ai per 3 paras, kiekvienas laiko pilną medį nuo GC, o `vq/state/rollback-preserved/*.json` irgi be valymo. Sukurk gryną retencijos modulį, kuris nusprendžia, kurie ref'ai pasenę, ir juos pašalina.

Vartai: ref'as trinamas TIK kai (a) jo task'as yra `done`, IR (b) ref'as senesnis nei N parų (numatytoji N=14, konfigūruojama), IR (c) `.json` įraše nėra `recovered=false` žymos iš preserved-work review. Trynimas rašo eilutę `PRESERVED REF EXPIRED: <ref> task=<id> age=<d>`; atitinkamas `.json` pašalinamas kartu.

Pirmiausia atlik Žingsnis 0: jei `refs/verqestra/preserved/*` jau turi retencijos mechanizmą su trynimo kodu, sustok ir raportuok ALREADY_IMPLEMENTED su eilučių įrodymu.

## Agentai
Privaloma grandinė (ta pati eilės tvarka, be praleidimų):
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/git/preserved-ref-retention.ts`
- `src/infrastructure/git/preserved-work.ts`
- `src/infrastructure/git/rollback-scope.ts`
- `src/tests/infrastructure-preserved-ref-retention.test.ts`
- `src/tests/infrastructure-git-preserved-work.test.ts`

Draudžiama:
- `src/composition/loop/command.ts`
- `src/interfaces/hooks/log-rotation.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: tikslus retencijos vartų kontraktas (kada ref'as TIKRAI nebereikalingas) ir jo įėjimai; suderink su 074 eskalacijos sargu, kad neintegruoto darbo ref'as niekada nebūtų laikomas „pasenusiu".
- Coder: naujas `preserved-ref-retention.ts` su ref'ų sąrašo, amžiaus ir `.json` metaduomenų skaitymu bei ref'o pašalinimu (`update-ref -d`); `rollback-scope.ts` liečiamas tik tiek, kiek reikia bendriems ref/JSON kelių konstantoms iškelti.
- Tester: done + amžius > N -> trinamas su log eilute; jaunas / ne-done / `recovered=false` -> paliekamas; nežinoma task'o būsena -> paliekamas.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Stop ir klausk, jei vartai reikalautų trinti ref'ą, kurio task'o būsenos nustatyti neįmanoma.

## Neįtraukta
Modulio prijungimas prie priežiūros ciklo (kita užduotis, priklausanti nuo šios). Ref'ų trynimas `rollback` metu. `git gc` / `reflog expire` kvietimai. `hooks.log` rotacija.
