# 020-b-03 — Garsi žymė, kai session-writes.json trūksta out-of-scope attribution

## Problema

`diagnose-evidence.ts#collectSessionAttribution` (interfaces sluoksnis, šiam task'ui
draudžiamas) kai `!ledger.present`, tyliai praleidžia out-of-scope attribution ir tik
įstumia warning eilutę į `logLines: string[]`. Nėra struktūrizuoto lauko, kurį galėtų
patikrinti testas ar tolesnė logika be string-match į log tekstą. Šis task'as paruošia
**tik domain sluoksnio** papildymą (naują, pilnai adityvų helper'į), kad būsimas
interfaces-layer wiring task'as galėtų šį faktą paimti kaip lauką, o ne parsinti log eilutę.

## Scope

- Modulis: `src/domain/git` (grynas domain sluoksnis, be `node:` importų).
- Šis task'as **neliečia** `diagnose-evidence.ts` ir jokio interfaces/composition failo —
  tik prideda naują eksportą į `changes.ts`, kurį panaudos atskiras, būsimas wiring task'as.
- `sessionScopedChangedFiles` signatūra/elgesys **nekeičiami** — jį naudoja
  `session-write-owners.ts`, `application/task-execution/index.ts` (re-export) ir
  `diagnose-evidence.ts`, visi šiam task'ui už ribų.

## Šaltinio doc

`AG/tasks/delegated/020-b-03-garsi-zyma-kai-session-writes-json-truksta-out-of.md`

## Duomenų Reads/Writes

- Reads: jokių — grynas domain skaičiavimas virš jau paduotų argumentų (sessionWrites masyvo
  ir ledgerPresent boolean'o). Jokio failų/DB skaitymo — tą atlieka `ports.readSessionWrites()`
  interfaces pusėje ir paduoda rezultatą (`ledger.present`) kaip argumentą.
- Writes: jokių.

## Vieši kontraktai

Naujas, adityvus eksportas `src/domain/git/changes.ts`:

```ts
export type SessionScopedAttribution = {
  /** Tas pats filtruotas/dedup'intas sąrašas kaip sessionScopedChangedFiles(...). */
  changedFiles: string[];
  /**
   * True kai session-writes ledger'io failo nebuvo (`ledgerPresent=false`) — out-of-scope
   * attribution šiai sesijai buvo praleista kaip safe fallback (be false human_review).
   * Kvietėjas šį lauką paverčia warning log eilute arba kitu signalu — čia tik faktas.
   */
  outOfScopeAttributionSkipped: boolean;
};

/**
 * Plonas adityvus wrapper'is virš `sessionScopedChangedFiles`: prideda eksplicitinį
 * "ar ledger'io failas buvo" signalą kaip struktūrizuotą lauką, o ne vien log eilutę
 * (task 020-b-03 / regresija 015). Filtro logika NEDUBLIUOJAMA — deleguojama esamai
 * `sessionScopedChangedFiles` funkcijai.
 */
export function sessionScopedAttribution(input: {
  sessionWrites: readonly string[];
  ledgerPresent: boolean;
}): SessionScopedAttribution {
  return {
    changedFiles: sessionScopedChangedFiles(input.sessionWrites),
    outOfScopeAttributionSkipped: !input.ledgerPresent,
  };
}
```

Pastabos dėl dizaino sprendimų:

- **Vienas input objektas**, ne du pozicijos parametrai — atitinka esamą domain stilių šiame
  moduliuose greta (`pendingAttemptChangedFiles(input: {...})` faile `dispositions.ts`) ir
  paliekamą lengviau plečiamą be signatūros lūžio ateityje.
- **Lauko pavadinimas `outOfScopeAttributionSkipped`**, ne vien `ledgerMissing` — vardas
  žymi PADARINĮ (kad attribution buvo praleista), ne vien priežastį, nes tai tiksliai tas
  faktas, kurį šiandien užrašo `logLines.push("WARNING: session-writes.json missing ... —
  skipping out-of-scope attribution ...")`. Kvietėjui (būsimam wiring task'ui) tereikės
  `if (result.outOfScopeAttributionSkipped) logLines.push(...)` vietoj string parsinimo.
- **Reikšmė nepriklauso nuo `sessionWrites` turinio** — net jei kažkas paduotų netuščią
  `sessionWrites` su `ledgerPresent=false` (šiandien praktiškai neįvyksta, nes ledger'io
  nesant `ledger.writes` yra `[]`), `outOfScopeAttributionSkipped` vis tiek liktų `true`:
  vėliavėlė žymi FAKTĄ apie ledger'io buvimą, ne filtro rezultato tuštumą. Tai testuojama
  atskirai (žr. testų planą), kad būsima wiring pusė negalėtų per klaidą sutapatinti šių
  dviejų dalykų.
- **`sessionScopedChangedFiles` lieka nepaliesta** — naujoji funkcija ją tik kviečia, jokio
  filtro perrašymo/dubliavimo.

## Leistini failai

- `src/domain/git/changes.ts`
- `src/tests/domain-git-changes.test.ts` (naujas failas)

## Draudžiami failai

- `src/interfaces/**`
- `src/composition/**`
- `src/application/**`
- bet koks kitas failas, ne aukščiau išvardintas

## Siūloma struktūra

Naujas tipas `SessionScopedAttribution` ir funkcija `sessionScopedAttribution` pridedami
`changes.ts` **pabaigoje**, po esamos `sessionScopedChangedFiles` (dabar baigiasi 165
eilutėje) — jokio esamo kodo perrašymo, tik apenddinimas. Failo dydis lieka gerokai < 500
eilučių (165 + ~20 naujų).

## Duomenų srautas

`ports.readSessionWrites()` (interfaces, būsimas wiring task'as) → `{ present, writes, owners }`
→ (po ownership filtro) → `sessionScopedAttribution({ sessionWrites, ledgerPresent: ledger.present })`
→ `{ changedFiles, outOfScopeAttributionSkipped }` → kvietėjas sprendžia, ar pridėti log eilutę /
struktūrizuotą lauką į `SessionAttribution` rezultatą. **Ši grandinės dalis (interfaces wiring)
NEĮTRAUKTA į šį task'ą** — tik domain sluoksnio pamatas.

## Testavimo planas (`src/tests/domain-git-changes.test.ts`, naujas failas)

1. **Ledger yra, su failais**: `sessionScopedAttribution({ sessionWrites: ["a.ts", "vq/logs/x.log", "../outside.md"], ledgerPresent: true })`
   → `changedFiles` lygus `sessionScopedChangedFiles(["a.ts", "vq/logs/x.log", "../outside.md"])`
   rezultatui (t. y. `["a.ts"]` — runtime/outside keliai atkrenta), `outOfScopeAttributionSkipped === false`.
2. **Ledger yra, tuščias sąrašas**: `sessionScopedAttribution({ sessionWrites: [], ledgerPresent: true })`
   → `changedFiles === []`, `outOfScopeAttributionSkipped === false`.
3. **Ledger'io nėra**: `sessionScopedAttribution({ sessionWrites: [], ledgerPresent: false })`
   → `changedFiles === []`, `outOfScopeAttributionSkipped === true`.
4. (Papildomai, dokumentuoja lauko nepriklausomumą nuo turinio) **Ledger'io nėra, bet
   sessionWrites netuščias** (gynybinis atvejis, praktiškai neįvyksta production kely):
   `sessionScopedAttribution({ sessionWrites: ["a.ts"], ledgerPresent: false })` →
   `changedFiles === ["a.ts"]` (filtras veikia nepriklausomai), bet
   `outOfScopeAttributionSkipped === true` — įrodo, kad vėliavėlė seka `ledgerPresent`, o ne
   filtro rezultato tuštumą.

Testai — grynos unit funkcijos, be IO, be DB, be mock'ų (atitinka projekto unit test taisykles).

## Rizikos

- **Pavadinimų kolizija**: `SessionScopedAttribution` / `sessionScopedAttribution` panašūs į
  jau egzistuojantį `SessionAttribution` tipą `diagnose-evidence.ts` (interfaces sluoksnyje).
  Tai NĖRA konfliktas (skirtingi moduliai, skirtingi eksportai), bet coder'is turi būti
  atsargus perskaitydamas grep rezultatus prieš pervadindamas — šis task'as **neliečia**
  `diagnose-evidence.ts`, tad esamas `SessionAttribution` tipas ten lieka nepakitęs.
- **Ateities wiring rizika (ne šio task'o dalis)**: kai vėliau kas nors sujungs šią funkciją
  su `collectSessionAttribution`, reikės nuspręsti, ar ji pakeičia tiesioginį
  `sessionScopedChangedFiles` kvietimą eilutėje 78, ar veikia greta. Sprendimas paliekamas
  tam task'ui — dabar tik paruošiamas domain kontraktas.
- **`exactOptionalPropertyTypes` / `noUncheckedIndexedAccess`**: naujas kodas neturi
  opcionalių laukų nei indeksuotos prieigos — rizikos nėra.

## Atlikta kai

- `src/domain/git/changes.ts` turi naują eksportuojamą tipą `SessionScopedAttribution` ir
  funkciją `sessionScopedAttribution`, kuri viduje kviečia `sessionScopedChangedFiles` (be
  filtro logikos dubliavimo).
- `sessionScopedChangedFiles` signatūra ir elgesys nepakitę (esami kvietėjai nepaliesti,
  nes jie už šio task'o ribų).
- `src/tests/domain-git-changes.test.ts` (naujas failas) turi bent 3 testus (žr. testavimo
  planą, punktai 1–3; punktas 4 pageidautinas) ir jie žali.
- `pnpm build` ir `pnpm test` žali (lint → build → testai, jokio `node:` importo domain
  sluoksnyje, `changes.ts` lieka ≤ 500 eilučių).
- `src/interfaces/**` ir `src/composition/**` nepaliesti.

---

Šaltinio doc: `AG/tasks/delegated/020-b-03-garsi-zyma-kai-session-writes-json-truksta-out-of.md`
Grandinė: readme-guard → architect → coder → reviewer → tester
