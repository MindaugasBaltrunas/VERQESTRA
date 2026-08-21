// ESLint flat config. Sąmoningai SIAURAS: čia tik tos taisyklės, kurių `tsc` nepagauna, arba
// kurias produktas pats deklaruoja `CLAUDE.md` faile. Stiliaus (formatavimo) taisyklių nėra —
// jos duotų triukšmą be naudos ir konfliktuotų su etalono 1:1 perkėlimu.
//
// Lint YRA `pnpm test` vartų dalis ir bėga PIRMAS — prieš build'ą ir testus. Todėl kiekviena
// čia įjungta taisyklė yra blokuojanti: prieš pridedant naują, ji turi būti paleista ant viso
// `src` ir arba švari, arba ištaisyta. Taisyklė, įjungta „pažiūrėti, ką ras", sustabdytų
// migraciją, o ne pagerintų kodą.
//
// Kai reikia paleisti TIK testus (pvz. lokaliai skaidant klaidas), yra `pnpm test:only`.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // dist yra generuotas; jo lint'as tikrintų kompiliatoriaus išvestį, ne mūsų kodą.
    ignores: ["dist/**", "node_modules/**", "eslint.config.js"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // --- Realios klaidų klasės, kurių tsc nemato -----------------------------------
      // Neapdorotas Promise šiame kode reiškia tyliai prarastą rašymą ar nepatikrintą vartą.
      //
      // `node:test` runner'io `test()` yra IŠIMTIS ir ji deklaruojama tiksliai, ne per bendrą
      // taisyklės išjungimą: runner'is pats laukia registruotų testų, tad jo grąžinamas Promise
      // nėra prarastas darbas. Be šio sąrašo kiekvienas testo kvietimas (785 vnt.) būtų klaida,
      // ir taisyklė, sauganti nuo REALIAI prarastų rašymų, taptų nebeįjungiama.
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            {
              from: "package",
              package: "node:test",
              name: ["test", "describe", "it", "before", "after", "beforeEach", "afterEach"],
            },
          ],
        },
      ],
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // `catch {}` be jokio veiksmo yra sąmoningas šablonas kai kuriuose best-effort keliuose,
      // bet jis privalo būti matomas peržiūroje.
      "no-empty": ["error", { allowEmptyCatch: true }],

      // --- Produkto deklaruotos taisyklės (CLAUDE.md) --------------------------------
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": "allow-with-description", "ts-ignore": true },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],

      // --- Triukšmas, kurio šiame kode nereikia ---------------------------------------
      // Šablonų eilutėse sąmoningai interpoliuojami skaičiai, boolean ir exit kodai.
      "@typescript-eslint/restrict-template-expressions": "off",
      // Tipų sąjungų susiaurinimas kartais paprastesnis per `!`; tsc strict jau saugo.
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    // Testai turi teisę į plikus fake objektus ir tyčinius blogus tipus.
    files: ["src/tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      // Fake portas privalo turėti tokį patį ASINCHRONINĮ parašą kaip tikrasis, net kai jo
      // realizacija yra `store.get(...)` be jokio laukimo. Produkcinėje pusėje taisyklė lieka
      // įjungta: ten `async` be `await` reiškia arba pamirštą `await`, arba melagingą parašą.
      "@typescript-eslint/require-await": "off",
    },
  },
);
