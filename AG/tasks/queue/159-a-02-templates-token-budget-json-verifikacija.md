# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
Patikrinti, ar `templates/vq/config/token-budget.json` `turnLimits` sutampa su `DEFAULT_TURN_LIMITS` (medium 90, repair 45, small 20, large 180, semanticReview 12) po modelių audito R1–R3 kalibracijos. Jei sutampa — NEDARYTI pakeitimų, ataskaitą pradėti `ALREADY_IMPLEMENTED:` eilute cituojant abu failus.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `templates/vq/config/token-budget.json`

Draudžiama:
- `vq/config/**`
- `src/**`
- `dist/**`

## Veiksmas
- Perskaityti `templates/vq/config/token-budget.json` turnLimits lauką.
- Palyginti su `src/application/token-governance/turn-budget.ts` DEFAULT_TURN_LIMITS.
- Jei reikšmės sutampa, ataskaitą pradėti `ALREADY_IMPLEMENTED:`; jei ne — atnaujinti JSON reikšmes į 90/45.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink tik jei teko keisti JSON; jei tik patikrinai ir sutampa, nekeisk nieko.

## Neįtraukta
- Gyvo `vq/config/token-budget.json` redagavimas — operatoriaus žingsnis.
