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

## Priklausomybės
- 111-worktree-root-ignored-veikia-sviezame-repo-be-katalogo

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/composition/ui/router-adapters.ts` worktree gitignore skaitytojas
(dabar 88-92 eil. trim-lygintuvas) remiasi `worktreeRootIsIgnored`
(check-ignore), o `src/interfaces/http/ui-worktree-policy.ts`
`setWorktreePolicyEnabled` `gitignore_ok` (dabar 92 eil. hardcode `true`)
grąžinamas iš realios patikros per portą — ALREADY_IMPLEMENTED: cituok
abiejų vietų kodą ir porto surišimą kaip įrodymą.

## Tikslas
W1/w2 slot'ų audito P1 (2026-09-01): TRYS „gitignore padengta" apibrėžimai
nesutaria, ir šiandien tai reali klaidinanti situacija — UI rodo „padengta",
o provisioning'as krenta. Patikrinta: (1) vykdymo tiesa —
`worktree-layout.ts:85-88` per `git check-ignore` (`filterGitIgnored`,
`git-client.ts:55-68`); (2) UI skaitytojas — `router-adapters.ts:88-92`
`isWorktreeGitignoreCovered`: `line.trim() === ".ag/worktrees/"` — eilutė su
PRIEKINIU tarpu praeina trim'ą, bet git'ui tarpas pažodinis, tad šablonas
neveikia; UI sako „padengta", git sako „ne"; (3) perjungiklis —
`ui-worktree-policy.ts:61-63` tas pats trim-lygintuvas, PLIUS 92 eil.
`gitignore_ok: true` grąžinamas BESĄLYGIŠKAI — laukas hardcode'intas, ne
matuojamas. Sprendimas: visi trys remiasi TA PAČIA check-ignore tiesa
(`worktreeRootIsIgnored`, kurios šviežio repo kontraktą taiso 111 — todėl
priklausomybė); trim-lygintuvas gali likti nebent kaip diagnostikos detalė
„eilutė faile yra, bet git jos nemato". SLUOKSNIŲ RIBA: `ui-worktree-policy.ts`
yra interfaces ir infrastructure importuoti NEGALI — tiesa ateina per naują
`WorktreePolicyPorts` narį, kurį suriša composition
(`router-adapters.ts:129 worktreePolicyPorts`; composition importuoti infra
gali).

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/ui/router-adapters.ts`
- `src/interfaces/http/ui-worktree-policy.ts`
- `src/tests/interfaces-http-worktree-policy.test.ts`
- `src/tests/interfaces-http-worktree-policy-endpoint.test.ts`
- `src/tests/composition-worktree-policy-wiring.test.ts`

Draudžiama:
- `src/infrastructure/git/worktrees/worktree-layout.ts` (111 scope — čia tik
  vartojama)
- `src/interfaces/http/ui-waves-view.ts` (`worktree_gitignore_ok` porto forma
  nekinta — keičiasi tik adapterio implementacija už jos)
- `src/interfaces/http/ui-router-mutations.ts` (endpoint'o forma nekinta)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `router-adapters.ts`: `isWorktreeGitignoreCovered` skaitytojas (90-102
  eil.), maitinantis waves view `worktree_gitignore_ok`, pereina prie
  `worktreeRootIsIgnored(projectRoot)`; trim-lygintuvas arba šalinamas, arba
  paliekamas TIK diagnostikos žinutei atskirti „eilutės nėra" nuo „eilutė
  yra, bet git jos nemato".
- `ui-worktree-policy.ts`: `WorktreePolicyPorts` gauna narį (pvz.
  `rootIsIgnored(): Promise<boolean>`); `setWorktreePolicyEnabled` po
  įjungimo/append'o grąžina `gitignore_ok` iš REALIOS patikros, ne literalo;
  išjungimo šakos kontraktas („.gitignore niekada neliečiamas") nekinta —
  ką grąžinti išjungiant, sprendžia vykdytojas ir pagrindžia doc-komentare.
- `router-adapters.ts` (`worktreePolicyPorts`, 129 eil.): naujo porto
  surišimas su `worktreeRootIsIgnored`.
- Testų lūkestis: (1) regresija visiems trims — `.gitignore` su eilute
  ` .ag/worktrees/` (priekinis tarpas) → „nepadengta" (port stub'ai grąžina
  check-ignore tiesą, ne trim'ą); (2) `gitignore_ok` atspindi porto
  rezultatą — hardcode'into `true` assert'ai
  (`interfaces-http-worktree-policy.test.ts:54,79,104`,
  `endpoint.test.ts:134,157`) perrašomi į elgesio patikras, ne silpninami;
  (3) wiring testas patvirtina, kad composition suriša tą pačią funkciją.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei paaiškėtų, kad
`gitignore_ok: false` atsakymas UI pusėje reikalauja naujo vartotojo teksto
(ui-app pakeitimas — už šio task'o ribų, atskiras UI task'as).

## Neįtraukta
- `worktreeRootIsIgnored` vidaus taisymas — task 111.
- `ui-app` pusės `worktree_gitignore_ok` atvaizdavimas — kontraktas nekinta,
  UI keisti nereikia; jei `gitignore_ok: false` pateikimui prireiktų UI
  darbo, tai atskiras task'as.
- `preserved-work.ts` / `worktree-provision.ts` — jau naudoja teisingą
  apibrėžimą.
