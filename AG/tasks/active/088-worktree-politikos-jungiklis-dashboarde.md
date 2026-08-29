## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review. `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-29 — „vq/config/worktree-policy.json turi įsijungti dashboard"

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Sukurti worktree politikos PERJUNGIMO modulį (be HTTP maršruto ir be UI): funkcija, kuri perrašo TIK `enabled` lauką `worktree-policy.json` faile ir, įjungiant, idempotentiškai užtikrina `.ag/worktrees/` eilutę projekto `.gitignore`. Visi efektai — per portus (skaitymas, rašymas, log), jokio `node:fs` šiame faile.

Kontraktas:
- `setWorktreePolicyEnabled(ports, { runtimeRoot, projectRoot, enabled })`
- JSON perrašomas per parserį: kiti esami laukai išsaugomi kaip yra, `enabled` pakeičiamas.
- `enabled=true`: jei `.gitignore` neturi `.ag/worktrees/` eilutės — pridedama gale su komentaru; jokio kito turinio keitimo. Jei turi — failas neliečiamas.
- `enabled=false`: `.gitignore` neliečiamas niekada.
- Grąžina `{ enabled, gitignore_ok: boolean }` ir per log portą rašo `WORKTREE POLICY: enabled=<v> gitignore=<ok|appended>`.

## Agentai
PRIVALOMA grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/http/ui-worktree-policy.ts`
- `src/tests/interfaces-http-worktree-policy.test.ts`

Draudžiama:
- `src/application/scheduling/**`
- `src/composition/ui/router-adapters.ts`
- `vq/config/worktree-policy.json`
- `.gitignore`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: portų forma ir `.gitignore` append saugumo kontraktas (tik trūkstamos eilutės pridėjimas, idempotentiška, esamas turinys nekeičiamas); rašymas per JSON parserį, kad nebūtų atkuriami laukai, kuriuos šalina 077.
- Coder: `ui-worktree-policy.ts` su portų tipais ir use-case funkcija (interfaces sluoksnis, jokio `node:fs`, ≤500 eilučių).
- Tester: enable be eilutės → eilutė pridėta + log `gitignore=appended`; enable su eilute → `.gitignore` nepaliestas + `gitignore=ok`; disable → keičiasi tik `enabled`, kiti JSON laukai išlieka.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei reikėtų keisti failus už `## Failai` ribų arba silpninti esamą testą.

## Neįtraukta
HTTP endpoint'as ir composition wiring (kitas darbas). `worktree_gitignore_ok` waves view lauke (kitas darbas). UI jungiklis `#/system` (kitas darbas). Politikos laukų šalinimas (077).
