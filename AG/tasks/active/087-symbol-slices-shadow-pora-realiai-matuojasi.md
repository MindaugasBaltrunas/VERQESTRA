# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei tas pats `context-size.jsonl` įrašas shadow/SIG režimu gauna ABU
dydžius (`symbol_source_chars > 0` IR `symbol_signature_chars > 0` tam
pačiam pack'ui — patikrinti `measureSymbolTierChars`
`src/application/context-pack/assemble/tiers.ts` ir jo kvietėją
`assemble/persist.ts`), ARBA
`src/interfaces/http/ui-compression-view.ts` `FEATURE_PAIR_SELECTORS`
`symbol_slices` pora pakeista į realiai matuojamą lauką porą —
ALREADY_IMPLEMENTED: cituoti eilutes.

## Tikslas
2026-08-29 kompresijos posistemio auditas:
`src/interfaces/http/ui-compression-view.ts:265` `FEATURE_PAIR_SELECTORS`
`symbol_slices` porą ima iš `symbol_source_chars` vs
`symbol_signature_chars` per `fixedFieldPair` (raw pusė privalo būti > 0,
kad pora būtų matuojama), bet realiame `vq/logs/context-size.jsonl` visų
įrašų `symbol_source_chars` yra 0. Priežastis rašytojo pusėje:
`measureSymbolTierChars` (`src/application/context-pack/assemble/tiers.ts:109–123`)
sumuoja ARBA SRC, ARBA SIG pagal faktinį tier — SIG režimu „SRC stays a
true zero: no source slice was ever read" (komentaras eil. 106–107), tad
pora niekada nesulyginama ir UI vėliava amžinai „unmeasured".

Shadow matavimo prasmė — parodyti, kiek kainuotų SRC vs kiek kainuoja SIG
tam PAČIAM pack'ui. Dabartinė pora lygina du niekada kartu neegzistuojančius
matavimus.

Sprendimo kryptis: shadow matavimas turi duoti abu dydžius tam pačiam
pack'ui. Architect sprendžia, KURIA puse taisyti: (a) skaičiuoti hipotetinį
SRC dydį shadow režimu rašytojo pusėje (`tiers.ts`/`persist.ts` —
atsargiai: papildomas source skaitymas turi likti telemetrija, ne pack'o
turinio keitimas), ar (b) keisti selektoriaus porą UI pusėje į realiai
egzistuojančius laukus. Pasirinkus (a), pack'o turinys NEKEIČIAMAS —
`CONTEXT_CACHE_VERSION` nekeliamas (žr. Neįtraukta).

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/context-pack/assemble/tiers.ts`
- `src/application/context-pack/assemble/persist.ts`
  (`measureSymbolTierChars` kvietėjas, eil. ~126)
- `src/interfaces/http/ui-compression-view.ts`
- `src/tests/context-pack-assemble.test.ts` (assemble telemetrijos
  tvirtinimai jau gyvena čia; jei architect renkasi tik UI pusę — failas
  gali likti nekeistas, įrašyti į ataskaitą)
- `src/tests/ui-compression-view.test.ts`

Draudžiama:
- `dist/**`
- `node_modules/**`
- `src/application/context-pack/metrics.ts` (laukai jau deklaruoti; failas
  yra task 086 scope — nesidalinti)
- `src/application/context-pack/context-cache-key.ts`
  (`CONTEXT_CACHE_VERSION` nekeliamas — pack turinys nesikeičia)
- Tier PARINKIMO logika, keičianti, kas realiai patenka į pack'ą
  (kompresijos elgesys — ne šio task'o scope; čia tik matavimas)

## Veiksmas
- Architect: parinkti kryptį (hipotetinis SRC dydis shadow režimu rašytojo
  pusėje vs selektoriaus poros keitimas UI pusėje) ir užfiksuoti pasirinkimo
  pagrindimą; įvertinti hipotetinio SRC skaičiavimo kainą (ar `source`
  tekstas SIG režimu apskritai pasiekiamas be papildomo I/O — žr. tiers.ts
  komentarą eil. 101–108 apie „no extra I/O" fallback'ą).
- Coder: įgyvendinti pasirinktą kryptį; `fixedFieldPair` kontraktas
  (`ui-compression-view.ts:245`) nesikeičia — keičiasi arba duomenys, arba
  jam paduodama laukų pora.
- Testų lūkestis: SIG režimo pack'as duoda matuojamą `symbol_slices` porą
  (UI vėliava nebe „unmeasured"); SRC režimo elgesys nepakitęs; pack'o
  turinys (fragmentai, tier sprendimai) identiškas prieš ir po keitimo.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei hipotetinio SRC dydžio
skaičiavimas SIG režimu reikalautų papildomo source failų skaitymo, kuris
keistų assemble I/O profilį (telemetrija neturi teisės pabranginti kelio,
kurio kompresija kaip tik pigina).

## Neįtraukta
`CONTEXT_CACHE_VERSION` kėlimas — SĄMONINGAI ne: keičiama tik telemetrija
ir/ar jos skaitymo pusė, pack'o turinys ir kešo raktas nesikeičia; jei
architect sprendimas netikėtai paliestų pack'o turinį — tai stop sąlyga,
ne tylus bump'as. `worker_prompt_chars` rašytojas — task 086
(nepriklausomas). Kešo hit atveju telemetrija nerašoma kaip ir iki šiol —
hit/miss semantikos keitimas ne šio task'o scope.
