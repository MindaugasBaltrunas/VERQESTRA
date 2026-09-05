# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/domain/policies/secret-patterns.ts` `SECRET_PATTERNS` turi `jwt` (trys base64url segmentai) ir
`connection-string` (`scheme://user:pass@`) įrašus, o `src/interfaces/hooks/package-guard.ts`
`packageChangedBySession` sprendimui skaito ir „dropped" rašymų sąrašą (kai `post-write.ts`
`appendSessionWrite` grąžino `appended:false`) — ALREADY_IMPLEMENTED: cituok pattern'us ir skaitymo
vietą.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, P2 Hooks; hooks ataskaita
„secret-scan false negatives", „package-guard reason gate fail-open po ledger append drop"):
- `secret-patterns.ts:13-28`: nėra JWT (`eyJ…`), bare connection-string (`postgres://user:pass@`)
  pattern'o; `DATABASE_URL`/`JWT_SECRET` gaudomi TIK su `NAME=` prefiksu → hardcoded JWT ar plika DB URL
  kode nesublokuojama. Etalono paritetas, bet žinoma spraga.
- `interfaces/hooks/package-guard.ts:172-198` + `domain/policies/package-guard.ts:148`: jei
  `post-write.ts:57-59` append'as buvo „drop" (lock timeout, `onLockTimeout: "drop"`), `package.json`
  ledger'yje nėra → `packageChangedBySession=false` → „Package reason" nereikalaujamas → Stop commit'as
  praeina be pagrindimo. Dokumentuotas kompromisas (telemetrija neblokuoja), bet čia telemetrijos gedimas
  ATIDARO vartą.
KORPUSAS (task 157 pamoka, patikrinta 2026-09-05): JWT/connection-string formos repo'je yra 8 failuose
už `pnpm test` ribų — `mobile-app/src/tests/{pairing-doubles.ts,push-notification-adapter.test.ts,
secure-credential-store.test.ts}`, `mobile-gateway/src/tests/{github-git-host-adapter.test.ts,
push-notification-service.test.ts}`, `mobile-gateway/src/infrastructure/{gh-cli-git-host-adapter.ts,
gh-cli-git-host-parse.ts}`, `AG/benchmark/src/tests/secret-redaction.test.ts`. Skeneris skaito TIK
sesijos pakeistus failus (`secret-scan.ts:57`), tad dabar jie neblokuoja, bet bet kuris būsimas jų
edit'as būtų sustabdytas. Kryptis: pattern'ai formuojami taip, kad šie 8 failai duotų 0 radinių
(fixture JWT yra 2 segmentų/trumpi, `user:token@` slaptažodis < 8 simbolių, `${CREDENTIAL}`
placeholder'is), ir tai tvirtinama testu su tiksliomis fixture eilutėmis.

## Agentai
readme-guard -> architect -> security -> coder -> reviewer -> security -> tester

## Failai
Leidžiama:
- `src/domain/policies/secret-patterns.ts`
- `src/interfaces/hooks/post-write.ts` (drop → `session-writes.dropped.json` best-effort įrašas)
- `src/interfaces/hooks/package-guard.ts` (dropped sąrašas įeina į `sessionWrites` įrodymą)
- `src/tests/interfaces-hooks-guards.test.ts` (`findSecretsInText` :140 kaimynystė)
- `src/tests/interfaces-hooks-post-write.test.ts`
- `src/tests/interfaces-hooks-package-guard-ledger-drop.test.ts` (numatomas naujas)

Draudžiama:
- `src/domain/policies/package-guard.ts` (grynas sprendimas nekinta — dropped keliai įmaišomi adapteryje)
- `src/domain/policies/file-classification.ts` (task 205)
- `src/interfaces/hooks/secret-scan.ts` (failų rinkimas nekinta)
- `src/tests/interfaces-hooks-package-migration.test.ts` (task 205)
- `mobile-app/**`
- `mobile-gateway/**`
- `AG/benchmark/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `secret-patterns.ts`: `{ name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/ }`
  ir `{ name: "connection-string", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s@$]{8,}@/i }` (slaptažodis
  ≥ 8 be `$`, tad `${PLACEHOLDER}` neatitinka). SELF-MATCH taisyklė (antraštė :5-7): pattern'o šaltinis
  pats neatitinka savo regex'o — `eyJ[` po `eyJ` eina `[`, o schemos dalis regex'e neturi `://`
  literalo greta `user:pass` formos; patikrinti `findSecretsInText("secret-patterns.ts", <šio failo turinys>)`
  testu → `[]`.
- Korpuso testas: `interfaces-hooks-guards.test.ts` — tikslios 8 failų fixture eilutės (nukopijuotos,
  ne skaitomos iš disko) → 0 radinių; realus 3 segmentų JWT (`eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c`)
  ir `postgres://app:hunter2hunter2@db/x` → radiniai.
- `post-write.ts`: kai `appendSessionWrite` → `appended:false`, kelias best-effort append'inamas į
  `vq/state/session-writes.dropped.json` (JSON string masyvas, be lock'o, rašymo klaida → log eilutė);
  esama garsi log eilutė lieka.
- `package-guard.ts`: perskaityti `session-writes.dropped.json` (neperskaitomas → `[]`); dropped keliai
  jungiami į `sessionWrites` PRIEŠ nuosavybės filtrą (savininko įrašo jie neturi, tad filtras juos
  palieka); nuo šiol drop'intas `package.json` reikalauja `Package reason` — fail-closed. Sesijos pradžia
  (`hook-session-start` reset'as) failo NEliečia — jis valosi kartu su ledger'iu tik jei ten jau yra toks
  mechanizmas; kitaip lieka append-only ir įrašomas į Neįtraukta.
- Testai: post-write drop → dropped faile kelias; package-guard su `package.json` tik dropped sąraše ir
  be reason → BLOCK; su reason → praeina; tuščias/neperskaitomas dropped → elgesys kaip dabar.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei galutiniai pattern'ai vis dar duoda radinį bet
kuriame iš 8 korpuso failų — korpusas (mobile-*, benchmark) šiam task'ui draudžiamas, pattern'as
siaurinamas, ne failai perrašomi.

## Neįtraukta
- High-entropy/base64 bendrasis pattern'as — per daug false positive (hash'ai, lockfile'ai).
- `session-writes.dropped.json` valymas per `hook-session-start` — jei ledger'io reset'as jo neapima,
  atskiras task'as.
- `shouldSkipSecretScan` nested node_modules — task 205.
