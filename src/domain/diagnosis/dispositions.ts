// Grynos diagnozės dispozicijų taisyklės — deterministinis "done" greitkelis, no-commit
// dispozicija, lokali diagnozė be LLM, stop įrodymo kilmės vartai (F7), dispatch tapatybės
// atgavimas ir pending/settled siaurinimas. Jokio IO, env ar log skaitymo — skaitytojai
// (E3/E5) paduoda jau surinktus signalus. Behaviour etalon: AG_loop orchestrator/quality/
// deterministic-diagnose.ts (grynoji pusė; WBR VQ-204 — taisyklės keliamos į domain, kad
// VQ-003e fixture gautų namus). Stream-json markerio skaitymas
// (logHasAlreadyImplementedMarker) lieka adapterio pusėje — jis parsina log formatą.

import { matchesAllowedPath } from "../tasks/allowed-paths.js";
import { DISPATCH_TIMEOUT_EXIT_CODE, isInfrastructureExitCode } from "../../shared/exit-codes.js";

// ---------------------------------------------------------------------------
// Stop įrodymo kilmė (task 0042)
// ---------------------------------------------------------------------------
//
// Stop įvykis rašomas į attempt namespace'ą (`<attempt>/stop-state.json`), o globalus
// veidrodis lieka last-writer-wins failu. Tai keičia F7 vartų prasmę:
//
//   - `attempt` kilmė: tapatybę jau ĮRODĖ manifestas — saugykla svetimą attempt'ą grąžina kaip
//     `identity-mismatch` ir nieko neatiduoda, tad perskaitytas artefaktas pagal konstrukciją
//     priklauso ŠIAM task'ui. `task_id` palyginimas čia nieko nebeprideda.
//   - `legacy` kilmė: failas yra vienas visam repo (last-writer-wins), tad F7 vartai LIEKA —
//     svetimu `task_id` pažymėtas įrašas ignoruojamas.
//   - `none`: įrodymo nėra niekur — nėra ko lyginti, tad vartai netaikomi (statusas ir taip
//     `undefined`).
//
// Taisyklė laikoma čia (o ne skaitytojuose), kad ji būtų viena, gryna ir testuojama.

export type StopEvidenceOrigin = "attempt" | "legacy" | "none";

export type StopEvidence = {
  /** `attempt` = manifestu įrodytas šio bandymo artefaktas; `legacy` = globalus veidrodis. */
  origin: StopEvidenceOrigin;
  /** Stop hook'o machine-readable statusas; `undefined`, kai įrodymo nėra. */
  status?: string;
  /** Įraše užfiksuotas task id; `undefined` pre-hardening legacy faile. */
  taskId?: string;
};

export type EffectiveStopStatus = {
  /** Statusas, kuriuo galima remtis; `undefined`, kai įrodymas atmestas kaip svetimas. */
  status: string | undefined;
  /** True tik legacy šakoje, kai `task_id` priklauso kitam task'ui (F7). */
  foreign: boolean;
};

/**
 * F7 vartai, taikomi TIK legacy šakai. Trūkstamas `task_id` (pre-hardening failas) svetimu
 * nelaikomas dėl backward compatibility — lygiai kaip iki šios migracijos.
 */
export function resolveEffectiveStopStatus(evidence: StopEvidence, taskId: string): EffectiveStopStatus {
  if (evidence.origin !== "legacy") {
    return { status: evidence.status, foreign: false };
  }
  const foreign = evidence.taskId !== undefined && evidence.taskId !== taskId;
  return { status: foreign ? undefined : evidence.status, foreign };
}

/**
 * Task 0049: diagnozės procesas yra sibling, kurio env `AG_DISPATCH_NONCE` jau ištrintas
 * (dispatch `finally`; Windows'e jo ten nė nebuvo — nonce gyvena tik launcher skripte),
 * todėl gyvo env nesant tapatybė atgaunama iš stop įrodymo `dispatch_nonce`.
 * Fail-closed pagal kilmę:
 *   - `attempt`: artefakto tapatybę įrodė manifestas, o stop įrašo schema garantuoja ne tuščią
 *     `dispatch_nonce` — nonce patikimas pagal konstrukciją;
 *   - `legacy`: globalus veidrodis yra last-writer-wins, tad nonce imamas TIK kai įrašo
 *     `task_id` tiksliai sutampa su mūsų (trūkstamas ar svetimas task_id = svetima tapatybė —
 *     jos prisiėmimas leistų be įrodymo mesti operatoriaus kelius kaip „įrodytai svetimus");
 *   - kitaip — tuščia tapatybė: nuosavybės filtras lieka no-op, elgesys kaip iki 0049.
 */
export function resolveDispatchSessionNonce(evidence: {
  envNonce: string;
  origin: StopEvidenceOrigin;
  recordNonce: string;
  recordTaskId: string;
  taskId: string;
}): string {
  const envNonce = evidence.envNonce.trim();
  if (envNonce) return envNonce;
  const recordNonce = evidence.recordNonce.trim();
  if (!recordNonce) return "";
  if (evidence.origin === "attempt") return recordNonce;
  if (evidence.origin === "legacy" && evidence.recordTaskId.trim() === evidence.taskId) return recordNonce;
  return "";
}

/**
 * Task 0049 (3): ledger'io kelias, kurio nėra nei dirty git būsenoje, nei task'o lango
 * produkto diff'e (base_head..HEAD), sutampa su HEAD — jis negali būti ŠIO bandymo pending
 * rašymas (tipiškai ankstesnio commit'o / operatoriaus failas) ir nekelia scope pažeidimo.
 * Fail-closed: kai langas nežinomas (`windowKnown=false`, pvz. task-start-status trūksta),
 * siaurinimas NEVYKDOMAS ir rinkinys grąžinamas nepakitęs — scope apsauga nesusilpnėja.
 */
export function pendingAttemptChangedFiles(input: {
  changedFiles: readonly string[];
  dirtyPaths: readonly string[];
  windowProductPaths: readonly string[];
  windowKnown: boolean;
}): { pending: string[]; settled: string[] } {
  if (!input.windowKnown) return { pending: [...input.changedFiles], settled: [] };
  const live = new Set([...input.dirtyPaths, ...input.windowProductPaths].map(normalizePath));
  const pending: string[] = [];
  const settled: string[] = [];
  for (const file of input.changedFiles) {
    (live.has(normalizePath(file)) ? pending : settled).push(file);
  }
  return { pending, settled };
}

export type DeterministicDoneInputs = {
  /** Vykdytojo CLI exit code. */
  claudeExitCode: number;
  /** Stop machine-readable statusas: "done" | "error" | undefined. */
  stopStatus: string | undefined;
  /** True jei stop įrodymas (attempt `stop-state.json` ar legacy veidrodis) neparsinamas. */
  stopStatusCorrupted: boolean;
  /** Quality gates rezultatas; undefined jei nėra. */
  qualityGates: { passed: boolean } | undefined;
  /** Yra naujas commit base_head..HEAD (Stop hook jau užcommitino darbą). */
  hasNewCommitSinceStart: boolean;
  /** Vykdytojo log'e yra ALREADY_IMPLEMENTED markeris (darbas jau buvo padarytas). */
  alreadyImplementedMarker: boolean;
  /** Non-runtime (produkto) neištrackintų/pakeistų failų skaičius darbiniame medyje. */
  nonRuntimeDirtyCount: number;
};

export type DeterministicDoneResult = {
  /** True = saugu žymėti done be LLM diagnose; False = kreiptis į LLM. */
  fastPath: boolean;
  /** Trumpas paaiškinimas (telemetrijai/log'ui). */
  reason: string;
};

// "split" pridėtas task 066-a-02: kartojantis runtime-oversize signalas (žr.
// `evaluateRuntimeOversizeDisposition` žemiau) grąžina verdiktą iš tos pačios aibės, kad
// dispatch/coordinator skaitytojai galėtų jį priimti be atskiro tipo. `evaluateLocalDiagnosis`
// pati "split" negrąžina — praplėtimas yra tik tipo lygmens paruošimas maršruto sujungimui.
export type LocalDiagnosisVerdict = "done" | "repair" | "human-review" | "split";

export type LocalResultSignals = {
  taskId: string;
  checksPassed?: boolean;
  exitCode?: number;
  stopStatus?: string;
  changedFiles: string[];
  allowedPaths: string[];
  stderr?: string;
  stdout?: string;
};

export type LocalDiagnosisResult = {
  verdict: LocalDiagnosisVerdict;
  reason: string;
  requiresModel: boolean;
};

/**
 * Deterministinis diagnose "done" greitkelis. Grąžina fastPath=true tik kai VISI
 * sėkmės signalai galioja — tada diagnozė gali parašyti verdict=done be LLM iškvietimo.
 * Konservatyvus pagal dizainą: bet koks abejotinas signalas grąžina fastPath=false ir
 * kreipiamasi į LLM (būtent ten LLM uždirba savo kaštą).
 *
 * Saugiklis: net jei šis greitkelis suklystų, workflow `done` handleris vis tiek
 * pertikrina gates/stop/commit, todėl klaidingas done negali būti galutinai uždarytas.
 */
export function evaluateDeterministicDone(inputs: DeterministicDoneInputs): DeterministicDoneResult {
  const no = (reason: string): DeterministicDoneResult => ({ fastPath: false, reason });

  if (inputs.claudeExitCode !== 0) {
    return no(`claude exit ${inputs.claudeExitCode} != 0`);
  }
  if (inputs.stopStatusCorrupted) {
    return no("stop status evidence corrupted");
  }
  if (inputs.stopStatus !== "done") {
    return no(`stop status '${inputs.stopStatus ?? "<missing>"}' != done`);
  }
  if (!inputs.qualityGates) {
    return no("quality-gates-status.json missing");
  }
  if (!inputs.qualityGates.passed) {
    return no("quality gates failed");
  }
  if (inputs.nonRuntimeDirtyCount > 0) {
    return no(`${inputs.nonRuntimeDirtyCount} uncommitted product file(s)`);
  }
  if (!inputs.hasNewCommitSinceStart && !inputs.alreadyImplementedMarker) {
    return no("no new commit and no ALREADY_IMPLEMENTED marker");
  }

  const evidence = inputs.hasNewCommitSinceStart ? "new commit present" : "ALREADY_IMPLEMENTED marker";
  return { fastPath: true, reason: `gates passed, stop done, ${evidence}` };
}

/**
 * Vykdytojo rašymo-įrankio aktyvumas per bandymą. `"unknown"` reiškia, kad sesijos log'as
 * neskaitytas ar neatpažintas — tyli sesija NĖRA įrodymas, kad rašymų nebuvo (task 032).
 */
export type ExecutorWriteActivity = "wrote" | "no-writes" | "unknown";

export type NoCommitDoneInputs = {
  /** Vykdytojo log'as turi eilutę, prasidedančią ALREADY_IMPLEMENTED. */
  hasAlreadyImplementedMarker: boolean;
  /** Ne-runtime (produkto) dirty git įrašų skaičius darbiniame medyje. */
  productDirtyCount: number;
  /**
   * Darbo įrodymas istorijoje: šio task'o deliverable yra užcommitintas (task'o commit'as
   * git log'e arba deliverable patikra). Task 890: be įrodymo švarus medis negali uždaryti
   * task'o kaip "done", nes po task-scoped rollback (ar svetimo reset) medis būna švarus
   * BE jokio realiai atlikto darbo — toks task'as turi keliauti į human-review, ne done.
   */
  hasWorkEvidence: boolean;
  /**
   * Skaitytojo (E3/E5) paduotas vykdytojo rašymo aktyvumas. Neprivalomas, kad esami
   * kvietėjai liktų kompiliuojami; default `"unknown"`. Iki task 060 naudojo tik
   * `resolveNoCommitReviewReason`; nuo task 060 `resolveNoCommitDisposition` jį taip pat
   * skaito, bet TIK siauroje `hasAlreadyImplementedMarker && !hasWorkEvidence` šakoje —
   * žr. komentarą ten.
   */
  writeActivity?: ExecutorWriteActivity;
  /**
   * Task 095: vykdytojo log'as turi eilutę, prasidedančią `AUDIT_COMPLETE` — auditas ĮVYKDYTAS
   * ir taisytinų radinių nerado. Neprivalomas, kad esami kvietėjai liktų kompiliuojami;
   * nepaduotas laukas reiškia „markerio nėra" ir visų esamų šakų elgesio nekeičia.
   * Kanoninė atpažinimo vieta — `stream-log.ts#logHasAuditCompleteMarker`.
   */
  hasAuditCompleteMarker?: boolean;
};

export type NoCommitDisposition = "done" | "rollback" | "human-review";

/**
 * "done" diagnozė galioja (gates žali, stop != error), bet naujo commit'o nėra.
 * Nusprendžia, ar tai "jau įgyvendinta" (uždaryti done), "vykdytojas neužcommitino darbo"
 * (rollback) ar "švarus medis be darbo įrodymo" (human-review).
 *
 * done kai:
 *   - yra AUDIT_COMPLETE markeris IR skaitytojas PATVIRTINO nulinį rašymo aktyvumą
 *     (`writeActivity === "no-writes"`) IR medis švarus nuo produkto pakeitimų (task 095), ARBA
 *   - yra ALREADY_IMPLEMENTED markeris IR darbo įrodymas istorijoje, ARBA
 *   - yra ALREADY_IMPLEMENTED markeris IR darbo įrodymo istorijoje NĖRA, bet skaitytojas
 *     PATVIRTINO nulinį rašymo aktyvumą (`writeActivity === "no-writes"`) IR medis švarus
 *     nuo produkto pakeitimų (task 060 — žr. žemiau), ARBA
 *   - working tree švarus nuo PRODUKTO pakeitimų (productDirtyCount === 0) IR yra darbo
 *     įrodymas istorijoje (`hasWorkEvidence`) — deliverable jau užcommitintas ankstesnio
 *     bandymo, tad naujo commit'o nėra ko kurti.
 *
 * rollback kai produkto dirty įrašų yra be markerio: vykdytojas atliko darbą, bet
 * neužcommitino — to prarasti negalima, todėl griežtoji šaka išlieka.
 *
 * human-review kai medis švarus, markerio nėra IR darbo įrodymo nėra: task'o darbas dingo
 * (pvz. po rollback), todėl tylus "done" be deliverable draudžiamas (task 890 regresija
 * 884–893).
 */
export function resolveNoCommitDisposition(inputs: NoCommitDoneInputs): NoCommitDisposition {
  // Task 095: sėkmingas auditas be radinių yra baigtis, kurios nė vienas iki šiol buvęs kelias
  // neaprašė. Commit'o nėra, nes taisyti nebuvo ko; `hasWorkEvidence` nėra, nes read-only
  // auditas neturi git deliverable; ALREADY_IMPLEMENTED čia yra SEMANTIŠKAI ne tas žodis —
  // task'as nebuvo „jau įgyvendintas", jis buvo įvykdytas ir jo deliverable yra ataskaita.
  //
  // Šaka tokia pat siaura ir su tokiu pat DVIGUBU įrodymu kaip task 060 išimtis žemiau:
  // (1) vykdytojo žodis (AUDIT_COMPLETE markeris) IR (2) NEPRIKLAUSOMAS skaitytojo signalas,
  // kad rašymų tikrai nebuvo (`writeActivity === "no-writes"` — `"unknown"` NĖRA įrodymas, žr.
  // `ExecutorWriteActivity`) IR (3) švarus produkto medis: dirty įrašai prieštarauja „nulis
  // rašymų" tvirtinimui, tad auditas, kuris ką nors paliko medyje, čia neįeina. Trūkstant bet
  // kurio įrodymo, elgesys lieka lygiai toks, koks buvo iki 095.
  if (inputs.hasAuditCompleteMarker === true && inputs.writeActivity === "no-writes" && inputs.productDirtyCount === 0) {
    return "done";
  }
  // 2026-08-14 false-done epidemija (0000-1 07:47, 0000-loop 08:03 — abu be jokio Edit/Write):
  // ALREADY_IMPLEMENTED markeris yra VYKDYTOJO ŽODIS, ne įrodymas — sesijos jį spausdina
  // per lengvai (Žingsnio 0 tekstas neverčia pateikti patikrinamų nuorodų). Žodis be darbo
  // įrodymo istorijoje (`hasWorkEvidence` — task'o commit'as su produkto keliais) nebeuždaro
  // task'o: jis keliauja į human-review, kur operatorius patvirtina per task-move į done.
  // Tikrai anksčiau įgyvendintiems task'ams evidence egzistuoja, tad jų kaštas nepakinta.
  if (inputs.hasAlreadyImplementedMarker) {
    if (inputs.hasWorkEvidence) return "done";
    // Task 060: 054-b-03 ir 057-a-02 (2026-08-28) buvo parkuoti į human-review su priežastimi
    // "executor made no write-tool calls", nors Žingsnis 0 sąžiningai nustatė
    // ALREADY_IMPLEMENTED — read-only sesija PAGAL APIBRĖŽIMĄ neturi git deliverable, tad
    // `hasWorkEvidence` čia visada bus false ir epidemijos vartai (aukščiau) tai klaidingai
    // laikė svetimu atsukimu. Išimtis siaura ir reikalauja DVIGUBO įrodymo: (1) vykdytojo
    // žodis (markeris) IR (2) NEPRIKLAUSOMAS skaitytojo signalas, kad rašymų tikrai nebuvo
    // (`writeActivity === "no-writes"`, task 032 — tikslesnis nei tylos prielaida). Produkto
    // dirty įrašai (nesuderinami su "nulis rašymų") tebedengiami: jei jų yra, lieka
    // human-review, ne tylus "done".
    if (inputs.writeActivity === "no-writes" && inputs.productDirtyCount === 0) return "done";
    return "human-review";
  }
  if (inputs.productDirtyCount > 0) return "rollback";
  return inputs.hasWorkEvidence ? "done" : "human-review";
}

/**
 * Task 032: human-review priežasties eilutė iš tų pačių įėjimų kaip `resolveNoCommitDisposition`.
 * Iki šiol „vykdytojas nieko nerašė" ir „darbas atsuktas" abu virsdavo ta pačia priežastimi
 * (clean tree without work evidence), tad operatorius buvo siunčiamas ieškoti darbo, kurio
 * nebuvo. `"no-writes"` — patikimas skaitytojo signalas, kad rašymo-įrankio kvietimų nebuvo —
 * gauna savo, tikslesnę priežastį. `"unknown"` NIEKADA negamina naujos priežasties: tyli ar
 * neatpažinta sesija nėra įrodymas, kad rašymų nebuvo, tad grąžinama esama priežastis.
 *
 * Task 095: kai yra AUDIT_COMPLETE markeris, bet nulinis rašymo aktyvumas NEPATVIRTINTAS,
 * dispozicija lieka human-review — ir operatoriui reikia žinoti, KURIO iš dviejų įrodymų
 * trūksta. Bendra „clean tree without work evidence" eilutė čia siųstų ieškoti dingusio
 * deliverable, nors auditas deliverable ir neturi: trūksta būtent skaitytojo signalo.
 */
export function resolveNoCommitReviewReason(inputs: NoCommitDoneInputs): string {
  if (inputs.writeActivity === "no-writes") {
    return "executor made no write-tool calls";
  }
  if (inputs.hasAuditCompleteMarker === true) {
    return "AUDIT_COMPLETE marker without confirmed zero-write evidence";
  }
  return "clean tree without work evidence (deliverable missing — possibly rolled back)";
}

/**
 * Task 066-a-02 (GeoGravity 1178): pasikartojantis dispatch timeout (exit 124) su ta pačia
 * retry-signature anksčiau vedė į `human-review` arba dar vieną retry — trys ciklai po ~100 min
 * be pažangos. `"split"` yra atskiras nuo `LocalDiagnosisVerdict.human-review` fallback'as: kai
 * runtime-oversize signalas KARTOJASI (>=2 bandymai su ta pačia signature) IR task'as dalomas
 * (daugiau nei vienas veiksmas/kelias), sprendimas yra skaidyti į mažesnius task'us, ne stabdyti
 * ciklą. `human-review` lieka TIK tada, kai task'as nedalomas (1 veiksmas, 1 kelias) — jo
 * skaidyti nėra kaip.
 *
 * Papildymas (operatorius, 2026-08-29, GeoGravity auditas): RAW token lubų perviršis
 * (`tool-budget-rules.ts#rawTokenNotice`, iki šiol grynai diagnostinis — "diagnostika, baigtis
 * nekeičiama") yra TAS PATS runtime-oversize signalas kaip timeout parašas: GeoGravity 7
 * dispatch'ai viršijo 10M raw lubas (iki 25.5M), o 1178 @ 2.5× baigėsi exit 124. Lubų reikšmė
 * (`rawTokenCeiling`) nekeičiama — čia tik sprendimas, ką daryti, kai duotos lubos jau viršytos
 * daugiau nei 1.2×.
 */
export type RuntimeOversizeVerdict = "split" | "human-review" | "repair";

export type RuntimeOversizeDispositionInputs = {
  /** Vykdytojo CLI exit code šiam bandymui. */
  exitCode: number;
  /** Kiek IŠ EILĖS bandymų (įskaitant šį), baigėsi TUO PAČIU runtime-oversize parašu. */
  repeatedSignatureAttempts: number;
  /** True, jei task'as turi daugiau nei vieną veiksmą/kelią — gali būti skeliamas. */
  isDivisible: boolean;
  /** Faktinis raw token sunaudojimas šiam bandymui; undefined, jei diagnozė jo neturi. */
  rawTokensUsed?: number;
  /** Konfigūruota raw token lubų reikšmė (nekeičiama); undefined, jei diagnozė jos neturi. */
  rawTokenCeiling?: number;
};

/** Kiek kartų raw sunaudojimas gali viršyti lubas, kol tai vis dar tik diagnostika, ne signalas. */
const RAW_TOKEN_OVERRUN_MULTIPLIER = 1.2;

function isRawTokenCeilingOverrun(rawTokensUsed: number | undefined, rawTokenCeiling: number | undefined): boolean {
  if (rawTokensUsed === undefined || rawTokenCeiling === undefined || rawTokenCeiling <= 0) return false;
  return rawTokensUsed > rawTokenCeiling * RAW_TOKEN_OVERRUN_MULTIPLIER;
}

export function evaluateRuntimeOversizeDisposition(inputs: RuntimeOversizeDispositionInputs): RuntimeOversizeVerdict {
  const isRuntimeOversizeSignal =
    inputs.exitCode === DISPATCH_TIMEOUT_EXIT_CODE ||
    isRawTokenCeilingOverrun(inputs.rawTokensUsed, inputs.rawTokenCeiling);
  if (!isRuntimeOversizeSignal || inputs.repeatedSignatureAttempts < 2) {
    return "repair";
  }
  return inputs.isDivisible ? "split" : "human-review";
}

export function evaluateLocalDiagnosis(signals: LocalResultSignals): LocalDiagnosisResult {
  if (signals.allowedPaths.length === 0) {
    // Read-only / "jau įgyvendinta" task'as (pvz. preflight perreformulavo į "Tik
    // skaitymui" patikrą) neturi Leidžiama kelių. Jei nieko nepakeista IR patikros
    // praėjo — tai done (ALREADY_IMPLEMENTED), ne human-review. Jei pakeitimų yra,
    // bet allowed paths nėra — vis tiek human-review (scope nepatikrinamas).
    if (signals.changedFiles.length === 0 && signals.checksPassed === true) {
      return {
        verdict: "done",
        reason: "no changes and checks passed (read-only/already implemented)",
        requiresModel: false,
      };
    }
    return { verdict: "human-review", reason: "allowed paths missing", requiresModel: false };
  }

  const outsideAllowed = signals.changedFiles.filter((file) => !isPathAllowed(file, signals.allowedPaths));
  if (outsideAllowed.length > 0) {
    return {
      verdict: "human-review",
      reason: `changed files outside allowed paths: ${outsideAllowed.join(", ")}`,
      requiresModel: false,
    };
  }

  if (signals.checksPassed === true && (signals.exitCode === undefined || signals.exitCode === 0)) {
    return { verdict: "done", reason: "checks passed and changed files are inside allowed paths", requiresModel: false };
  }

  if (signals.checksPassed === false || (signals.exitCode !== undefined && signals.exitCode !== 0)) {
    const output = `${signals.stderr ?? ""}\n${signals.stdout ?? ""}`;
    if (isClearLocalIssue(output) || signals.checksPassed === false) {
      return { verdict: "repair", reason: localIssueReason(output), requiresModel: false };
    }
  }

  if (signals.stopStatus && signals.stopStatus !== "done" && signals.stopStatus !== "error") {
    return { verdict: "human-review", reason: `unknown stop status '${signals.stopStatus}'`, requiresModel: false };
  }

  return { verdict: "human-review", reason: "local signals are ambiguous", requiresModel: false };
}

function isClearLocalIssue(output: string): boolean {
  if (/\b(error TS\d+|AssertionError|ERR_ASSERTION|SyntaxError|TypeError|ReferenceError|lint|test failed|build failed)/i.test(output)) {
    return true;
  }
  // `exit_code: N` eilutė yra „aiški lokali klaida" TIK kai kodas nėra infrastruktūrinis:
  // timeout 124 / stale dist 78 / usage 75 ir kt. yra aplinkos verdiktai, ir jų pavertimas
  // repair signature („clear local issue: exit_code: 124") sukdavo repair ciklus be jokio
  // raudono testo bei nuodydavo retry-counts globalų parašų skaitliuką (GeoGravity 1178).
  for (const match of output.matchAll(/\bexit_code:\s*(\d+)/gi)) {
    const code = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(code) && code !== 0 && !isInfrastructureExitCode(code)) return true;
  }
  return false;
}

function localIssueReason(output: string): string {
  const firstSignal = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => isClearLocalIssue(line));
  return firstSignal ? `clear local issue: ${firstSignal.slice(0, 160)}` : "checks failed";
}

// Glob semantika — kanoninis `domain/tasks/allowed-paths.ts#matchesAllowedPath` (FQC-12):
// „ar kelias telpa į scope" privalo reikšti tą patį diagnozėje ir integracijoje.
function isPathAllowed(filePath: string, allowedPaths: string[]): boolean {
  const file = normalizePath(filePath);
  return allowedPaths.some((allowed) => matchesAllowedPath(file, normalizePath(allowed)));
}

// NE `shared/paths.toComparablePosixPath` (task 0064): backtick'ai kerpami PRIEŠ `trim` (markdown
// iš log'ų), tad `` "`a` " `` čia duoda `` "a`" ``, o bendras helper'is duotų `"a"`.
function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^`|`$/g, "").trim();
}
