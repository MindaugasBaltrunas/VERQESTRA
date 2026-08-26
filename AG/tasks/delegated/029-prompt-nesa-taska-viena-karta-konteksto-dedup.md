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
src/application/context-pack/worker-prompt-compilation.ts (modulio antraštė — dvigubo nešimo tezė)
AG/openspec/changes/auto-029-prompt-nesa-taska-viena-karta-konteksto-dedup/spec.md

## Tikslas
Worker prompt'as task'ą turi nešti VIENĄ kartą. Dabar `buildWorkerPrompt` sujungia pilną
task kūną (raw arba kompiliuotą) su execution context'u, kuris iš pack'o iš naujo renderina
tų pačių task laukų kopijas — goal, acceptance criteria (su stop sąlyga), allowed paths,
checks ir out-of-scope. Auditas 2026-08-26 (53 realūs task failai): kompresija negali
atsipirkti kūno lygyje, nes sutaupymas gyvena šitame dubliavime, o ne task'o teksto formoje.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester -> documenter

## Failai
Leidžiama:
- `src/application/task-execution/execution-context-gate.ts`
- `src/application/context-pack/render-execution-context.ts`
- `src/application/context-pack/render-candidates.ts`
- `src/application/context-pack/worker-prompt-compilation.ts`
- `src/tests/**`

Draudžiama:
- `AG/**` (etalonas read-only)
- `vq/**`
- `.env`

## Dependencies
depends_on: none

## Veiksmas
- FAKTAS: `execution-context-gate.ts:265` (`buildWorkerPrompt`) prie kūno prideda kontekstą,
  o `render-candidates.ts:41-79` ir `:260-267` į tą kontekstą deda `goal`,
  `acceptance-criteria`, `allowed-paths`, `checks`, `out-of-scope` — visi šie laukai
  išvesti iš to paties task failo, kurį kūnas jau neša pilną. Tai yra modulio
  `worker-prompt-compilation.ts` antraštėje įvardyta „the SAME task twice" problema,
  likusi neišspręsta: kompiliuotas kūnas pakeičia tik raw kūną, o konteksto kopijų ne.
- Architektui: parinkti dedup vietą taip, kad `execution-context.md` ARTEFAKTAS liktų
  pilnas (jis skaitomas savarankiškai auditui), o dubliavimas kristų PROMPT'O surinkimo
  metu. Rekomenduojama kryptis: prompt'ą renkant su pilnu task kūnu, task-derived
  kandidatai į pridedamą kontekstą nerenderinami; artefaktas diske nesikeičia.
- Invariantai, kurių laužyti NEGALIMA: (1) vartų fingerprint'as ir toliau skaičiuojamas
  nuo RAW `taskText` baitų; (2) spec fragmentai, code context, architecture blokai
  lieka kontekste nepaliesti; (3) trust boundary taisyklės eilutė lieka; (4) jei
  `execution-context.md` turinys diske NEsikeičia — `CONTEXT_CACHE_VERSION` kelti
  nereikia, jei keičiasi — privaloma pakelti.
- Matavimas: prompt'o dydis prieš/po dedup fiksuojamas dispatch log'e (esama
  `sent_prompt_chars` eilutė) ir testu ant realaus pavyzdžio.
- Atnaujinti `worker-prompt-compilation.ts` ir `execution-context-gate.ts` antraštes:
  elgesys nukrypsta nuo etalono operatoriaus 2026-08-26 užsakymu — įvardyti commit'o
  ataskaitoje.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei dedup reikalautų keisti vartų fingerprint
semantiką, silpninti non-droppable saugiklius savarankiškame artefakte arba kelti
`contextPackSchema` — tada grąžink dizaino klausimą operatoriui.

## Neįtraukta
- IR vidinio dubliavimo taisymas (task 030).
- Preambulės mažinimas (task 031).
- Shadow matavimo poros keitimas (task 032).
- UI pakeitimai.
