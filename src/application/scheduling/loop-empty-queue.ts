// Tuščios eilės sprendimas (etalonas: AG_loop orchestrator/loop/loop-empty-queue.ts).
//
// Klausimas: eilė tuščia — ar loop'as baigėsi, ar tiesiog dar nieko nesuplanuota? Atsakymas
// turi tris šakas eilės tvarka: (1) ribotas benchmark'o narvelis, (2) bootstrap ir
// architektūros banga (jos gali PARAŠYTI naujų task'ų), (3) kokybės vartų auditas ir pabaiga.
//
// Modulis GRYNAS: visi efektai ateina portais. Etalone jie buvo default'ai su realiomis
// implementacijomis; čia jų nėra sąmoningai — sprendimas, kuris pats pasiima diską, negali būti
// patikrintas be repo, o būtent jis lemia, ar loop'as sustos.
//
// RT-05 riba perkelta 1:1: šis žingsnis paleidžia TIK `quality-gates` auditą. `converge` čia yra
// ADVISORY — vien LOG signalas. Jos rezultatas nekeičia nei grąžinamos reikšmės, nei
// `dispatchAuditRepair` sąlygų, o pačios patikros klaida virsta įspėjimu, ne lūžiu.

/** Ką loop'as daro po tuščios eilės žingsnio. */
export type EmptyQueueAction = "continue" | "exit";

/** Žymė, kurią benchmark'o harness'as stato loop'ui, varomam kaip vienas ribotas narvelis. */
export const BOUNDED_BENCHMARK_CELL_VARIABLE = "AG_BENCHMARK_BOUNDED_CELL";

/**
 * Ar šis bėgimas yra ribotas benchmark'o narvelis.
 *
 * Parsinimas FAIL-CLOSED link produkcijos: bet kas kita nei `1`/`true` (nenustatyta, tuščia,
 * `0`, `false`, `yes`) palieka įprastą elgesį. Klaidingai įjungta žyma praleistų auditą, tad
 * neapibrėžtumas privalo kristi į normalų kelią, ne į praleidimą.
 */
export function isBoundedBenchmarkCell(env: Readonly<Record<string, string | undefined>>): boolean {
  const token = env[BOUNDED_BENCHMARK_CELL_VARIABLE]?.trim().toLowerCase() ?? "";
  return token === "1" || token === "true";
}

/** Sistemos remonto užduotis, kurią gauna nepavykęs kokybės vartų auditas. */
export const AUDIT_REPAIR_TASK_CONTENT = `# System Repair Task

System task metadata:
- kind: system-repair
- reason: final-quality-audit

## Tikslas
Visos queue užduotys baigtos. Quality gates nepraėjo galutinio audito metu. Pataisyk klaidas.

## Agentas
debugger

## Klaida
Perskaityk: vq/logs/checks-last.log

## Veiksmas
- Rask klaidas iš checks-last.log.
- Pataisyk technines klaidas (TypeScript, lint, testų klaidos).
- Nekeisk produkto logikos ir API.

## Patikra
Paleisk verqestra quality-gates arba komandas iš vq/config/quality-policy.json.

## Stop
Kai patikros praeina arba SKIP yra pagrįstas, įrašyk commit žinutę į vq/logs/commit-msg.md ir sustok.

## Neįtraukta
Architektūros pakeitimai, naujas funkcionalumas, DB migracijos.
`;

/** Bootstrap tinkamumo verdiktas — struktūrinis pjūvis to, ką grąžina detektorius. */
export type EmptyQueueBootstrapDetection = { bootstrapEligible: boolean };

/** Bangos sintezės rezultatas — struktūrinis `ArchitectureWaveResult` pjūvis. */
export type EmptyQueueWaveResult = {
  status: "no-graph" | "synthesized" | "all-done" | "blocked";
  synthesized: number;
  blocked: number;
  done: number;
  total: number;
  already_implemented: number;
  external_satisfied: number;
  no_evidence: number;
};

export type EmptyQueueConvergeResult = { issues: readonly { kind: string }[] };

export type EmptyQueuePorts = {
  detectBootstrapEligibility(projectRoot: string): Promise<EmptyQueueBootstrapDetection>;
  runBootstrap(projectRoot: string, model: string): Promise<{ status: string; render: string }>;
  resolveModel(): Promise<string>;
  synthesizeWave(projectRoot: string): Promise<EmptyQueueWaveResult>;
  /** `quality-gates` exit kodas; 0 = praėjo. */
  runQualityGates(): Promise<number>;
  /** Remonto užduoties išdavimas; META, kai jos išduoti negalima (pvz. jau laukia human-review). */
  dispatchAuditRepair(content: string): Promise<void>;
  runConverge(projectRoot: string): Promise<EmptyQueueConvergeResult>;
  log(message: string): Promise<void>;
  out(message: string): void;
  env: Readonly<Record<string, string | undefined>>;
};

/** Bangos rezultato priedas žurnalui — praleisti mazgai matomi, o ne nutylimi. */
function skippedNote(wave: EmptyQueueWaveResult): string {
  return (
    (wave.already_implemented > 0 ? `, skipped-implemented ${wave.already_implemented}` : "") +
    (wave.external_satisfied > 0 ? `, external ${wave.external_satisfied}` : "")
  );
}

/**
 * Advisory converge signalas.
 *
 * Signalas pirma SUFORMULUOJAMAS, tik paskui rašomas: taip `catch` gaudo TIK pačios patikros
 * klaidą — log'o klaida nebūtų klaidingai pavadinta „converge failed".
 */
function convergeSignal(result: EmptyQueueConvergeResult): string {
  if (result.issues.length === 0) return "CONVERGE CLEAN";
  const countsByKind = new Map<string, number>();
  for (const issue of result.issues) countsByKind.set(issue.kind, (countsByKind.get(issue.kind) ?? 0) + 1);
  // Kind'ai rikiuojami abėcėliškai, kad ta pati būsena visada duotų tą pačią eilutę.
  const breakdown = [...countsByKind.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${count} ${kind}`)
    .join(", ");
  return `CONVERGE DRIFT: ${result.issues.length} issue(s) — ${breakdown}`;
}

export async function handleEmptyQueue(
  ports: EmptyQueuePorts,
  projectRoot: string,
  bootstrapAttempted: boolean,
): Promise<EmptyQueueAction> {
  /**
   * Ribotas benchmark'o narvelis: tuščia eilė čia reiškia „darbas baigtas", o ne „laikas
   * pratęsti". Praleidžiami VISI trys žingsniai, ne tik auditas: ir bootstrap, ir bangos
   * sintezė grąžina `continue` IR rašo task failus į matuojamą checkout'ą, tad narvelis, kuris
   * juos vykdytų, tęstųsi neribotai ir dar užterštų diff'ą, kurį harness'as matuoja. Ši šaka
   * moka TIK išeiti — audito ji nevykdo, tad praleistas auditas niekada nevirsta praėjusiu.
   */
  if (isBoundedBenchmarkCell(ports.env)) {
    await ports.log(
      `QUEUE EMPTY; BOUNDED BENCHMARK CELL (${BOUNDED_BENCHMARK_CELL_VARIABLE}); ` +
        "SKIPPING BOOTSTRAP, ARCHITECTURE WAVE AND QUALITY-GATES AUDIT; EXITING",
    );
    ports.out("Queue empty — bounded benchmark cell: bootstrap, architecture wave and quality-gates audit skipped; exiting\n");
    return "exit";
  }

  // Bootstrap bandomas TIK kartą per bėgimą: antras bandymas tame pačiame rate reikštų ciklą,
  // nes netinkamas projektas kiekvieną kartą duotų tą patį atsakymą.
  if (!bootstrapAttempted) {
    const detection = await ports.detectBootstrapEligibility(projectRoot);
    if (detection.bootstrapEligible) {
      await ports.log("QUEUE EMPTY; BOOTSTRAP ELIGIBLE; RUNNING BOOTSTRAP");
      ports.out("Queue empty — bootstrap eligible; running project bootstrap\n");
      const result = await ports.runBootstrap(projectRoot, await ports.resolveModel());
      await ports.log(`BOOTSTRAP RESULT: ${result.status}`);
      ports.out(`${result.render}\n`);
      return "continue";
    }
  }

  /**
   * Architektūros medžio tęsimas: ištuštėjus eilei baigtų task'ų mazgai jau būna verifikuoti,
   * tad naujai „ready" tapę mazgai čia gauna kitos bangos task'us ir loop'as tęsiasi be
   * operatoriaus rankinio įsikišimo tarp bangų.
   *
   * Idempotentiška ir BAIGTINĖ: sintezė mazgus pažymi `queued`, tad be naujų `done` mazgų antras
   * kvietimas grąžina `blocked`/`all-done` ir loop'as krenta į auditą žemiau.
   */
  const wave = await ports.synthesizeWave(projectRoot);
  const note = skippedNote(wave);
  if (wave.status === "synthesized") {
    await ports.log(
      `QUEUE EMPTY; ARCHITECTURE WAVE SYNTHESIZED: ${wave.synthesized} task(s)${note} (done ${wave.done}/${wave.total})`,
    );
    ports.out(`Queue empty — architecture wave synthesized ${wave.synthesized} task(s)${note}; continuing\n`);
    return "continue";
  }
  if (wave.status === "all-done") {
    await ports.log(`ARCHITECTURE TREE COMPLETE: ${wave.done}/${wave.total} nodes done${note}`);
    ports.out(`Architecture tree complete: ${wave.done}/${wave.total} nodes done${note}\n`);
  } else if (wave.status === "blocked" && wave.total > 0) {
    const noEvidenceNote = wave.no_evidence > 0 ? `, be evidence ${wave.no_evidence} (evidence repair required)` : "";
    await ports.log(
      `ARCHITECTURE WAVE BLOCKED: 0 ready (done ${wave.done}/${wave.total}, blocked ${wave.blocked}${noEvidenceNote}${note}) — žr. repairing/human-review mazgus`,
    );
  }

  await ports.log("QUEUE EMPTY; RUNNING QUALITY-GATES AUDIT");
  ports.out("Queue empty — running quality-gates audit\n");

  const auditCode = await ports.runQualityGates();
  if (auditCode !== 0) {
    await ports.log(`QUALITY-GATES AUDIT FAILED: exit=${auditCode}; dispatching repair task`);
    await ports.dispatchAuditRepair(AUDIT_REPAIR_TASK_CONTENT);
  } else {
    await ports.log("QUALITY-GATES AUDIT PASSED");
  }

  /**
   * Advisory converge signalas. Kokybės vartai mato build/test, bet NE planų ir task failų
   * prasilenkimą, tad tuščia eilė iki šiol atrodydavo švari net tada, kai spec'e suplanuoti
   * task'ai neegzistuoja. Čia tas prasilenkimas tampa matomas — ir TIK matomas.
   */
  let signal: string;
  try {
    signal = convergeSignal(await ports.runConverge(projectRoot));
  } catch (error: unknown) {
    signal = `WARNING: converge advisory check failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    await ports.log(signal);
  } catch {
    // Advisory eilutė nėra vartai: jei nepavyksta net jos įrašyti, tuščios eilės žingsnis vis
    // tiek privalo normaliai baigtis.
  }

  ports.out("Queue empty: AG/tasks/queue\n");
  return "exit";
}
