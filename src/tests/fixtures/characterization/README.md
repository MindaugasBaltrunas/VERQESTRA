# Characterization fixtures (PAR-1)

Duomenų failai čia yra PAŽODINĖS AG_loop etalono kopijos
(`AG/orchestrator/src/tests/fixtures/characterization/`). Jų NIEKADA neredaguojame
šiame repo: nesutapimas su runner'io rezultatu reiškia, kad VERQESTRA pakeitė
užšaldytą elgesį — taisomas kodas, ne fixture. Record režimo VERQESTRA runner'iai
neturi ir negali turėti.

**Viena išimtis — `context-pack-assembly.json` (VQ-003f).** Ji atsirado po E0, kai etalonas
jau buvo read-only (`CLAUDE.md`: AG_loop liesti tik `tasks.md` anotacijas), tad fixture
failo etalono pusėje NĖRA. `etalon` reikšmes užrašė `scripts/record-context-pack-assembly.mjs`,
paleidęs AG_loop `dist` prieš tuos pačius workspace failus tmpdir'e — etalono repo
neliečiamas. Ir dar viena forma: šis kelias turi SĄMONINGŲ VERQESTRA nukrypimų
(2026-08-21 RAG auditas), tad fixture neša nukrypimų registrą, kurį runner'is uždeda ant
etalono prieš lygindamas. Registras rašomas RANKOMIS; recorder jį perkelia nepakeistą ir
niekada neskaito VERQESTRA elgsenos, tad taisyklė „lūkestis ateina iš etalono" galioja ir čia.

| Failas | Sritis | Banga |
|---|---|---|
| `shared-primitives.json` | canonical JSON, normalizuotas sha256, shortDigest erdvė | E1 (VQ-101) |
| `task-sections.json` | task sekcijų enumeravimas, heading foldingas, bullets | E2 (VQ-201) |
| `scheduling-verdicts.json` | lease/scope-lock verdiktai: claim/fencing/TTL/dead-owner, carve-out, glob aprėptys, fail-closed | E2 (VQ-202) |
| `compression-policy-verdicts.json` | kompresijos branduolys: parse, arrest (įsk. unreadable), deps disabled/arrested, canary kohortos + sha256 bucket lentelė | E2 (VQ-203) |
| `diagnosis-dispositions.json` | diagnozės dispozicijos: deterministinis done greitkelis, no-commit dispozicija, lokali diagnozė, stop kilmės F7 vartai, nonce atgavimas | E2 (VQ-204) |
| `benchmark-verdicts.json` | compareBenchmarkRuns verdiktų matrica + canDeclareOptimizationSuccess (BENCH-2, per-task normalizacija) | E2 (VQ-204) |
| `bash-digest-contracts.json` | digestBashOutput byte-tikslūs kontraktai: test/tsc/eslint/build klasės, silent success, unsupported šakos | E2 (VQ-204) |
| `code-index-queries.json` | CodeIndex: inline workspace → build, graph/impact/semantic/boundary užklausos, manifest + JSONL byte kontraktas | E3 (VQ-301) |
| `worker-task-ir.json` | task Markdown → WorkerTaskIR: canonical/decorated/residue atvejai + fail-closed klaidų kodai, pinned source_sha256 | E3 (VQ-302) |
| `compact-worker-dsl.json` | WorkerTaskIR → compact DSL: byte-tikslūs render'iai (alias/dedup/block formos) + parse klaidos; ir_chars pin'ina IR raktų tvarką | E3 (VQ-302) |
| `context-pack-assembly.json` | pilnas `assembleContextPack` kelias per tmpdir workspace: baseline, heading-miss, budget arbitražas, `--with-code-graph`, kešo `miss`→`hit` idempotencija; pack'as + raktų tvarka + artefaktų keliai + telemetrija, su nukrypimų registru | VQ-003f (atidėta E0, uždaryta po E5) |
