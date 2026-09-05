# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 198-vienas-runtime-prefiksu-sarasas-domain-worktree-removal-ji-importuoja

## Žingsnis 0 — ar jau įgyvendinta?
Tikrinti po punktą: (1) `src/domain/git/changes.ts:59-80` be `Buffer`; (2) `changes.ts:22-32`
`runtimePrefixes` turi `vq/generated/` ir `vq/config/` (arba doc'e pagrįsta, kodėl ne);
(3) `src/domain/architecture/graph-hash.ts:28-31` rūšiuoja be `localeCompare`; (4)
`src/application/context-pack/metrics.ts:344-350,174-185` `readContextSizeMetrics` sugadintą eilutę
praleidžia ir suskaičiuoja, ne meta. Visi — ALREADY_IMPLEMENTED su citatomis; kitaip daromi likę.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, P2 Domain ir Application;
`audit-domain.md` #13 (graph-hash dalis), #19 (changes dalis), #33; `audit-application.md` CP-5).
- #19 `git/changes.ts:59-80` `Buffer` (Node globalas) domain sluoksnyje; `architecture-gates.test.ts:138`
  gaudo tik `node:` importus, tad „domain be Node" taisyklė čia apeinama. Kryptis: grynas
  string'ų/`TextEncoder` kelias arba baitų skaičiavimas per portą — be `Buffer`.
- #33 PLAUSIBLE `changes.ts:22-32` `runtimePrefixes` neturi `vq/generated/` ir `vq/config/`, nors
  CLAUDE.md juos vadina runtime; `json-schema-export.ts:148` rašo `vq/generated/json-schema` → gali
  tapti „uncommitted product state"/out-of-scope. Pradėti nuo testo: pakeitimas `vq/generated/x.json`
  → runtime, ne produkto pakeitimas. `vq/config/` — atsargiai: politikos failai YRA commit'inami
  (git-automation-policy.json), tad `vq/config/` prefiksas į runtime sąrašą NEdedamas; įrašyti doc'e.
  `worktree-removal.ts` antras prefiksų sąrašas (I3) — task 198, nuo kurio šis priklauso: po jo
  `runtimePrefixes` yra VIENINTELIS sąrašas, tad `vq/generated/` papildymas veikia ir worktree valymą.
- #13 `graph-hash.ts:28-31` hash payload'o tvarka per `localeCompare` (ICU priklausoma) → snapshot'as
  kitoje mašinoje gali gauti `graph-hash-mismatch`. Kryptis: kodo taškų palyginimas, kaip
  `domain/tasks/graph/model.ts` (task 187).
- CP-5 `context-pack/metrics.ts:344-350,174-185` `readContextSizeMetrics` meta dėl vienos
  sugadintos eilutės; `compression-quality-evidence` `checkCanaryEvidence` tai paverčia blokuojančiu
  `no-canary-evidence`, o `checkCanaryGuardrails` — tyliu praleidimu. Hook'ų rašytojai best-effort,
  tad viena nutrūkusi append eilutė blokuoja final-audit `compression_quality`. Kryptis: sugadintos
  eilutės praleidžiamos, jų skaičius grąžinamas (`skipped_lines`), ir `compression-quality-evidence`
  jį mato kaip pastabą, ne kaip blokerį.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/git/changes.ts` (22-32 prefiksai; 59-80 be `Buffer`)
- `src/domain/architecture/graph-hash.ts` (28-31 eil.)
- `src/application/context-pack/metrics.ts` (174-185, 344-350 eil.)
- `src/tests/domain-git-changes.test.ts`
- `src/tests/git-rules.test.ts`
- `src/tests/infrastructure-fs.test.ts` (`computeArchitectureGraphHash` pin'ai)
- `src/tests/context-pack-metrics.test.ts`

Draudžiama:
- `src/infrastructure/**` (`worktree-removal.ts` prefiksų sąrašas — infra autorius)
- `src/application/release-readiness/compression-quality-evidence.ts` (skaitytojas — jei būtina keisti, žr. Stop)
- `src/domain/tasks/graph/model.ts` (task 187)
- `src/application/context-pack/assemble/persist.ts` (task 190)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `changes.ts`: `Buffer.byteLength`/`Buffer.from` → grynas UTF-8 ilgio skaičiavimas (`TextEncoder`
  yra ES globalas) arba ilgis simboliais su doc'u; `runtimePrefixes` + `vq/generated/`; testai
  `domain-git-changes.test.ts`/`git-rules.test.ts`.
- `graph-hash.ts`: rūšiavimas be `localeCompare`; `infrastructure-fs.test.ts` pin'as — jei hash
  literalas keičiasi, atnaujinti su pastaba, kad senas priklausė nuo ICU.
- `metrics.ts`: `readContextSizeMetrics` grąžina `{ entries, skipped_lines }` (arba lygiavertį
  neprivalomą lauką) ir nemeta; testas su sugadinta eilute tarp gerų.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `readContextSizeMetrics` grąžinimo formos
pokytis reikalauja keisti `compression-quality-evidence.ts` ar `analytics` kvietėjus (ne šio scope) —
tada išlaikyti seną formą ir sugadintas eilutes tik praleisti (skaičių rašyti į log portą).

## Neįtraukta
- `worktree-removal.ts` vs `changes.ts` prefiksų sąrašų suvienijimas (I3) — task 198 (priklausomybė).
- `architecture-gates.test.ts` `Buffer`/`process` globalų gaudymas domain'e — testų autorius.
- `domain/tasks/graph/model.ts` `localeCompare` — task 187.
