# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-29 operatoriaus užsakytas w1/w2 auditas — GeoGravity w2 darbo praradimo/dubliavimo rizika (P1)

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei baigto, bet dar neintegruoto slot'o būsena išgyvena proceso perkrovimą
(persistinama, ne tik `Map` atmintyje) IR orphan eskalacija atsisako
`branch -D` šakai su neintegruotais commit'ais, kol nėra aiškaus operatoriaus
sprendimo — ALREADY_IMPLEMENTED su eilučių įrodymu.

## Tikslas
Audito P1 pora (2026-08-29), kuri GeoGravity diegime (kur w2 realiai dirba)
reiškia darbo praradimą arba dubliavimą:

1. **`finishedSlots` tik atmintyje**
   (`src/application/scheduling/wave-scheduler-state.ts:39` —
   `new Map<string, FinishedWorkerSlot>()`; į wave snapshot'ą nerašomas).
   Scenarijus: w2 baigia, integracija laukia (`mode=waiting`), loop'as
   krenta → perkrovus worktree + šaka su commit'ais lieka, task'as `active`
   → dispatch'inamas iš naujo → DARBAS DUBLIUOJAMAS, o `parked` signalo
   operatorius negauna.
2. **Eskalacija gali sunaikinti tuos commit'us**: orphan reaper'io
   `escalateOrphanRemoval`
   (`src/infrastructure/git/worktrees/orphan-worktree-reaper.ts:126-176`)
   po 24 h daro `worktree remove --force` + `git branch -D` (`:158,:164`),
   palikdamas tik `.patch` po `vq/` (gitignore'intas katalogas).

Taisymas:
- `finishedSlots` (arba minimali jo projekcija: worker id, task id, šaka,
  worktree kelias, baigties laikas) persistinamas kartu su wave snapshot'u
  ir atkuriamas resume metu — kad integracijos koordinatorius po perkrovimo
  žinotų, jog šaka laukia integracijos, ir NEleistų task'o dispatch'inti
  iš naujo, kol ji neišspręsta (integruota arba parked).
- Eskalacijos vartuose: šaka su commit'ais, kurių nėra pagrindinėje šakoje
  (`merge-base --is-ancestor` neigiamas), NEgali gauti `branch -D` —
  vietoj to task'as/šaka parkuojami operatoriui kaip
  `worker_integration_parked` klasės įvykis, o `.patch` archyvas lieka
  papildoma, ne vienintele, kopija.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/scheduling/wave-scheduler-state.ts`
- `src/application/scheduling/wave-snapshot.ts`
- `src/application/scheduling/wave-snapshot-persist.ts`
- `src/application/scheduling/wave-integration-coordinator.ts`
- `src/infrastructure/git/worktrees/orphan-worktree-reaper.ts`
- `src/tests/scheduling-wave-snapshot.test.ts`
- `src/tests/scheduling-wave-integration.test.ts` (numatomas; jei testas
  gyvena kitur — tas failas vietoje šio, įrašyti į ataskaitą)
- `src/tests/infrastructure-orphan-reaper.test.ts` (numatomas; ta pati
  išlyga)

Draudžiama:
- `src/infrastructure/git/worktrees/worktree-branch-integration.ts`
  (merge logika teisinga — neliečiama)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: snapshot schemos plėtimo forma (schema_version kėlimas, seno
  snapshot'o suderinamumas) ir resume kelio elgesys radus persistintą
  finished slot'ą.
- Tester: (a) snapshot round-trip su finished slot'u; (b) resume →
  task'as NEdispatch'inamas, kol šaka neišspręsta; (c) eskalacija su
  neintegruotais commit'ais → park, ne `-D`; (d) eskalacija su jau
  integruota šaka → elgesys kaip dabar.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei snapshot schemos
keitimas lūžtų prieš gyvus GeoGravity snapshot'us be migracijos kelio.

## Neįtraukta
Preserved ref'ų retencija (075). Merge logikos keitimai. UI atvaizdavimas
(065-b jau dengia).
