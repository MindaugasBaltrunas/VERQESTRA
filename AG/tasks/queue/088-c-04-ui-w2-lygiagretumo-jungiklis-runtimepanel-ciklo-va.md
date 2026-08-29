# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
`#/system` puslapio `RuntimePanel` ciklo valdymo zonoje pridėti jungiklį „W2 lygiagretumas (worktree)" su būsenomis įjungta/išjungta/keičiama, kuris kviečia `POST /api/runtime/worktree-policy`. Šalia — parengties eilutė: kai `enabled` bet `!worktree_gitignore_ok`, rodomas įspėjimas su priežastimi (`title`). Po perjungimo rodoma serverio tiesa (view perskaitomas iš naujo), ne optimistinis spėjimas. Subtekstas: pakeitimas galioja nuo KITOS bangos, vykdomos bangos nestabdo.

## Agentai
PRIVALOMA grandinė: readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/model/api.ts`
- `ui-app/src/model/types.ts`
- `ui-app/src/view/components/RuntimePanel.tsx`
- `ui-app/src/view/components/RuntimePanel.test.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `src/**`
- `vq/config/worktree-policy.json`
- `.gitignore`
- `dist/**`

## Veiksmas
- Coder: `types.ts` papildyti `worktree_gitignore_ok`, `api.ts` — mutacijos kvietimas; `RuntimePanel.tsx` — jungiklis + parengties eilutė esama System puslapio kalba (abi temos, `title` priežastys).
- i18n: visi nauji tekstai per `t(...)`; kiekviena nauja `className` gauna taisyklę `dashboard.css` (CSS dengiamumo vartas).
- Tester: jungiklio klikas kviečia endpoint'ą ir perskaito view iš naujo; `enabled && !gitignore_ok` → matomas įspėjimas; `keičiama` būsena blokuoja pakartotinį klikÄ….

## Patikra
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei reikėtų keisti `src/**` (serverio pusė jau padaryta ankstesniuose darbuose).

## Neįtraukta
Slot'ų skaičiaus valdymas (jau yra W1/W2 pasirinkimas). GeoGravity diegimo perjungimas. Politikos laukų šalinimas (077).
