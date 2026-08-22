# E7 auditas — Self-hosting (VQ-70A)

**Data:** 2026-08-22 · **Apimtis:** VQ-701 (hook'ai), VQ-702 (gyvas ciklas), VQ-703 (variklio atjungimas)
**Commit'ai:** `747dca3`, `ac30d82` (VQ-701), `4cfe0df` (VQ-702), `957e3d6` (VQ-703)

## Verdiktas

**E7 uždarytas su vienu užrašytu atviru radiniu.** VERQESTRA valdo savo pačios repozitoriją:
hook'ai aktyvūs, ciklas įvykdytas nuo eilės iki commit'o, o etalono diegimo formos pašalintos
iš elgsenos. Atviras lieka Stop hook'o ir dispatch'o laiko santykis (žr. žemiau) — jis
nepaverčia rezultato neteisingu, nes gedimas yra fail-closed.

## Ką self-hosting realiai įrodė

Iki E7 vartai buvo tikrinami testais ir sandbox'e. Testas įrodo, kad komponentas elgiasi taip,
kaip parašyta; gyvas ciklas įrodo, kad komponentai VIENAS SU KITU susijungia realiame medyje.
Skirtumas pasirodė iš karto — **penki radiniai, kurių nė vieno nebūtų radęs joks testas**:

| # | Radinys | Kodėl testas jo nerado |
|---|---|---|
| 1 | `verqestra install` buvo sulūžęs (nebuvo `templates/`) | testai kviečia `installTemplates` su savo šaknimi, ne paketo |
| 2 | `hook-on-stop` neturėjo CLI įėjimo | modulis ištestuotas per savo suite'ą; registro jis neliečia |
| 3 | `claude-preflight` reikalauja OpenSpec konteksto, kurio repo neturėjo | testai paduoda kontekstą kaip fikstūrą |
| 4 | Prieinami agentai = SANKIRTA `.claude/agents/*.md` ∩ politikos rolės | testuose abu šaltiniai sutampa pagal konstrukciją |
| 5 | Sandbox taisyklės liepė `pnpm --dir AG/orchestrator ...` | tekstas buvo konstanta; niekas netikrino, ar komanda projekte egzistuoja |

Bendras bruožas: visi penki yra SIŪLĖS tarp komponentų arba tarp kodo ir aplinkos. Būtent ten
migracija ir buvo pažeidžiamiausia, ir būtent to testai pagal apibrėžimą nemato.

## Gyvo ciklo įrodymas (VQ-702)

Užduotis `0001-audits-index` → `docs/audits/README.md`, parašytas agento.

```text
preflight (pass, tier=medium, model=sonnet)
  → claude-preflight (OpenSpec kontekstas, agentų grandinė)
  → context-pack → dispatch (realus claude seansas, ~2,5 min)
  → hook-post-write → hook-pre/post-bash (pnpm build, pnpm test)
  → secret-scan ✅ package-guard ✅ migration-guard (praleistas)
  → Stop hook → COMMIT ×2 → diagnozė verdict=done
```

Stop-bridge įrašas: `status=done`, `"stop hook allowed: commit completed, push disabled by
policy"` — push politika suveikė tiksliai taip, kaip nustatyta.

Jokių API raktų: dispatch varo `claude -p --output-format json` headless, t. y. tą pačią Claude
Code autentikaciją, kurią naudoja operatorius.

## Atviras radinys → E8

**Stop hook'o ir dispatch'o laiko rungtis.** Paskutinis Stop hook'as spėjo paleisti guard'us, bet
jo commit'as neužbaigtas iki tėvinio proceso pabaigos. Koordinatorius pranešė `missing_commit`
ir nukreipė į human-review — **fail-closed, o ne tylus „sėkmė"**. Kryptis teisinga, bet ciklas,
kuriam reikia rankinio užbaigimo, dar nėra pilnai autonominis.

Hipotezė: Stop hook'as be šviežio `vq/state/quality-gates-status.json` pats leidžia `pnpm build`
+ `pnpm test` (~90 s), o dispatch'o procesas tuo metu jau baigiasi. Tikrinama E8 metu.

**Žinoma riba (ne defektas):** retry guard'o memo hash'uoja TIK užduotį, tad APLINKOS pataisymas
(trūkstami agentų failai) jam atrodo kaip „retry without change". Elgesys teisingas — jis
nedegina LLM kvietimo identiškam įvedimui — o remedy eilutė įvardija tikslų veiksmą.

## Skaičiai

| Matas | Reikšmė |
|---|---|
| Šaknies suite | **1380/1380** |
| `ui-app` | 393/393 |
| `AG/benchmark` | 701/704 (3 skip — Windows symlink) |
| Coverage ledger | 0 pending |
| Registre komandų | 72 (su `hook-on-stop`) |
| PENDING hook'ų | **0** — pirmą kartą nuo E5 |
| `readiness-audit` | ok visose penkiose kategorijose |

## Kas lieka E8

- `backlog-audit: incomplete` — eilė turi vieną atliktą užduotį, o auditas laukia 13 produkto
  kategorijų padengimo. Tai ne defektas, o faktas: VERQESTRA dar neturi savo backlog'o.
- `benchmark_evidence: stale` — reikia realaus benchmark paleidimo (VQ-802).
- Etalono užšaldymas (VQ-804) — reikalauja operatoriaus sprendimo, nes liečia read-only repo.
