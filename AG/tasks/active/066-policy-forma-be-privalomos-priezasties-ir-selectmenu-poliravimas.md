# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-28 operatoriaus nurodymas — „jokių 'Pakeitimo priežastis (privaloma)' neturi būti"; kontrakto pakeitimas sąmoningas ir užsakytas

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei policy pakeitimo formoje `#/reviews` nebėra „Change reason" lauko, o
serveris pasiūlymą priima be `reason` (arba su tuščiu) — ALREADY_IMPLEMENTED.

## Tikslas
Operatoriaus reikalavimai Reviews policy formai (2026-08-28):

1. **Pašalinti privalomą „Pakeitimo priežastis" lauką.** Dabar UI reikalauja
   įvesti priežastį (mygtukas užrakintas be jos), o serveris `reason` neša į
   pasiūlymo įrašą. Operatorius spaudžia pasiūlymą sau pačiam — prievolė
   rašyti tekstą sau yra trintis be naudos. Pakeitimas per VISĄ grandinę:
   - UI: textarea, „(required)" žymė, `reasonMissing` logika ir su ja susiję
     pagalbos tekstai išimami; forma — SelectMenu + Send/Cancel.
   - Serveris: `reason` tampa neprivalomas — trūkstamas virsta tuščiu `""`
     (audito žurnalo schema lauko nepraranda; seni įrašai lieka validūs).
2. **SelectMenu — profesionalus IR funkcionalus.** Priėmimo kriterijai,
   kuriuos tester'is patikrina formos KONTEKSTE (kortelėje, ne izoliuotai):
   - atsidaro/užsidaro pele, Enter/Space/Esc, ArrowUp/Down + Enter renkasi;
   - pasirinkta reikšmė realiai pasiekia `onPropose` (boolean — kaip tikras
     boolean, ne "true" tekstas);
   - popover'is neapkerpamas kortelės `overflow` (z-index/positioning) ir
     nelieka kabėti suskrolinus ar paspaudus šalia;
   - fokusas grįžta į trigger'į po uždarymo; `aria-expanded` teisingas;
   - abi temos, focus žiedas matomas.

## Agentai
readme-guard -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/view/components/PolicyControlsPanel.tsx`
- `ui-app/src/view/components/PolicyControlsPanel.test.tsx`
- `ui-app/src/view/components/SelectMenu.tsx`
- `ui-app/src/view/components/SelectMenu.test.tsx`
- `ui-app/src/model/api.ts`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`
- `src/interfaces/http/ui-router-mutations.ts`
- `src/application/policy-governance/policy-proposal-service.ts`
- `src/tests/interfaces-http-router.test.ts`
- `src/tests/policy-governance-proposals.test.ts` (numatomas; jei testas
  gyvena kitame faile — tas failas vietoje šio, įrašyti į ataskaitą)

Draudžiama:
- `src/application/policy-governance/policy-proposals-log.ts` schema
  nesiaurinama (laukas `reason` žurnale LIEKA — tik gali būti tuščias)
- `dist/**`
- `node_modules/**`

## Patikra
- `pnpm build`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
Pasiūlymų atšaukimas (067). Kiti Reviews blokai. AG task'ų priežasčių
laukai kitose formose.
