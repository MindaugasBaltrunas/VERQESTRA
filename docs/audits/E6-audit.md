# E6 auditas — UI app + benchmark paketas (VQ-60A)

**Data:** 2026-08-22 · **Apimtis:** VQ-601 (React dashboard), VQ-602 (benchmark paketas)
**Commit'ai:** `5826ee2` (VQ-602), `3221525` (VQ-601), `6dcb03c` (VQ-601 tęsinys)

## Verdiktas

**E6 uždarytas.** Abu paketai perkelti, abu turi savo vartus, abu bėga CI. Coverage
ledger'yje **0 pending** — COV-3 cutover reikalavimas patenkintas.

## Skaičiai

| Matas | Reikšmė |
|---|---|
| Šaknies paketas | 778 `.ts` failai, 46 437 eilutės, **1375/1375** testai |
| `ui-app` | 115 failų, 16 254 eilutės, **393/393** testai (46 test failai), vite build 92 moduliai |
| `AG/benchmark` | 143 `.ts` failai, ~31 000 eilučių, **701/704** testai (3 skip — Windows symlink teisės) |
| Coverage ledger | 45 migrated + 11 wont-migrate, **0 pending** |
| Failų > 500 eilučių šaknyje | **0** (vartas fail-closed) |

Benchmark'o 701/704 sutampa su VQ-001 frozen baseline skaičiumi **tiksliai** — tai
stipriausias turimas paketo pariteto įrodymas.

## Failų dydžiai už šaknies vartų

Šaknies `≤500 eilučių` vartas skenuoja `src`. Abu E6 paketai turi savo `tsconfig` ir savo
testus, tad į jį nepatenka:

- `ui-app`: 3 failai viršija (`I18nContext.tsx` 747 — vertimų lentelė, `types.ts` 570 — API
  kontraktų deklaracijos, vienas testas 554).
- `AG/benchmark`: 9 failai viršija (didžiausias `schema-validation.ts` 1058).

**Sprendimas: palikta 1:1.** Priežastis nėra tingumas: benchmark'o skaidymas rizikuotų
baseline paritetu, kurį ką tik įrodėme, o `ui-app` viršijimai yra deklaracijų lentelės, kur
skaidymas duotų failų skaičių, o ne aiškumą. Rekomendacija E8 auditui: jei riba plečiama ir
šiems paketams, tai turi būti atskira užduotis su savo įrodymu, o ne E6 šalutinis efektas.

## Ką prijungimas atidengė (svarbesnė audito dalis nei skaičiai)

Migracija „nukopijuok ir paleisk" nieko nebūtų atidengusi — abu paketai kompiliuojasi ir be
serverio. Radiniai atsirado būtent PRIJUNGUS klientą prie serverio:

1. **Maršruto nuokrypis** (`/api/runtime/slots/<id>/mode` vs kliento ir etalono
   `/api/runtime/loop/slots/<id>`). Atsirado VQ-503 metu, išgyveno VQ-50A auditą, nes tuo metu
   kliento nebuvo. **Pamoka: maršrutas be kliento nėra patikrintas kontraktas.**
2. **Nebuvo SPA fallback'o** — `/` grąžindavo 404, dashboard'as nebūtų atsidaręs.
3. **Nebuvo token'o įrašymo** į `index.html` — puslapis būtų atsidaręs, o kiekviena API
   užklausa grįžusi 401 be jokios nuorodos, kodėl.
4. **`resolveStaticPath` nenormalizavo šaknies** — nenormalizuotas kelias Windows'e tyliai
   vertė KIEKVIENĄ asset'ą į SPA fallback'ą (`app.js` grįždavo kaip HTML).
5. **`ui-app` `typecheck` vartas netikrino nieko** — `tsc --noEmit` ant solution stiliaus
   `tsconfig` (`files: []`) išeina su 0. Vartas, kuris visada žalias, kuria įsitikinimą be
   pagrindo. Ištaisyta į `tsc -b --force`, patikrinta tyčia įvestu tipo pažeidimu.

Visi penki uždaryti kartu su testais; 2–5 buvo paveldėti arba įnešti anksčiau, ne E6 regresijos.

## Rizikos, keliaujančios į E7/E8

- `vq/config` tuščias: `milestone-check` teisingai krinta su exit 2 (`quality-policy not found`).
  Uždaro VQ-701 (self-hosting konfigai).
- `docs/` medis dar tuščias, tad `readiness-audit` sako „dar ne" — VQ-803.
- Dashboard'as patikrintas per HTTP smoke ir unit testus, bet ne per gyvą naršyklę su realiu
  loop'u. Tai VQ-702 apimtis.
