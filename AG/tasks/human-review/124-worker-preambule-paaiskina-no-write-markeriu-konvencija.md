# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/quality-gates/preflight-rules.ts` `verificationPreamble`
(dabar 147-161 eil.) tekstas (1) mini AUDIT_COMPLETE markerį audito/patikros
task'ams ir (2) „bėgimas be nė vieno Write/Edit parkuojamas human-review"
sakinys turi markerių išimtį — ALREADY_IMPLEMENTED: cituok preambulės tekstą
ir jo testą kaip įrodymą.

## Tikslas
Gyvo loop bėgimo P1 (2026-09-01 08:32 diagnozė): „patikrinti/pažymėti" tipo
task'ai SISTEMIŠKAI parkuojasi human-review su „executor made no write-tool
calls" po verdict=done — per dvi paras taip parkavosi 072 (08-30 20:06),
015-a-02 (06:07) ir 015-b-03 (08:32). Mechanizmas patikrintas:
`dispositions.ts:255-292` — `done` be commit'o legalus TIK per
ALREADY_IMPLEMENTED (276-288, su no-writes + švarus medis) arba
AUDIT_COMPLETE (267, task 095) markerį; be markerio — human-review
(`resolveNoCommitReviewReason`, 308-309). O vykdytojo instrukcijos —
`verificationPreamble` (`preflight-rules.ts:147-161`, įrašomos į task failą
per `claude-preflight/index.ts:478`) — konvenciją paaiškina TIK pusiau:
ALREADY_IMPLEMENTED formatas yra (152 eil.), bet AUDIT_COMPLETE neminimas
NIEKUR, o 158 eil. sakinys „bėgimas be nė vieno Write/Edit parkuojamas
human-review" pateiktas BE markerių išimties — jis aktyviai atgraso nuo
legalių no-write baigčių: vykdytojas, sąžiningai baigęs audito task'ą be
radinių, nežino, kad privalo išspausdinti AUDIT_COMPLETE, ir nebando.
Sprendimas: preambulė paaiškina PILNĄ konvenciją — (1) jei task'o išvada
„keisti nieko nereikia" → ALREADY_IMPLEMENTED su patikrinamu pagrindimu
(jau yra, paliekama); (2) jei audito/patikros task'as baigtas be radinių →
galutinę ataskaitą pradėti atskira eilute AUDIT_COMPLETE su apžvelgtos
apimties santrauka; (3) 158 eil. įspėjimas papildomas išimtimi — parkuojamas
bėgimas be rašymų IR be markerio.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/quality-gates/preflight-rules.ts` (TIK
  `verificationPreamble` tekstas; jei tekstas struktūrinamas nauja `##`
  antrašte — kartu `VERIFICATION_PREAMBLE_HEADING_PREFIXES` 166 eil., kad
  strip'as ją pažintų)
- `src/tests/quality-gates-preflight.test.ts` (preambulės turinio testai,
  456 eil. aplinka)
- `src/tests/interfaces-hooks-pre-hooks.test.ts` (398 eil. konstruoja
  preambulę — atnaujinti, jei assert'ai fiksuoja tikslų tekstą)
- `src/tests/task-execution-bucket-transition.test.ts` (15 eil. — tas pats)

Draudžiama:
- `src/domain/diagnosis/dispositions.ts` (markerių priėmimo logika teisinga
  ir sąmoningai fail-closed — keičiasi tik vykdytojo informavimas)
- `src/domain/diagnosis/stream-log.ts` (markerių skaitymas nekinta)
- `src/interfaces/cli/dispatch/claude-preflight/index.ts` (preambulės
  įrašymo kelias nekinta — keičiasi tik šablono turinys)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `preflight-rules.ts` (`verificationPreamble`): papildyti tekstą markerių
  konvencija (2) ir (3) iš Tikslo — glaustai, nes preambulė patenka į
  KIEKVIENĄ dispatch prompt'ą ir jos ilgis yra tokenų kaina; formuluotė turi
  atitikti TIKSLIAI tai, ką `dispositions.ts` priima (markeris atskiroje
  eilutėje ataskaitos pradžioje, no-writes, švarus medis) — pažadas, kurio
  skaitytojas netesės, būtų blogiau už tylą.
- KEŠO SPRENDIMAS (CLAUDE.md „Pack'o semantika ir kešas"): preambulė
  įrašoma į task FAILĄ, kurio hash'as yra cache šaltinis — seni įrašai
  invaliduojasi natūraliai per task teksto pasikeitimą, o
  `execution-context.md` renderis negeneruoja preambulės; vykdytojas
  PRIVALO ataskaitoje užfiksuoti, ar `CONTEXT_CACHE_VERSION` kelti reikia
  (tikėtina — ne), su šiuo pagrindimu ar jo paneigimu.
- Testų lūkestis: (1) `verificationPreamble` tekstas turi AUDIT_COMPLETE
  eilutės instrukciją ir markerių išimtį prie human-review įspėjimo
  (turinio unit testas `quality-gates-preflight.test.ts` stiliumi);
  (2) `stripVerificationPreamble` toliau nuima VISĄ preambulę — įskaitant
  naują tekstą (jei pridėta antraštė — prefiksų sąrašo testas);
  (3) 092/093 bucket-transition ir pre-hooks testai lieka žali su nauju
  šablonu.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei formuluojant paaiškėtų,
kad `dispositions.ts` priimama markerio forma ir preambulėje žadama forma
negali sutapti be dispositions keitimo — priėmimo logikos keisti šiame
task'e negalima.

## Neįtraukta
- `dispositions.ts` markerių priėmimo taisyklių švelninimas — fail-closed
  dizainas (dvigubas įrodymas) yra 060/095 pamokų rezultatas, neliečiamas.
- Retroaktyvus 072/015-a-02/015-b-03 parkavimų sprendimas — operatoriaus
  human-review veiksmas, ne kodo.
- Etalono (`AG/tasks/examples/000-etalonas.md`) Žingsnio 0 sekcijos tekstas
  — task failų šablonas jau reikalauja įrodymo; čia taisomas tik runtime
  preambulės tekstas.
