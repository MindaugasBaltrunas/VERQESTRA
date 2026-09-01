# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/interfaces/hooks/pre-hooks.ts` `collectKnownTaskIds` (dabar
173-197 eil., bucket sąrašas 190 eil. `["queue", "done"]`) renka id iš VISŲ
bucket'ų (įskaitant active/delegated/human-review/error/failed), o
`etalonas-rules.ts` `priklausomybe-unknown-id` žinutė (186 eil.) nebemini
„(queue/done)" — ALREADY_IMPLEMENTED: cituok bucket sąrašą, žinutę ir
in-flight taikinio testą kaip įrodymą.

## Tikslas
Gyvas incidentas (2026-09-01 ~11:30): loop'ui perkėlus 6 task'us
(097/103/113/114/115/118) į human-review, repo konformance testas
(`interfaces-hooks-pre-hooks.test.ts:438-456` — realūs queue failai prieš
`collectKnownTaskIds` + `validateTaskAgainstEtalonas`) nudažė VISĄ
`pnpm test` raudonai 6-iems queue failams (101→097, 104→103, 116→114,
119→118, 133→115, 135→113). Šaknis patikrinta: `collectKnownTaskIds`
(`pre-hooks.ts:190`) „žinomų id" visatą renka TIK iš `queue` ir `done`
bucket'ų (plius ledger sąjunga — 2026-08-30 075/083 pamokos komentaras
164-168 eil.), o `checkPriklausomybes` (`etalonas-rules.ts:163-190`)
nerastą id paverčia `priklausomybe-unknown-id` pažeidimu. Bet priklausomybės
taikinys, TRANZITU keliaujantis per active/delegated/human-review, yra
NORMALI gyvo ciklo būsena — jis grįš į queue (requeue) arba baigsis done;
laikinas buvimas kitame bucket'e nedaro nuorodos neteisinga. Struktūrinės
validacijos klausimas yra „ar toks task'as EGZISTUOJA", ne „ar jis dabar
patogioje vietoje". Sprendimas: žinomų id visata — VISI bucket'ai (queue/
done/active/delegated/human-review/error/failed; sąrašo šaltinis — esamas
pilnas rinkinys kaip `backlog-audit.ts:30 auditedTaskStates`, ne nauja
kopija be pagrindimo); `unknown-id` lieka TIK neegzistuojančiam niekur.
SEMANTIKOS RIBA: planuoklės tenkinimysis (`satisfiesDependency` — tik
`done`) NEKEIČIAMAS — blokavimas iki done lieka; keičiasi tik struktūrinio
varto „unknown" apibrėžimas. KARTU keistinas etalono tekstas:
`000-etalonas.md` `## Priklausomybės` komentaras (23-27 eil., „TIK task'ų
id iš queue arba done bucket'ų") turi atspindėti naują taisyklę,
IŠLAIKYDAMAS įspėjimą, kad priklausomybė netenkinama iki done ir
human-review gyventojas planą blokuoja.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/hooks/pre-hooks.ts` (`collectKnownTaskIds` bucket sąrašas
  ir 164-168 eil. doc'as)
- `src/domain/tasks/etalonas-rules.ts` (TIK 186 eil. žinutės tekstas —
  taisyklės mechanika nekinta)
- `AG/tasks/examples/000-etalonas.md` (TIK `## Priklausomybės` `>`
  komentaro blokas — suderinimas su nauja taisykle; DĖMESIO: kanoninis
  šablonas, žr. Stop)
- `src/tests/interfaces-hooks-pre-hooks-known-ids.test.ts`
- `src/tests/domain-tasks-etalonas-rules.test.ts`

Draudžiama:
- `src/domain/tasks/graph/validate.ts` (`satisfiesDependency` /
  `invalid-terminal-dependency` — planuoklės semantika NEKEIČIAMA)
- `src/application/quality-gates/preflight-rules.ts` (070 vartas importuoja
  tą pačią `validateTaskAgainstEtalonas` — pakeitimas atiteka savaime,
  atskiro lietimo nereikia)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `pre-hooks.ts` (`collectKnownTaskIds`): bucket sąrašas 190 eil.
  praplečiamas iki pilno bucket'ų rinkinio; doc'as (164-168) atnaujinamas —
  2026-08-30 pamoka (bucket failai, ne vien ledger) lieka cituota, pridedama
  šio incidento pamoka (tranzitas ≠ neegzistavimas). Sąrašo forma —
  pageidautina nuoroda į vieną bendrą konstantą, jei ją galima importuoti
  nepažeidžiant sluoksnių (interfaces → application leidžiamas); kopija
  tik su pagrindimu doc'e.
- `etalonas-rules.ts` 186 eil.: žinutė nebeteigia „(queue/done)" — sako
  „nerasta tarp žinomų task id (jokiame bucket'e)".
- `000-etalonas.md` `## Priklausomybės` komentaras: formuluotė apie taikinio
  vietą atnaujinama (id privalo egzistuoti kuriame nors bucket'e), o
  PLANAVIMO įspėjimas sugriežtinamas atskirai: priklausomybė TENKINAMA tik
  done, tad taikinys human-review bucket'e planą blokuoja iki operatoriaus
  sprendimo — tas perspėjimas privalo likti.
- Testų lūkestis: (1) regresija — priklausomybė į id, gulintį TIK
  human-review (ir active/delegated) → jokio `priklausomybe-unknown-id`;
  (2) id, neegzistuojantis niekur → pažeidimas lieka; (3) 2026-08-30
  scenarijus (queue be ledger) žalias; (4) konformance testas
  (`interfaces-hooks-pre-hooks.test.ts:443-456`) žalias su gyvu repo,
  kuriame taikiniai išsibarstę po bucket'us.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei: (1) etalono komentaro
atnaujinimas pareikalautų keisti DAUGIAU nei `## Priklausomybės` bloką —
etalonas yra kanoninis šablonas ir platesnis jo keitimas reikalauja
operatoriaus pavedimo; (2) paaiškėtų, kad pilnas bucket sąrašas neturi
vienos importuojamos konstantos ir kopijų jau yra kelios — tada sąrašo
kanonizavimas yra atskiras task'as, čia naudojama minimali kopija su doc
nuoroda.

## Neįtraukta
- Planuoklės `invalid-terminal-dependency` semantika
  (`domain/tasks/graph/validate.ts:164-174`): grafo importas taikinį
  TERMINALINIAME statuse (įskaitant human-review) žymi klaida „can never
  satisfy it" — jei gyvi in-flight taikiniai human-review bucket'e dažo ir
  grafo importą, tai ATSKIRAS svarstymas su operatoriumi (etalono komentaro
  „užblokuoja VISĄ eilę" semantika), ne šio struktūrinio varto klausimas.
- `satisfiesDependency` tenkinimosi taisyklė — nekeičiama sąmoningai.
- Pre-write varto kitos taisyklės (`patikra-unknown-command` ir kt.) —
  neliečiamos.
- `src/tests/interfaces-hooks-pre-hooks.test.ts` konformance testo
  komentaro (438-441 eil.) formuluotės atnaujinimas — failas deklaruotas
  human-review gulinčio 124 scope, tad sąmoningai neliečiamas (sankirta be
  galimos priklausomybės); pats testas po pataisos praeis be keitimo, o
  komentaro kalbą galės patikslinti 124 arba atskiras mikro-pakeitimas.
