# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-09-03 operatoriaus nurodymas „visus,3" (3 = šie
patvirtinimo vartai) — leidžiama pridėti `expo-local-authentication` į
`mobile-app/native/package.json`; `pnpm install` po to lieka operatoriaus žingsnis.

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 119-expo-secure-store-adapteris-secure-credential-store-portui

## Žingsnis 0 — ar jau įgyvendinta?
Jei `mobile-app/native/package.json` dependencies turi
`expo-local-authentication`, o native kompozicija konstruoja
`BiometricAuthenticatorPort` implementaciją ir per `biometric-write-gate`
paduoda `writeGate` į App terminal portus — ALREADY_IMPLEMENTED: cituok
dependency, adapterį ir surišimą kaip įrodymą.

## Tikslas
Mobile audito P1 (2026-09-01): biometrikos platform adapterio NĖRA.
Patikrinta: `mobile-app/src/adapters/biometrics/biometric-write-gate.ts` ima
`BiometricAuthenticatorPort` (`mobile-app/src/model/ports.ts:201`) —
implementacijos niekur nėra; `native/package.json` be
`expo-local-authentication`. Pasekmė esminė: `MobileTerminalPorts.writeGate`
yra PRIVALOMAS (`create-app-runtime.ts:24-29` — „an unwired shell offers no
terminal at all rather than an unguarded one"), tad be šio adapterio
Terminal ekranas neveikia niekada — 118 kompozicija jį palieka sąžiningai
tuščią. Sprendimas: native adapteris virš `expo-local-authentication`,
atitinkantis `BiometricAuthenticatorPort`, ir terminal portų komplekto
užbaigimas kompozicijoje (stream + gateway iš 118, writeGate iš čia). ŠIS
TASK'AS AIŠKIAI APIMA dependency keitimą (`expo-local-authentication` į
`mobile-app/native/package.json`); ŽINOMAS OPERATORIAUS ŽINGSNIS —
`pnpm install`.

## Agentai
readme-guard -> architect -> coder -> reviewer -> security -> tester

## Failai
Leidžiama:
- `mobile-app/native/package.json` (TIK `expo-local-authentication`
  dependency eilutė)
- `mobile-app/native/src/adapters/expo-biometric-authenticator.ts`
  (numatomas naujas; kelio konvencija — kaip 119, su išlyga)
- `mobile-app/native/src/adapters/expo-biometric-authenticator.test.ts`
  (numatomas naujas, su ta pačia vietos išlyga)
- `mobile-app/native/src/composition/native-runtime.ts` (writeGate ir
  terminal portų surišimas)
- `mobile-app/native/src/core.ts` (TIK BiometricWriteGate ir
  BiometricGateError eksportų pridėjimas — core.ts yra vienintelė leistina
  siūlė į mobile-app paketą, 118 antro bandymo parkavimo pamoka 2026-09-01;
  pagrindime backtick'ų nėra sąmoningai — iki 153 parseris tęstinių eilučių
  tokenus skaičiuoja kaip failus)
- `mobile-app/native/src/tests/core-seam.test.ts` (siūlės paviršius kartu su
  naujais eksportais)

Draudžiama:
- `mobile-app/src/**` (portas ir `biometric-write-gate` dekoratorius
  teisingi)
- `mobile-app/native/src/App.tsx` (props kontraktas nekinta)
- `pnpm-lock.yaml` rankinis redagavimas
- `dist/**`
- `node_modules/**`

## Veiksmas
- `expo-biometric-authenticator.ts`: `BiometricAuthenticatorPort`
  implementacija virš `expo-local-authentication` (hardware nebuvimas /
  neįregistruota biometrika / atmetimas — pagal porto kontrakto semantiką
  `ports.ts:201` doc'e; joks kelias negrąžina „leista" be patvirtinimo).
- Kompozicija: adapteris → `biometric-write-gate` → `writeGate`; kartu
  sukomponuojamas pilnas `MobileTerminalPorts` (gateway, credentials iš 119,
  stream, writeGate) ir paduodamas į App.
- Testų lūkestis: (1) adapterio kontrakto testai su expo double'u — sėkmė,
  atmetimas, hardware nebuvimas; (2) fail-closed regresija — adapterio
  klaida NIEKADA nevirsta leidimu rašyti; (3) kompozicijos testas — terminal
  portai pilni, kai visi adapteriai yra.
- PATIKROS PASTABA: papildomai `pnpm test:mobile-app` ir
  `pnpm test:mobile-native` (šakniniai script'ai; `pnpm --dir ...` blokuoja
  bash hook'ai) — rezultatai į ataskaitą; `## Patikra` vartas mobile formų
  neleidžia.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros ir mobile testai žali (arba užfiksuotas likęs
`pnpm install`). Stop ir klausk, jei porto kontraktas ir expo API
nesuderinami be `BiometricAuthenticatorPort` keitimo — portų kontraktai yra
public API.

## Neįtraukta
- Speech adapteris — task 121.
- `TerminalWriteGatePort` politikos keitimai — gate logika lieka
  dekoratoriuje.
- iOS/Android skirtumų E2E patikra realiame įrenginyje —
  verification-matrix hardware žingsniai, ne CI.
