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
