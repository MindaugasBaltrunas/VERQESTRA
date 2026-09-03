import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, useI18n } from "../../i18n/I18nContext";
// Žodyno ŠALTINIS, o ne jo eksportas: `lt` sąmoningai neeksportuojamas, o pasikartojusio rakto
// vykdymo metu pamatyti neįmanoma — antrasis tyliai perrašo pirmąjį dar objekto literale.
import i18nSource from "../../i18n/I18nContext.tsx?raw";

function Probe() {
  const { language, setLanguage, t } = useI18n();
  return (
    <>
      <span>{t("Overview")}</span>
      <button type="button" onClick={() => setLanguage(language === "lt" ? "en" : "lt")}>
        switch
      </button>
    </>
  );
}

/** Worker slot'ų valdiklio raktai (task 0051) — sakiniai, kuriuos vartotojas mato System puslapyje. */
function WorkerProbe() {
  const { t } = useI18n();
  return (
    <>
      <span>{t("Worker slots")}</span>
      <span>{t("Could not change the worker count")}</span>
      <span>{t("Last wave: granted {granted} of {requested} requested (limit {max}).")}</span>
      <span>{t("An unknown key with no translation")}</span>
    </>
  );
}

/** Srautų valdiklio raktai (task 0052) — sakiniai, kuriuos vartotojas mato System puslapyje. */
function StreamProbe() {
  const { t } = useI18n();
  return (
    <>
      <span>{t("Loop streams")}</span>
      <span>{t("Stop stream (drain)")}</span>
      <span>{t("Start with {count} stream(s)")}</span>
      <span>
        {t("Abort does not stop a running attempt — it finishes exactly as with drain, and only the reported state differs. A real force-abort is not implemented.")}
      </span>
      <span>
        {t("Stream {stream} gates the whole loop: stopping it stops the loop process, not just this stream.")}
      </span>
    </>
  );
}

describe("I18nProvider", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to Lithuanian and persists an English selection", () => {
    render(<I18nProvider><Probe /></I18nProvider>);
    expect(screen.getByText("Apžvalga")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "switch" }));

    expect(screen.getByText("Overview")).toBeInTheDocument();
    expect(localStorage.getItem("ag-loop-language")).toBe("en");
    expect(document.documentElement.lang).toBe("en");
  });

  it("translates the worker-slot keys and leaves an unknown key untouched", () => {
    render(<I18nProvider><WorkerProbe /></I18nProvider>);

    expect(screen.getByText("Workerių slot'ai")).toBeInTheDocument();
    expect(screen.getByText("Nepavyko pakeisti workerių skaičiaus")).toBeInTheDocument();
    // Vietos rezervuota vertime: sakinio tvarką lemia kalba, ne JSX.
    expect(screen.getByText("Paskutinė banga: išduota {granted} iš {requested} prašytų (riba {max}).")).toBeInTheDocument();
    // Nauji raktai nieko nelaužo: nežinomas raktas ir toliau grįžta toks, koks yra.
    expect(screen.getByText("An unknown key with no translation")).toBeInTheDocument();
  });

  it("translates the loop-stream keys, including the abort limitation and the Stream 1 gate", () => {
    render(<I18nProvider><StreamProbe /></I18nProvider>);

    expect(screen.getByText("Ciklo srautai")).toBeInTheDocument();
    expect(screen.getByText("Stabdyti srautą (užbaigti darbą)")).toBeInTheDocument();
    expect(screen.getByText("Paleisti su {count} srautu (-ais)")).toBeInTheDocument();
    // Sakinys privalo likti sąžiningas ir lietuviškai: abort'as vykdomo bandymo nestabdo.
    expect(
      screen.getByText(
        "Nutraukimas vykdomo bandymo nestabdo — jis užsibaigia lygiai taip pat kaip užbaigiant darbą, skiriasi tik rodoma būsena. Tikras priverstinis nutraukimas neįgyvendintas.",
      ),
    ).toBeInTheDocument();
    // Vietos rezervuota vertime: srauto numeris ateina iš duomenų, o ne iš JSX.
    expect(
      screen.getByText(
        "Srautas {stream} valdo visą ciklą: jį sustabdžius sustoja visas ciklo procesas, o ne tik šis srautas.",
      ),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Operatoriaus valdiklių raktai (task 1235)
// ---------------------------------------------------------------------------
//
// Kodėl atskiras vartas: `t()` nepažįstamą raktą grąžina TOKĮ PATĮ, tad pamirštas vertimas nieko
// nesulaužo — ekrane tiesiog atsiranda angliškas sakinys tarp lietuviškų. O
// `pnpm --dir AG/orchestrator/ui-app typecheck` šito nepagauna iš principo: to tsconfig'o
// `"files": []`, tad komanda yra tuščia. Vienintelis automatinis tinklas yra šis testas.

/**
 * Rakto -> vertimo poros. Tikrinamas TIKSLUS lietuviškas sakinys, o ne vien „skiriasi nuo rakto":
 * atsitiktinis vertimo perrašymas kitu tekstu yra lygiai tokia pati regresija kaip trūkstamas raktas.
 */
const OPERATOR_CONTROL_TRANSLATIONS: ReadonlyArray<readonly [string, string]> = [
  ["Loop controls", "Ciklo valdymas"],
  ["Start loop ({count} stream(s))", "Paleisti ciklą ({count} srautu (-ais))"],
  ["Stop loop", "Stabdyti ciklą"],
  ["Restart loop", "Perkrauti ciklą"],
  ["Confirm restart", "Patvirtinti perkrovimą"],
  ["Fix (requeue)", "Taisyk (grąžinti į eilę)"],
  ["Dismiss", "Uždaryti"],
  // Perkrovimo baigtys: kiekviena pasako, KURIAME žingsnyje sustota, tad nė viena negali dingti.
  ["Loop restarted.", "Ciklas perkrautas."],
  ["Could not restart the loop", "Nepavyko perkrauti ciklo"],
  [
    "Restart failed: the loop did not accept the stop request.",
    "Perkrovimas nepavyko: ciklas nepriėmė stabdymo prašymo.",
  ],
  [
    "Restart cancelled: the loop is still running after the stop request, so it was not restarted.",
    "Perkrovimas atšauktas: po stabdymo prašymo ciklas vis dar veikia, todėl iš naujo nepaleistas.",
  ],
  [
    "Restart cancelled: the loop state could not be confirmed, so it was not restarted.",
    "Perkrovimas atšauktas: ciklo būsenos patvirtinti nepavyko, todėl iš naujo nepaleista.",
  ],
  [
    "Restart failed: the loop stopped but did not start again.",
    "Perkrovimas nepavyko: ciklas sustojo, bet iš naujo nepasileido.",
  ],
  [
    "Restart cancelled: the view was closed before the loop was restarted.",
    "Perkrovimas atšauktas: rodinys uždarytas anksčiau, nei ciklas buvo paleistas iš naujo.",
  ],
  ["Could not stop the loop", "Nepavyko sustabdyti ciklo"],
  ["Task {task} was sent back to the queue.", "Užduotis {task} grąžinta į eilę."],
  ["Could not send the task back to the queue", "Nepavyko grąžinti užduoties į eilę"],
  [
    "The loop process state is not confirmed. Starting is blocked so a second orchestrator cannot be launched; stopping stays available.",
    "Ciklo proceso būsena nepatvirtinta. Paleidimas užblokuotas, kad nebūtų paleistas antras orkestratorius; stabdymas lieka galimas.",
  ],
  [
    "Start, stop, and restart the loop, and choose how many streams it may use.",
    "Paleisk, sustabdyk ar perkrauk ciklą ir pasirink, kiek srautų jam leidžiama.",
  ],
];

/** Vertimo funkcija imama iš to paties provider'io, kurį naudoja programa. */
function translator(): (text: string) => string {
  let translate: ((text: string) => string) | null = null;
  function Capture() {
    translate = useI18n().t;
    return null;
  }
  render(<I18nProvider><Capture /></I18nProvider>);
  if (!translate) throw new Error("I18nProvider did not expose a translator");
  return translate;
}

/**
 * `lt` objekto literalo raktai TEKSTINIU pavidalu. Vykdymo metu jų nebėra: JS objekto literalas
 * pasikartojusį raktą sutraukia į vieną, o pralaimėjęs vertimas dingsta be pėdsakų.
 */
function dictionaryKeys(source: string): string[] {
  const start = source.indexOf("const lt: Record<string, string> = {");
  expect(start, "the lt dictionary literal must be findable in the source").toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n};", start);
  expect(end, "the lt dictionary literal must be terminated").toBeGreaterThan(start);
  const body = source.slice(start, end);
  // Rakto eilutė: lygiai du tarpai (objekto viršutinis lygis), citata, raktas, citata, dvitaškis.
  // Vertimai gali gulėti kitoje eilutėje, tad ieškoma rakto, o ne poros.
  return [...body.matchAll(/^ {2}"((?:[^"\\]|\\.)*)":/gm)].map((match) => match[1] ?? "");
}

function duplicatesIn(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const key of keys) {
    if (seen.has(key)) duplicates.push(key);
    seen.add(key);
  }
  return duplicates;
}

describe("lt dictionary (task 1235 operator controls)", () => {
  beforeEach(() => localStorage.clear());

  it.each(OPERATOR_CONTROL_TRANSLATIONS)("translates %j", (key, expected) => {
    // Trūkstamas raktas grįžta toks, koks yra — būtent taip atrodo pamirštas vertimas ekrane.
    expect(translator()(key)).toBe(expected);
  });

  it("holds every operator-control key exactly once", () => {
    const keys = dictionaryKeys(i18nSource);
    // Bendras raktų kiekis: nulis reikštų, kad skaitytuvas nustojo veikti, o ne kad žodynas švarus.
    expect(keys.length).toBeGreaterThan(500);

    for (const [key] of OPERATOR_CONTROL_TRANSLATIONS) {
      expect(keys.filter((candidate) => candidate === key), `key ${JSON.stringify(key)}`).toHaveLength(1);
    }
  });

  it("has no duplicate key anywhere, because a duplicate silently wins", () => {
    // `lt` yra plokščias objekto literalas: pakartotas raktas nėra klaida nei TypeScript'ui, nei
    // vykdymo metui — vėlesnis įrašas tiesiog perrašo ankstesnį, ir vertimas pasikeičia ten, kur
    // niekas jo nekeitė. Failo komentarai apie tai įspėja; šis testas tą įspėjimą įgyvendina.
    expect(duplicatesIn(dictionaryKeys(i18nSource))).toEqual([]);
  });

  it("detects a duplicate that a running dictionary could never reveal", () => {
    // Sargas be įrodyto jautrumo yra blogiau nei jokio sargo: jis suteikia saugumo jausmą. Sintetinis
    // šaltinis atkartoja būtent tą atvejį, kurio vykdymo metu pamatyti neįmanoma — antrasis „Dismiss"
    // objekte tiesiog laimėtų, ir `t("Dismiss")` grąžintų „Atmesti", nors niekas to nekeitė.
    const injected = [
      'const lt: Record<string, string> = {',
      '  "Loop controls": "Ciklo valdymas",',
      '  "Dismiss": "Uždaryti",',
      '  "Restart loop":',
      '    "Perkrauti ciklą",',
      '  "Dismiss": "Atmesti",',
      '};',
    ].join("\n");

    expect(dictionaryKeys(injected)).toEqual(["Loop controls", "Dismiss", "Restart loop", "Dismiss"]);
    expect(duplicatesIn(dictionaryKeys(injected))).toEqual(["Dismiss"]);
  });
});
