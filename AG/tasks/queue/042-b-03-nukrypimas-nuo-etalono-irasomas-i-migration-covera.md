# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
Užfiksuoti nukrypimą nuo etalono: preflight griežta OpenSpec nuorodų validacija VERQESTRA'oje taikoma tik deklaruotam spec šaltiniui (etalonas turi tą pačią spragą — klaidingi teigiami iš kūno paminėjimų).

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester
Privaloma naudoti būtent šią grandinę ir tokia tvarka.

## Failai
Leidžiama:
- `migration-coverage.json`

Draudžiama:
- `src/**`
- `.env`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Perskaityk `migration-coverage.json` struktūrą ir esamų nukrypimų formatą; naują įrašą rašyk tiksliai tuo pačiu formatu, nieko kito faile nekeisdamas.
- Įraše nurodyk priežastį: griežtinanti kryptis — deklaruotos nuorodos tikrinamos kaip anksčiau, dingsta tik klaidingi teigiami iš citatų ir prozos paminėjimų.
- Tą pačią priežastį pakartok commit ataskaitoje.

## Patikra
- `pnpm test`

## Stop
Commit'ink, kai patikra žalia. Sustok, jei formatas neaiškus arba įrašui reikėtų keisti schemą ar bet kurį kitą failą.

## Neįtraukta
- Bet koks `src/**` keitimas — jau atlikta ankstesniuose task'uose.
- Etalono `tasks.md` anotacija (`D:\React\AG_loop`) — atskiras operatoriaus žingsnis.
