// `benchmark` CLI adapteris (etalonas: interfaces/cli/benchmark/index.ts). Tiltas į atskirą
// `AG/benchmark` workspace paketą: argumentai persiunčiami jam, o KIEKVIENA benchmark'o
// taisyklė — argumentų kontraktas, exit kodai, metrikos ir verdiktas — lieka tame pakete
// (BENCH-1, BENCH-10). Orkestratorius jų neperrašo, nes benchmark matuoja orkestratorių, o
// matuoklis, dalinantis kodą su matuojamu, apie jį nepatikimas.
//
// Paketas įkeliamas PER PORTĄ pagal kelią, ne importu: jis yra atskiras workspace narys ir
// SĄMONINGAI nėra šio paketo priklausomybė, tad išleistas `verqestra` CLI benchmark kodo
// neneša. Kaina — nesamas ar nesukompiliuotas paketas yra runtime būsena, raportuojama kaip
// infrastruktūros klaida kartu su ją taisančia komanda.
//
// VERQESTRA skirtumas nuo etalono: dinaminis `import()` ir failo egzistavimo patikra gyvena
// kompozicijos adapteryje (interfaces sluoksnis infrastructure ir node:fs neimportuoja), o
// mokamų režimų komandų eilutė sudedama iš `nodeExecPath`/`cliEntry` — jų reikšmės ateina iš
// kompozicijos, ne iš `process`.

import path from "node:path";
import { consoleCliIo, type CliIo } from "../registry.js";

/** Benchmark paketo build'o kelias repo šaknies atžvilgiu (paketo kontraktas — lieka AG/…). */
export const BENCHMARK_PACKAGE_ENTRY = path.join("AG", "benchmark", "dist", "index.js");

export const BENCHMARK_BUILD_COMMAND = "pnpm --dir AG/benchmark build";

/**
 * Atkartoja benchmark paketo `BENCHMARK_EXIT_CODES.infrastructureError`.
 *
 * Dubliuojama, o ne importuojama: importas paverstų benchmark paketą kieta priklausomybe —
 * būtent tą ryšį šis adapteris ir egzistuoja išvengti. Dublį pin'ina testas, skaitantis
 * skaičių iš paketo šaltinio, tad išsiskyrimas krenta build'e, o ne tyliai perklasifikuoja
 * nesėkmę.
 */
export const BENCHMARK_INFRASTRUCTURE_EXIT_CODE = 5;

/**
 * Žingsnių lubos, kurių laikosi `verqestra benchmark-drive`; atitinka benchmark paketo
 * `AGENT_SOLO_STEP_LIMIT`. Abu tinkliniai režimai lyginami tarpusavyje, tad skirtingos lubos
 * vienam režimui būtų skirtumas MATAVIME, ne agente.
 */
export const AG_LOOP_STEP_LIMIT = 40;

/**
 * Į vaiką persiunčiami host kredencialų kintamieji — TIK vardai.
 *
 * Atkartoja paketo `FORWARDED_CREDENTIAL_VARIABLES` dėl tos pačios priežasties kaip exit
 * kodas aukščiau. Reikšmė priklauso operatoriaus shell'ui ir niekada šiam repo.
 */
const FORWARDED_CREDENTIAL_VARIABLES: readonly string[] = Object.freeze([
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

/**
 * Forma, kurią benchmark paketas validuoja (jo `AgentInvocationTemplate`).
 *
 * Deklaruojama, o ne importuojama — dėl to paties, dėl ko visas adapteris egzistuoja. Paketas
 * patikrina jam paduotą reikšmę (placeholder'iai, NUL baitai, aplinkos vardai, žingsnių
 * limitas), tad nuklydusi forma atmetama CLI surišimo metu, dar prieš apmokant pirmą celę.
 */
export type AgentInvocationTemplateShape = {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: string;
  /** Persiunčiamų host aplinkos kintamųjų VARDAI; reikšmės čia nepatenka niekada. */
  readonly forwardedEnvironment: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly stepLimit: number;
};

/**
 * Kaip šis diegimas varo `ag-loop` režimą: `verqestra benchmark-drive`, viena ribota ciklo
 * iteracija celei, per šio proceso node binarą ir šio diegimo CLI įėjimą — vaikui nereikia
 * nieko `PATH`'e ir jo negali peradresuoti darbinis katalogas.
 *
 * Limitai paduodami argumentais, nes vaikas pats jų laikosi (`--step-limit` tampa agento turn
 * lubomis, `--timeout-ms` — jo paties kill deadline'u). Jie NEPAKEIČIA harness'o limitų:
 * paketo runner'is nepriklausomai užmuša ties `plan.limits.timeoutMs`, kur agentas negali
 * atsisakyti. `{{prompt}}` paduodamas per standartinę įvestį, ne argumentų vektoriuje, tad
 * scenarijaus tekstas negali nei tapti antru argumentu, nei pasirodyti procesų sąraše.
 *
 * Nematuota-vs-nepavykusi invariantas, kuriuo šis tiltas remiasi: jei vaikas iškrenta dėl
 * usage klaidos dar nepaleidęs `claude` (bloga forma, tuščias stdin), jis NESPAUSDINA
 * telemetrijos envelope. Paketas tokią celę laiko NEMATUOTA ir sample'o nesaugo, tad ledger'is
 * negali imti skambėti kaip „ag-loop nepavyko kiekviename scenarijuje".
 */
export function agLoopInvocationTemplate(nodeExecPath: string, cliEntry: string): AgentInvocationTemplateShape {
  return Object.freeze({
    command: nodeExecPath,
    args: Object.freeze([
      // Absoliutus ir kilęs iš kompozicijos, ne iš projekto šaknies, į kurią nukreipta
      // komanda: vaikas paleidžiamas scenarijaus checkout'e, ne čia.
      cliEntry,
      "benchmark-drive",
      "--workdir",
      "{{workingDirectory}}",
      "--model",
      "{{model}}",
      "--step-limit",
      "{{stepLimit}}",
      "--timeout-ms",
      "{{timeoutMs}}",
    ]),
    stdin: "{{prompt}}",
    forwardedEnvironment: FORWARDED_CREDENTIAL_VARIABLES,
    // Tuščia, ir ribotos celės žymė (`AG_BENCHMARK_BOUNDED_CELL`) čia sąmoningai nededama:
    // paketo `createAgentInvocations` ją injektuoja pats, paskutinis, jau po šio žemėlapio
    // pakeitimo. Kopija čia būtų antras atsakymas per paketo ribą, o injektuota reikšmė vis
    // tiek laimėtų — tad kopija galėtų tik nuklysti nieko nepakeisdama.
    environment: Object.freeze({}),
    stepLimit: AG_LOOP_STEP_LIMIT,
  });
}

/** Benchmark paketo įkėlimo portas (etalono `access` + `import(pathToFileURL(...))`). */
export type BenchmarkPackagePort = {
  /** Ar build'o įėjimas egzistuoja. Nebuvimas — atsakymas, ne klaida. */
  exists(absolutePath: string): Promise<boolean>;
  /** Dinaminis ESM įkėlimas pagal absoliutų kelią; meta, kai modulis neįkeliamas. */
  load(absolutePath: string): Promise<unknown>;
};

export type BenchmarkCommandDeps = {
  packageLoader: BenchmarkPackagePort;
  projectRoot: string;
  /** Node vykdomasis failas mokamų režimų vaikui (etalone `process.execPath`). */
  nodeExecPath: string;
  /** Absoliutus šio diegimo CLI įėjimas (`dist/cli.js`). */
  cliEntry: string;
  io?: CliIo;
};

type BenchmarkCliIo = {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
};

// Tik ta runtime forma, kurią tiltas naudoja. Paketo tipai neimportuojami — tai būtų ta pati
// priklausomybė, kurios adapteris vengia. `options` ir sudėti invocation'ai lieka `unknown`
// dėl to paties: tiltas juos persiunčia, o ne skaito.
type BenchmarkCliModule = {
  runBenchmarkCommand(argv: readonly string[], io: BenchmarkCliIo, options?: unknown): Promise<number>;
  createAgentInvocations(options?: unknown): unknown;
  /**
   * Paties paketo šablonai. Optional ir `unknown`: build'as, senesnis už juos, yra
   * pasenimas, kurį merge'as sugeria, o ne priežastis atmesti komandą.
   */
  readonly DEFAULT_AGENT_INVOCATION_CONFIG?: unknown;
};

function exportsRunBenchmarkCommand(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { runBenchmarkCommand?: unknown }).runBenchmarkCommand === "function"
  );
}

function exportsBenchmarkCli(value: unknown): value is BenchmarkCliModule {
  return (
    exportsRunBenchmarkCommand(value) &&
    typeof (value as { createAgentInvocations?: unknown }).createAgentInvocations === "function"
  );
}

/**
 * Paketui paduodami šablonai: visi, kuriuos jis jau turi, PLIUS šio diegimo `ag-loop` įrašas.
 *
 * Sujungiama, ne pakeičiama. `createAgentInvocations` krenta į savo default'us tik tada, kai
 * konfigo negauna visai, tad plikas `{ "ag-loop": ... }` tyliai atimtų `agent-solo` — režimas,
 * kurį diegimas šiandien gali varyti, imtų raportuoti „no configured agent invocation".
 */
function agentInvocationConfig(loaded: BenchmarkCliModule, template: AgentInvocationTemplateShape): Record<string, unknown> {
  const shipped = loaded.DEFAULT_AGENT_INVOCATION_CONFIG;
  const base = typeof shipped === "object" && shipped !== null ? (shipped as Record<string, unknown>) : {};
  return { ...base, "ag-loop": template };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function benchmarkCommand(deps: BenchmarkCommandDeps, args: string[] = []): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  const fail = (message: string): number => {
    io.error(`benchmark: ${message}`);
    return BENCHMARK_INFRASTRUCTURE_EXIT_CODE;
  };

  const entry = path.join(deps.projectRoot, BENCHMARK_PACKAGE_ENTRY);
  if (!(await deps.packageLoader.exists(entry))) {
    return fail(
      `${BENCHMARK_PACKAGE_ENTRY} nerastas po ${deps.projectRoot}. ` +
        `Benchmark paketas keliauja su repo ir statomas: ${BENCHMARK_BUILD_COMMAND}`,
    );
  }

  let loaded: unknown;
  try {
    loaded = await deps.packageLoader.load(entry);
  } catch (error: unknown) {
    return fail(`${BENCHMARK_PACKAGE_ENTRY} neįkeltas: ${describe(error)}`);
  }

  if (!exportsBenchmarkCli(loaded)) {
    // Dvi pasenimo formos operatoriui atrodo visiškai skirtingai: build'as be komandos
    // neduoda nieko naudojamo, o build'as su komanda bet be invocation factory PALEISTŲ ir
    // tyliai prarastų kiekvieną mokamą režimą į „šis diegimas jo varyti negali".
    const missing = exportsRunBenchmarkCommand(loaded)
      ? "neeksportuoja createAgentInvocations, tad šis diegimas negalėtų varyti mokamų režimų"
      : "neeksportuoja runBenchmarkCommand";
    return fail(`${BENCHMARK_PACKAGE_ENTRY} ${missing}; build'as pasenęs arba nepilnas. Perstatyk: ${BENCHMARK_BUILD_COMMAND}`);
  }

  let agentInvocations: unknown;
  try {
    const template = agLoopInvocationTemplate(deps.nodeExecPath, deps.cliEntry);
    agentInvocations = loaded.createAgentInvocations({ config: agentInvocationConfig(loaded, template) });
  } catch (error: unknown) {
    // Konfigas, kurio paketas nepriima, yra šio diegimo surišimo klaida — ji atmetama PRIEŠ
    // komandos paleidimą, o ne po to, kai celė jau apmokėta.
    return fail(`benchmark agent invocations nesudėti: ${describe(error)}`);
  }

  try {
    return await loaded.runBenchmarkCommand(
      args,
      { out: (line) => io.out(line), err: (line) => io.error(line) },
      { agentInvocations },
    );
  } catch (error: unknown) {
    // Benchmark CLI savo nesėkmes žymi savais kodais; patekimas čia reiškia, kad jis metė —
    // o tai pagal apibrėžimą harness'o klaida.
    return fail(describe(error));
  }
}
