# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-29 operatoriaus nurodymas — „vq/config/worktree-policy.json turi įsijungti dashboard"

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei `#/system` puslapyje yra worktree politikos (w2 lygiagretumo)
jungiklis, kuris per serverio endpoint'ą perjungia
`vq/config/worktree-policy.json` `enabled` reikšmę, o įjungiant
užtikrina `.gitignore` `.ag/worktrees/` eilutę — ALREADY_IMPLEMENTED su
eilučių įrodymu.

## Tikslas
Operatoriaus patirtis (2026-08-29): w2 šiame repo neveikia dėl dviejų
jungiklių (`worktree-policy.json: enabled=false` IR `.gitignore` be
`.ag/worktrees/` eilutės), ir abu perjungiami tik ranka redaguojant
failus — dashboard'as politiką tik RODO (059-a waves view laukas), bet
nevaldo. Operatorius, norintis antro srauto, turi žinoti dviejų failų
vidines detales.

Reikalavimai:

1. **Serveris**: `POST /api/runtime/worktree-policy` su kūnu
   `{ "enabled": true|false }` — perrašo TIK `enabled` lauką
   `vq/config/worktree-policy.json` (kiti laukai, kol 077 jų
   nepašalino, išsaugomi kaip yra). Įjungiant (`true`) — idempotentiškai
   užtikrina `.ag/worktrees/` eilutę projekto `.gitignore` (append su
   komentaru, jei trūksta; jokio kito .gitignore turinio keitimo) ir
   log eilutę `WORKTREE POLICY: enabled=<v> gitignore=<ok|appended>`.
   Jokių kitų parametrų iš request'o.
2. **View**: waves/system view atsakymas šalia esamo politikos lauko
   (059-a) papildomas `worktree_gitignore_ok: boolean`, kad UI galėtų
   rodyti pilną parengtį.
3. **UI (`#/system`, RuntimePanel ciklo valdymo zona)**: jungiklis
   „W2 lygiagretumas (worktree)" su būsenomis įjungta/išjungta/keičiama;
   šalia — parengties eilutė: kai `enabled` bet `!gitignore_ok` —
   įspėjimas su priežastimi. Perjungus rodoma serverio tiesa (perskaityta
   iš naujo), ne optimistinis spėjimas. Subtekstas: pakeitimas galioja
   nuo KITOS bangos; vykdomos bangos nestabdo.

Dizainas pagal esamą System puslapio kalbą: aiškios būsenos, `title`
priežastys, abi temos, tekstai per `t(...)`, naujos className su
taisyklėmis `dashboard.css`.

## Agentai
readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `src/interfaces/http/ui-worktree-policy.ts` (naujas)
- `src/interfaces/http/ui-router-mutations.ts`
- `src/interfaces/http/ui-router-model.ts`
- `src/interfaces/http/ui-waves-view.ts`
- `src/composition/ui/router-adapters.ts`
- `src/tests/interfaces-http-worktree-policy.test.ts` (naujas)
- `src/tests/interfaces-http-waves-view.test.ts`
- `ui-app/src/model/api.ts`
- `ui-app/src/model/types.ts`
- `ui-app/src/view/components/RuntimePanel.tsx`
- `ui-app/src/view/components/RuntimePanel.test.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `src/application/scheduling/**` (politikos VARTOJIMAS nesikeičia — tik
  valdymas)
- `vq/config/worktree-policy.json` (reikšmę perjungs OPERATORIUS per UI,
  ne šis task'as)
- `.gitignore` (eilutę įrašys endpoint'as runtime metu, ne šis task'as)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: endpoint'o vieta ir .gitignore append saugumo kontraktas
  (tik trūkstamos eilutės pridėjimas, idempotentiška, jokio esamo turinio
  keitimo); suderinti su 077 (laukų šalinimu) — rašymas per parserį, kad
  nepri(g)amintų šalinamų laukų.
- Tester: enable be gitignore eilutės → eilutė atsiranda, log eilutė;
  enable su eilute → .gitignore nepaliestas; disable → tik enabled
  keičiasi; UI rodo parengties įspėjimą kai gitignore_ok=false.

## Patikra
- `pnpm build`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
Politikos laukų šalinimas (077). Slot'ų skaičiaus valdymas (jau yra W1/W2
pasirinkimas). GeoGravity diegimo perjungimas (operatorius per jo UI, kai
kodas atkeliaus).
