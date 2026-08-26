## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.

# Task

## Spec source
docs/audits/ (kompresoriaus auditas 2026-08-26)
src/application/context-pack/worker-prompt-compilation.ts (renderiai ir dydžio sargas)
AG/openspec/changes/auto-031-kompiliuoto-kuno-preambule-moka-uz-save-kompil/spec.md

## Tikslas
Kompiliuoto kūno fiksuota kaina turi būti minimali. Auditas 2026-08-26: preambulė +
fence vidutiniškai prideda ~586 ženklus (IR prompt 3 356 vs IR JSON 2 770), t. y. ~27%
viso raw task dydžio — mažiems task'ams vien ji suvalgo bet kokį įmanomą sutaupymą.
Compact DSL prompt'as (3 356) šiandien NE mažesnis už IR prompt'ą — DSL dokumento
sutaupymą pilnai suvalgo ilgesnė jo preambulė.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/context-pack/worker-prompt-compilation.ts`
- `src/application/context-pack/compact-dsl/**`
- `src/tests/**`

Draudžiama:
- `AG/**` (etalonas read-only)
- `vq/**`
- `.env`

## Dependencies
depends_on: 030-ir-nebe-nesa-sekciju-dvigubai-strukturine-parse-apreptis.md

## Veiksmas
- FAKTAS: `worker-prompt-compilation.ts:246-280` — abu renderiai atidaro fiksuotu
  skaitymo raktu (IR: ~6 eilučių paaiškinimas; DSL: ~10 eilučių markerių legenda) ir
  fence'u. Skaitymo raktas yra būtinas (mašininis formatas be rakto = dviprasmybė),
  bet jo KAINA nebuvo optimizuota.
- Sutrumpinti abiejų renderių preambules iki minimumo, kuris išlaiko vienareikšmį
  perskaitymą: markerių legendą glaudinti (viena eilutė vietoj dešimties, sutartiniai
  skyrikliai), nekartoti to, kas jau pasakyta task_id/sha eilutėje, nepasakoti fence'o
  turinio dar kartą prozoje.
- Vienareikšmiškumas įrodomas, ne deklaruojamas: DSL pusėje lieka decode-atgal-į-IR
  patikra; IR pusėje — JSON schema. Preambulės trumpinimas šių įrodymų neliečia.
- Sėkmės kriterijus fiksuojamas teste ant realaus korpuso: kompiliuoto prompt'o fiksuota
  pridėtinė dalis (compiledChars − dokumento chars) ≤ 250 ženklų abiem režimams.
- Dydžio sargo (`guardCompiledWorkerPromptSize`) semantika nesikeičia: moka arba krenta.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei trumpinimas sukurtų dviprasmį skaitymo
raktą (worker'is nebegalėtų vienareikšmiškai atkurti task'o) — riba yra aiškumas, ne
ženklai.

## Neįtraukta
- Prompt'o lygio dedup (task 029).
- IR struktūros keitimas (task 030 — šis task'as bėga PO jo).
- Matavimo pusė (task 032).
