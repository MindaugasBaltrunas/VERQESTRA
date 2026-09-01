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

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei (1) `src/application/scheduling/loop-preconditions.ts` `fresh-dist`
patikra (dabar 127 eil.) klaidą paverčia `ok: false` su detail (ne tyliu
tuščiu sąrašu), (2) `last-error-signatures.json` read-modify-write
(`retry-guard.ts:105-107` per `composition/loop/adapters.ts:189-192`) eina
per `withStateFileLock`, ir (3) `worker-lease-store.ts` scope-lock release
klaida (dabar 309-311 eil. `.catch(() => 0)`) palieka žurnalo eilutę —
ALREADY_IMPLEMENTED: cituok visas tris vietas ir testus kaip įrodymą.

## Tikslas
Audito P3 rinkinys — trys to paties dispatch/loop kelio fail-open/tylos
defektai, patikrinti 2026-09-01 (vienas task'as, nes 1 ir 2 testai gyvena
tame pačiame `interfaces-cli-dispatch.test.ts`, o skėlimas priverstų
serializuotis per bendrą testų failą):

1. `loop-preconditions.ts:127` —
`await ports.findStaleDistFiles(...).catch(() => [])`: dist šviežumo BLOCK
patikra klaidos atveju gauna tuščią sąrašą ir tyliai praeina — pasenęs dist
su neperskaitomu build stamp'u dispatch'inamas kaip šviežias. Kontrastas
gretimame bloke (117-125): reapDeadLeases klaida bent virsta note eilute.

2. `retry-guard.ts:105-107` — `readErrorSignatures` → mutacija →
`writeErrorSignatures` BE lock'o (`adapters.ts:189-192` — pliki
readJsonOrEmpty/writeTextFile), nors retry COUNTS tame pačiame kelyje
serializuoti per `withStateFileLock` BŪTENT dėl prarasto inkremento
(`infrastructure/fs/state-file-lock.ts`, žr.
`architecture-graph-store.ts:31-33` istoriją), o w1+w2 dabar realiai
lygiagretūs — dviejų slotų retry vienu metu gali pamesti vienas kito
signatūrą.

3. `worker-lease-store.ts:309-311` — `releaseScopeLocksInStore(...).catch(()
=> 0)`: scope-lock release klaida ryjama BE JOKIOS žurnalo eilutės; scope
lock'ai lieka laikyti iki TTL (iki 15 min tyliai prarasto lygiagretumo), o
operatorius neturi nė vienos eilutės, iš kurios tai matytų. Best-effort
kryptis (ne lūžis — deadlock komentaras 307-308 teisingas) lieka, bet tyla
nėra best-effort dalis.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/scheduling/loop-preconditions.ts`
- `src/interfaces/cli/dispatch/retry-guard.ts` (tik jei lock'as dedamas
  porto kvietimo pusėje)
- `src/composition/loop/adapters.ts` (signatures port'ų surišimas per
  `withStateFileLock`)
- `src/application/scheduling/worker-lease-store.ts` (TIK 309-311 eil. —
  log eilutė prie catch)
- `src/tests/interfaces-cli-dispatch.test.ts` (1 ir 2 punktų testai)
- `src/tests/scheduling-stores.test.ts` (3 punkto testas; jei scope-lock
  release dengiamas `scope-lock-rules.test.ts` — tas failas vietoje šio,
  įrašyti į ataskaitą)

Draudžiama:
- `src/infrastructure/fs/state-file-lock.ts` (primityvas teisingas — tik
  naudojamas)
- `src/application/scheduling/worker-pool-plan.ts`,
  `wave-provisioning.ts`, `wave-pool-planning.ts` (113/114/116 scope)
- `src/composition/loop/command.ts` (115/133 scope)
- `dist/**`
- `node_modules/**`

## Veiksmas
- (1) `loop-preconditions.ts`: catch šaka `fresh-dist` check'ui grąžina
  `ok: false, severity: block` su detail apie skaitymo klaidą — nežinia
  apie dist šviežumą yra blokas, kaip ir pats stale dist.
- (2) signatures rašymo kelias: read-modify-write apvyniojamas
  `withStateFileLock` tuo pačiu raktu kaip failas; forma (adapterio pusėje
  ar retry-guard viduje) — vykdytojo sprendimas, KOPIJŲ nekurti — tas pats
  primityvas kaip counts.
- (3) `worker-lease-store.ts`: catch gauna log eilutę (per deps turimą log
  kanalą; jei tokio nėra — grąžinti klaidą kvietėjui log'inti, elgesio
  nekeičiant) su lease_id ir priežastimi.
- Testų lūkestis: (1) findStaleDistFiles throw → fresh-dist ok:false su
  detail; (2) dvi lygiagrečios signatures mutacijos neprarandа viena kitos
  įrašo (lock'o double'as arba serializacijos assert'as); (3) release
  klaida → žurnalo eilutė, rezultatas lieka ok (best-effort).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei (3) punkte paaiškėtų,
kad `releaseWorkerLease` deps neturi jokio log kanalo ir jo pridėjimas
keistų store kontraktą plačiau nei šis kvietimas.

## Neįtraukta
- ŽINOMI STEBĖJIMAI iš to paties audito (be reprodukcijos, task'ų nekurta):
  `wave-phantom-slots.ts:79` asimetrinė task id normalizacija ir
  `primary_claim_supported ?? true` dubliuotas default'as dviejose vietose —
  kandidatai tik su įrodymu.
- Scope-lock TTL politikos keitimas — 15 min riba lieka; taisoma tik tyla.
- Legacy `last-error-signature` (vienaskaita, 192 eil.) rašymas — paliekamas
  senai įrangai kaip yra.
