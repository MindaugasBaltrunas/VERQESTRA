# VQ-801 — pilnas parity bėgimas

**Data:** 2026-08-22 · **Etalonas:** `D:\React\AG_loop` @ VQ-001 frozen baseline

## Verdiktas

**Parity pasiektas.** Visi 12 characterization rinkinių (166 atvejai) bėga prieš VERQESTRA ir
yra žali; coverage ledger'yje **0 pending**; benchmark paketas duoda TIKSLIAI VQ-001 baseline
skaičių.

## Characterization rinkiniai

| Fixture | Atvejai | Sritis |
|---|---|---|
| `shared-primitives.json` | 16 | canonical JSON, sha256, shortDigest |
| `task-sections.json` | 6 | task sekcijos, heading foldingas |
| `scheduling-verdicts.json` | 47 | lease/scope-lock verdiktai |
| `compression-policy-verdicts.json` | 12 | kompresijos branduolys, arrest, canary |
| `diagnosis-dispositions.json` | 28 | diagnozės dispozicijos, F7 vartai |
| `benchmark-verdicts.json` | 9 | compareBenchmarkRuns matrica |
| `bash-digest-contracts.json` | 8 | digestBashOutput byte kontraktai |
| `code-index-queries.json` | 9 | CodeIndex užklausos + JSONL byte kontraktas |
| `worker-task-ir.json` | 8 | task → WorkerTaskIR |
| `compact-worker-dsl.json` | 9 | IR → compact DSL |
| `cli-exit-contracts.json` | 9 | CLI exit kodai per TIKRĄ registrą |
| `context-pack-assembly.json` | 5 | pilnas assembleContextPack kelias |
| **Viso** | **166** | 12 runner'ių, **177/177 testai žali** |

## Suite'ai

| Paketas | Rezultatas |
|---|---|
| šaknis (`pnpm test`) | **1380/1380** |
| `ui-app` (`pnpm test:ui`) | **393/393** (46 test failai) |
| `AG/benchmark` (`pnpm test:benchmark`) | **701/704** (3 skip — Windows symlink teisės) |

`701/704` sutampa su VQ-001 frozen baseline skaičiumi **tiksliai**. Tai stipriausias turimas
paketo pariteto įrodymas: tie patys testai, tie patys skip'ai, ta pati aplinka.

## Coverage ledger (COV-3)

```text
migrated:      45
wont-migrate:  11
pending:        0   ← cutover reikalavimas patenkintas
```

## Deklaruoti nukrypimai nuo etalono

Parity NEREIŠKIA identiškumo. Kiekvienas nukrypimas užrašytas trijose vietose (commit'as,
etalono `tasks.md`, `migration-coverage.json`), ir kiekvieno kryptis griežtinanti:

| Sritis | Nukrypimas | Kodėl |
|---|---|---|
| RAG (`rag-c3`) | antraštės sekcija baigiama ties tokio paties/aukštesnio lygio antrašte | plokščias chunker'is grąžindavo nepilną sekciją kaip sėkmę |
| RAG (`rag-c4`) | `spec_fragment_truncated` keliauja SU fragmentu | kirpimo žyma buvo išmetama pirmiau už patį fragmentą |
| RAG (`rag-c12`) | trys atskiri praradimų skaičiai | sulietas skaičius atimtų priskyrimą |
| Execution context | versija 2 (trust/provenance/truncated) | prompt injection riba, C2/C8/C13 |
| `allowed_paths` | niekada nekarpomi | `max_files` yra peržiūros slenkstis, ne karpymo limitas |
| CLI exit | tikrinama GRĄŽINTA reikšmė, ne `process.exitCode` | handleriai kodą grąžina; jokios globalios būsenos |
| Higiena | CRLF failai normalizuoti į LF | projekto taisyklė griežtesnė už etalono |
| VQ-003f forma | fixture'as gyvena TIK VERQESTRA pusėje | etalonas po E0 read-only; `etalon` reikšmes užrašė recorder'is |

## Ko šis bėgimas NEĮRODO

- **Token/kaštų pariteto** — tai VQ-802 apimtis; šis dokumentas matuoja ELGSENĄ, ne kainą.
- **Ilgalaikio autonominio ciklo** — VQ-702 įrodė vieną pilną ciklą su vienu rankiniu
  užbaigimu (žr. E7 audito atvirą radinį).
