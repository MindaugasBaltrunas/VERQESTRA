# Task

## Spec source
openspec/changes/verqestra-backlog-v1
vq/logs/orchestrator.log (2026-08-26, `-b-03`/`-a-02` vaikai be nė vieno rašymo)

## Tikslas
Neleisti skaidymui gimdyti vaikų, kuriems nelieka darbo. Šiuo metu vaikas „b" dažnai yra
vaiko „a" tęsinys tuose pačiuose failuose: „a" pabaigia, „b" pasileidžia, neranda ko daryti
ir sudegina pilną dispatch'ą su LLM biudžetu.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/enqueue-child-tasks.ts`
- `src/application/task-execution/task-splitting.ts`
- `src/tests/**`

Draudžiama:
- `.env`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- FAKTAI: 2026-08-26 septyni vaikai baigė be nė vieno `Write`/`Edit` kvietimo. Poros
  matomos plika akimi: `015-a-02` DONE 14:38 → `015-b-03` tuščias 14:44; `018-a-02` DONE
  14:14 → `018-b-03` tuščias 14:54; `024-a-02` ir `024-b-03` — ta pati tema, tie patys
  failai. Kaina — po pilną dispatch'ą kiekvienam.
- FAKTAS: persidengimo netikrina NIEKAS. `missingChildTaskSections`
  (`enqueue-child-tasks.ts:152`) tikrina tik sekcijų buvimą, o `contentSignature` (`:177`)
  yra dedup'as tarp to paties vaiko bandymų, ne tarp brolių.
- Vaikus autorizuoja preflight LLM, tad taisymas yra JO IŠVESTIES validacija, o ne
  algoritmo keitimas: prieš rašant į eilę patikrinti, ar broliai nedeklaruoja tos pačios
  apimties.
- Minimalus vartas: jei dviejų brolių `## Failai / Leidžiama` aibės sutampa VISIŠKAI, tai
  ne skaidymas — tai dublikatas. Toks planas atmetamas su įvardyta priežastimi, o tėvas
  lieka neskaidytas (esamas `invalid` kelias tam jau egzistuoja).
- Dalinis persidengimas LEIDŽIAMAS — jis normalus ir dažnas. Šio task'o riba yra pilnas
  sutapimas; griežtesnė taisyklė be duomenų būtų spėjimas.
- Testai: pilnai sutampančios aibės → planas atmestas, į eilę nerašomas nė vienas vaikas;
  dalinis persidengimas → praeina; skirtingos aibės → praeina.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei paaiškėtų, kad brolių apimtys sutampa dėl to,
kad `## Failai` sekcija vaikams negeneruojama — tada šaknis kita, ir sprendimą priima
operatorius.

## Neįtraukta
- Preflight LLM prompt'o keitimas.
- Baigties priežasčių tikslinimas (task 032).
- Jau eilėje esančių vaikų perrašymas.
