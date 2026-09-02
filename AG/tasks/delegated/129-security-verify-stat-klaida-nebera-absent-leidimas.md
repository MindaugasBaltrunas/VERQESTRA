## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode; jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>
Jei task'as yra auditas/patikra, užbaigta be keistinų radinių — ataskaitą pradėk atskira eilute:
AUDIT_COMPLETE: <ką patikrinai ir kodėl keisti nieko nereikia>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review — NEBENT ataskaita prasideda sąžiningu ALREADY_IMPLEMENTED arba AUDIT_COMPLETE markeriu su įrodymais (žr. Žingsnį 0). `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

HUMAN-REVIEW-APPROVED: operatorius 2026-09-02 „aš visus tasks approve" (security vartai: security-verify kelias)

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/quality-gates/security-verify.ts` neperskaitomo failo
šaka (dabar 88-102 eil.) skiria ENOENT („failo tikrai nėra") nuo kitų stat
klaidų (teisės, FS lūžis → blokuojama), t. y. stat kelio klaida nebevirsta
`"absent"` — ALREADY_IMPLEMENTED: cituok skyrimo kodą (application ar
adapterio pusėje) ir testą kaip įrodymą.

## Tikslas
Audito P2 (2026-09-01): `security-verify` fail-open siaurame lange.
Patikrinta: `security-verify.ts:88-102` — read klaidos atveju sprendimą
„blokuoti ar tik warning" lemia `ports.statPathKind(resolved).catch(() =>
"absent")` (98 eil.), o adapteris `node-fs-adapter.ts` `statKind` (204-212
eil.) VISAS stat klaidas ryja į `"absent"` — įskaitant EPERM/EACCES.
Rezultatas: failas su teisių problema (TEBEEGZISTUOJANTIS, bet
nenuskenuotas dėl pavojingų šablonų) ne-explicit atveju gauna tik warning →
exit 0. Tai prieštarauja 2026-08-24 audito komentarui TAME PAČIAME bloke
(92-97 eil.): „failas, kuris TEBEEGZISTUOJA (teisės, katalogas, laikina FS
klaida), lieka NENUSKENUOTAS... nežinia virsdavo leidimu" — komentaras
aprašo apsaugą, kurią adapterio catch'as apeina. Sprendimo kryptis: skirti
ENOENT nuo kitų stat klaidų. DĖMESIO — `statKind` adapterio elgesio keitimas
paliestų VISUS jo vartotojus (Grep: discovered-docs, kiti), tad forma
(atskiras griežtas porto metodas / trečia reikšmė `"error"` / klaidos
propagavimas tik šiame kelyje) yra vykdytojo sprendimas su pagrindimu —
saugiausia kryptis: naujas siauras metodas ar lokalus stat kvietimas
security-verify portui, esamo `statKind` kontrakto neliečiant.

## Agentai
readme-guard -> architect -> coder -> reviewer -> security -> tester

## Failai
Leidžiama:
- `src/application/quality-gates/security-verify.ts`
- `src/infrastructure/fs/node-fs-adapter.ts` (TIK jei pasirenkamas naujas
  metodas — esamo `statKind` elgesys nekinta be Stop)
- `src/tests/quality-gates-verify.test.ts`
- `src/tests/infrastructure-fs.test.ts` (naujo metodo testai, jei jis
  atsiranda adapteryje)

Draudžiama:
- Esamų `statKind` vartotojų elgesio keitimas (visi kiti moduliai — jų
  „absent" semantika lieka; keisti galima tik pridėti, ne pakeisti)
- `src/interfaces/cli/audit/security-verify.ts` (exit kodų politika
  `blocked ? 1 : 0` nekinta — keičiasi tik kas patenka į blocked)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Pasirinkti ir pagrįsti formą: (a) naujas porto metodas (pvz. stat su
  klaidos rūšimi), surišamas tik security-verify kelyje; (b) `statKind`
  praplėtimas nauja grąžinimo reikšme su VISŲ vartotojų peržiūra — tik jei
  (a) pasirodytų netinkamas, ir tada Stop dėl kontrakto.
- `security-verify.ts` 98-101 eil.: ENOENT → esamas „absent" kelias
  (ištrintas failas neblokuojamas); BET KOKIA kita stat baigtis (teisės,
  klaida, katalogas) → `blockedPaths` su „unreadable" šablonu — kaip
  komentaras 92-97 eil. ir žada.
- Testų lūkestis: (1) regresija — read klaida + stat EPERM double →
  blocked, exit 1 kelias; (2) read klaida + ENOENT → warning, ne blocked
  (ne-explicit atvejis); (3) explicit atvejo elgesys nepakitęs; (4) esami
  security-verify testai žali.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei paaiškėtų, kad be
`statKind` kontrakto keitimo (visų vartotojų peržiūros) apsieiti negalima.

## Neįtraukta
- Kitų `statKind` vartotojų fail-open peržiūra (pvz. discovered-docs
  discovery) — jiems „absent" ant klaidos yra best-effort skaitymo kelias,
  ne saugumo vartas; jei vykdytojas pastebės analogišką vartą, fiksuoti
  ataskaitoje kaip kandidatą.
- `dangerous_code_patterns` politikos turinys — tik skaitymo kelio
  sąžiningumas.
