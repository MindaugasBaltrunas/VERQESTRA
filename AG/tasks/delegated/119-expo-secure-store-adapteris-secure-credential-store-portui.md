## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode; jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>
Jei task'as yra auditas/patikra, užbaigta be keistinų radinių — ataskaitą pradėk atskira eilute:
AUDIT_COMPLETE: <ką patikrinai ir kodėl keisti nieko nereikia>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review — NEBENT ataskaita prasideda sąžiningu ALREADY_IMPLEMENTED arba AUDIT_COMPLETE markeriu su įrodymais (žr. Žingsnį 0). `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

HUMAN-REVIEW-APPROVED: operatorius 2026-09-02 „aš visus tasks approve" (dependency + security vartai: expo-secure-store)

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 118-native-shell-paleidzia-app-su-realiais-portais

## Žingsnis 0 — ar jau įgyvendinta?
Jei `mobile-app/native/package.json` dependencies turi `expo-secure-store`,
o native kompozicija konstruoja `SecureStorePort` implementaciją ir per ją —
`secure-credential-store` App'ui — ALREADY_IMPLEMENTED: cituok dependency
eilutę, adapterio failą ir kompozicijos surišimą kaip įrodymą.

## Tikslas
Mobile audito P1 (2026-09-01): saugyklos platform adapterio NĖRA — yra tik
platform-neutralus dekoratorius. Patikrinta:
`mobile-app/src/adapters/secure-storage/secure-credential-store.ts` ima
`SecureStorePort` (`mobile-app/src/model/ports.ts:155`) — pačios platform
implementacijos niekur nėra; `mobile-app/native/package.json:17-22`
dependencies tik `expo`, `react`, `react-native`, `@verqestra/mobile-app` —
jokio `expo-secure-store`. Be jo įrenginys negali saugoti pairing
kredencialų, tad Connections/pairing srautas realiame telefone neveikia.
Sprendimas: native adapteris virš `expo-secure-store`, atitinkantis
`SecureStorePort` kontraktą, ir jo surišimas kompozicijoje (118 siūlė —
todėl priklausomybė). ŠIS TASK'AS AIŠKIAI APIMA dependency keitimą:
`mobile-app/native/package.json` gauna `expo-secure-store` (constraints
reikalavimas — deklaruojama, ne daroma tyliai); ŽINOMAS OPERATORIAUS
ŽINGSNIS: po keitimo reikalingas `pnpm install` — įrašyti į ataskaitą, jei
aplinka jo neleidžia.

## Agentai
readme-guard -> architect -> coder -> reviewer -> security -> tester

## Failai
Leidžiama:
- `mobile-app/native/package.json` (TIK `expo-secure-store` dependency
  eilutė)
- `mobile-app/native/src/adapters/expo-secure-store-adapter.ts` (numatomas
  naujas; jei konvencija pareikalautų kito kelio — tas failas vietoje šio,
  įrašyti į ataskaitą)
- `mobile-app/native/src/adapters/expo-secure-store-adapter.test.ts`
  (numatomas naujas; jei testai gyvena `native/src/tests/` — ten, įrašyti į
  ataskaitą)
- `mobile-app/native/src/composition/native-runtime.ts` (118 sukurtas —
  surišimas)
- `mobile-app/native/src/core.ts` (TIK `SecureCredentialStore` /
  `SecureStorageError` eksportų pridėjimas — core.ts yra vienintelė leistina
  siūlė į `@verqestra/mobile-app`, 118 antro bandymo parkavimo pamoka
  2026-09-01)
- `mobile-app/native/src/tests/core-seam.test.ts` (siūlės paviršius kartu su
  naujais eksportais)

Draudžiama:
- `mobile-app/src/**` (portas ir dekoratorius teisingi — implementuojama
  native pusėje)
- `pnpm-lock.yaml` rankinis redagavimas
- `dist/**`
- `node_modules/**`

## Veiksmas
- `expo-secure-store-adapter.ts`: `SecureStorePort` implementacija virš
  `expo-secure-store` API; klaidų semantika pagal porto kontraktą
  (`ports.ts:155` doc'as) — trūkstamas raktas nėra išimtis.
- Kompozicija: adapteris → esamas `secure-credential-store` dekoratorius →
  `CredentialPort` App'ui.
- Testų lūkestis: adapterio kontrakto testai su expo modulio double'u (esamo
  `secure-credential-store.test.ts` stilius — jis testuoja dekoratorių su
  porto double'u; čia testuojamas adapteris su expo double'u): get/set/delete
  roundtrip, trūkstamo rakto elgesys, klaidos nepraleidžiamos tyliai.
- PATIKROS PASTABA: vykdytojas PRIVALO papildomai paleisti
  `pnpm test:mobile-app` ir `pnpm test:mobile-native` (šakniniai script'ai;
  `pnpm --dir ...` blokuoja bash hook'ai) — `## Patikra` vartas mobile formų
  neleidžia; rezultatai į ataskaitą.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros ir mobile testai žali (arba užfiksuota, kad
`pnpm install` liko operatoriui). Stop ir klausk, jei `expo-secure-store`
API neleidžia įgyvendinti kurio nors `SecureStorePort` metodo be kontrakto
keitimo.

## Neįtraukta
- Biometrikos adapteris — task 120 (tas pats package.json — todėl grandinė).
- Speech adapteris — task 121.
- `secure-device-identity.ts` dekoratorius — vartoja tą patį portą, atskiro
  darbo nereikia.
