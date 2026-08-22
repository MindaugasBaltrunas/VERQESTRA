## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO AG/orchestrator/src pakeitimo dist pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `npm run build --prefix AG/orchestrator`
- Patikroms naudok tik: `pnpm --dir AG/orchestrator typecheck` ir `pnpm --dir AG/orchestrator test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.

# Task

## Spec source

AG/openspec/changes/verqestra-self-hosting-v1
docs/audits/E6-audit.md

## Tikslas

Sukurti `docs/audits/README.md` — auditų katalogo indeksą.

## Agentai

readme-guard -> documenter

## Failai

Leidžiama:
- `docs/audits/README.md`

Draudžiama:
- `.env`, `.env.*`
- `node_modules/**`, `dist/**`
- visi kiti failai

## Veiksmas

- Sukurti `docs/audits/README.md` su trumpu paaiškinimu, kas yra šis katalogas: epikų audito
  ataskaitos, rašomos po kiekvieno epiko uždarymo, ir kad kiekviena jų yra to epiko VERDIKTAS
  su skaičiais bei radiniais.
- Įdėti lentelę su esamais failais: `E6-audit.md` — E6 (UI app + benchmark paketas), 2026-08-22.
- Paaiškinti, kodėl auditai gyvena `docs/`, o ne `vq/`: `vq/` yra runtime būsena ir jos nėra
  git'e, o auditas yra įrodymas, kurį privaloma commit'inti.
- Nekeisti jokio kito failo.

## Patikra

- `pnpm build`
- `pnpm test`

## Stop

Sustoti, kai `docs/audits/README.md` sukurtas ir patikros žalios.

## Neįtraukta

- Bet kokie kodo pakeitimai.
- Kitų `docs/` failų redagavimas.
