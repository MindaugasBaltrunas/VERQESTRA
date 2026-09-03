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

HUMAN-REVIEW-APPROVED: operatorius 2026-09-03 speech paketo dependency patvirtinta

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 120-expo-local-authentication-adapteris-biometric-write-gate

## Žingsnis 0 — ar jau įgyvendinta?
Jei `mobile-app/native/package.json` dependencies turi speech recognition
modulį, o native kompozicija konstruoja `SpeechRecognitionPort`
implementaciją ir paduoda `speech`/`speechConsent` į App terminal portus —
ALREADY_IMPLEMENTED: cituok dependency, adapterį ir surišimą kaip įrodymą.

## Tikslas
Mobile audito P1 (2026-09-01): speech platform adapterio NĖRA. Patikrinta:
`mobile-app/src/adapters/speech/push-to-talk-recorder.ts` ima
`SpeechRecognitionPort` (`mobile-app/src/model/ports.ts:95`), šalia
`cloud-consent-store.ts` — `SpeechConsentPort` (111 eil.); platform
implementacijos niekur nėra, `native/package.json` be jokio speech modulio.
`speech` portas SĄMONINGAI optional (`create-app-runtime.ts:30-35` — jo
nebuvimas nuima push-to-talk, „no unguarded voice path to fall back to"),
tad tai paskutinis, mažiausiai kritinis C serijos adapteris. Sprendimas:
native adapteris virš pasirinkto speech modulio — konkretų paketą (pvz.
`expo-speech-recognition` ar `@react-native-voice/voice`) pasirenka
vykdytojas pagal expo 54 suderinamumą ir pagrindžia ataskaitoje; consent
saugykla — per esamą `cloud-consent-store` dekoratorių virš 119 secure-store
adapterio. ŠIS TASK'AS AIŠKIAI APIMA dependency keitimą (pasirinktas speech
paketas į `mobile-app/native/package.json`); ŽINOMAS OPERATORIAUS ŽINGSNIS —
`pnpm install`.

## Agentai
readme-guard -> architect -> coder -> reviewer -> security -> tester

## Failai
Leidžiama:
- `mobile-app/native/package.json` (TIK pasirinkto speech modulio dependency
  eilutė)
- `mobile-app/native/src/adapters/native-speech-recognizer.ts` (numatomas
  naujas; vardas gali sekti pasirinktą paketą — išlyga kaip 119/120)
- `mobile-app/native/src/adapters/native-speech-recognizer.test.ts`
  (numatomas naujas, su vietos išlyga)
- `mobile-app/native/src/composition/native-runtime.ts` (speech ir
  speechConsent surišimas)

Draudžiama:
- `mobile-app/src/**` (portai, `push-to-talk-recorder` ir
  `cloud-consent-store` dekoratoriai teisingi)
- `pnpm-lock.yaml` rankinis redagavimas
- `dist/**`
- `node_modules/**`

## Veiksmas
- `native-speech-recognizer.ts`: `SpeechRecognitionPort` implementacija —
  start/stop/rezultatų semantika pagal porto doc'ą (`ports.ts:95`); mikrofonο
  leidimo atmetimas — tipizuota porto klaida, ne tylus tuščias rezultatas
  (esamų `voice-error-states.test.ts` klasių paritetas).
- Kompozicija: `speech` + `speechConsent` (per `cloud-consent-store` virš
  119 secure-store) į `MobileTerminalPorts`; be jų App toliau veikia — tai
  optional portai, kompozicija nekrenta, jei modulis platformoje
  neprieinamas.
- Testų lūkestis: (1) adapterio kontrakto testai su modulio double'u —
  start/rezultatas/stop, leidimo atmetimas, modulio nebuvimas → portas
  nepaduodamas (ne sulaužytas); (2) esami push-to-talk dekoratoriaus testai
  lieka žali.
- PATIKROS PASTABA: papildomai `pnpm test:mobile-app` ir
  `pnpm test:mobile-native` (šakniniai script'ai; `pnpm --dir ...` blokuoja
  bash hook'ai) — rezultatai į ataskaitą; `## Patikra` vartas mobile formų
  neleidžia.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros ir mobile testai žali (arba užfiksuotas likęs
`pnpm install`). Stop ir klausk, jei nė vienas speech paketas nesuderinamas
su expo 54 be native build konfigūracijos keitimų (app.json/plugins) — tai
platesnis sprendimas nei dependency eilutė.

## Neįtraukta
- Cloud transkripcijos tiekėjo integracija — consent mechanizmas jau yra,
  čia tik on-device atpažinimo adapteris.
- Lifecycle adapteris — porto nėra (žr. 118 Neįtraukta).
- Balso UX pakeitimai ekranuose — tik portų užvielinimas.
