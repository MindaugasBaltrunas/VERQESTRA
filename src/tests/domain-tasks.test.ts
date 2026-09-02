// VQ-201: domain/tasks kontraktų testai — buckets, identity, dependencies, allowed-paths,
// retry, dispatch-paths. Elgesio atvejai perkelti iš AG_loop atitinkamų unit suite'ų.
import assert from "node:assert/strict";
import test from "node:test";
import { isTaskBucket, isTerminalBucket, normalizeTerminalBucket, taskBuckets } from "../domain/tasks/buckets.js";
import {
  extractTaskGoal,
  hasLeadingTaskHeading,
  identifyTask,
  isSupersededStub,
  recognizeTask,
  splitChildParentStem,
  splitChildParentStemCandidates,
  taskFileStem,
  taskLedgerKey,
  taskNumberFromFilename,
  taskSlug,
  taskSlugCandidates,
} from "../domain/tasks/identity.js";
import {
  DEPENDENCY_PLACEHOLDERS,
  dependencyMatches,
  isPlaceholderDependency,
  normalizeTaskReference,
  parseTaskDependencies,
  withBlockedNotice,
} from "../domain/tasks/dependencies.js";
import { allowedPaths, forbiddenPaths, isScopeMarkerLine, parseAllowedPaths } from "../domain/tasks/allowed-paths.js";
import {
  DEFAULT_MAX_RETRY_ATTEMPTS,
  evaluateRepeatedErrorEscalation,
  evaluateRetryLimit,
  isValidRetryCount,
  normalizeErrorSignature,
  normalizeMaxRetryAttempts,
} from "../domain/tasks/retry.js";
import { dispatchTaskPrefixes, resolveDispatchTaskFile } from "../domain/tasks/dispatch-paths.js";

test("buckets: lifecycle set, narrowing and terminal escalation", () => {
  assert.equal(taskBuckets.length, 7);
  assert.ok(isTaskBucket("queue"));
  assert.ok(!isTaskBucket("queue2"));
  assert.ok(isTerminalBucket("done"));
  assert.ok(!isTerminalBucket("failed"), "failed is NOT a resting bucket — it escalates");
  assert.equal(normalizeTerminalBucket("failed"), "human-review");
  assert.equal(normalizeTerminalBucket("done"), "done");
});

test("identity: stem/number/goal/superseded rules and the unified ledger key", () => {
  assert.equal(taskFileStem("AG/tasks/queue/0049-diagnose.md"), "0049-diagnose");
  assert.equal(taskFileStem("C:\\repo\\AG\\tasks\\queue\\0049-diagnose.md"), "0049-diagnose");
  assert.equal(taskNumberFromFilename("0049-diagnose.md"), 49);
  assert.equal(taskNumberFromFilename("README.md"), undefined);
  assert.equal(taskLedgerKey("AG\\tasks\\queue\\0049 keista(!).md"), "0049-keista---");
  assert.equal(taskLedgerKey("a/b/0001-x.md"), "0001-x");
  assert.equal(splitChildParentStem("916-gaps-02-rt-07-auto.md"), "916-gaps-02-rt");
  assert.deepEqual(splitChildParentStemCandidates("916-gaps-02-rt-07-auto.md"), ["916-gaps-02-rt", "916-gaps"]);
  const task = "# Task\n\n## Tikslas\nVienas   tikslas\nper dvi eilutes.\n\n## Stop\ns";
  // Etalono semantika: GOAL šablono lazy match su `m` vėliava sustoja PIRMOS eilutės
  // gale ($ multiline), tad goal = pirmoji eilutė su sutrauktais tarpais.
  assert.equal(extractTaskGoal(task), "Vienas tikslas");
  assert.ok(hasLeadingTaskHeading(task));
  assert.ok(recognizeTask(task));
  const stub = "# Superseded\n\nperkeltas.\n\n# Task\n\n## Tikslas\nT";
  assert.ok(isSupersededStub(stub));
  assert.ok(!hasLeadingTaskHeading(stub), "leading heading rule must ignore the demoted # Task");
  assert.deepEqual(identifyTask("0002-x.md", task), { number: 2, goal: "Vienas tikslas" });
  // Iki 2026-08-24 čia stovėjo `sukurti-nauj-modul`: `ą` ir `į` NEBUVO pakeistos, o IŠKRISDAVO,
  // ir žodis nustodavo būti žodžiu. Transliteracija juos išsaugo, o vardas lieka ASCII.
  assert.equal(taskSlug("Sukurti Naują! Modulį"), "sukurti-nauja-moduli");
  assert.equal(taskSlug("Įvardyti sąrašą"), "ivardyti-sarasa");
  assert.equal(taskSlug("Žingsnis su ūkiu ir šešėliu"), "zingsnis-su-ukiu-ir-seseliu");
  // ASCII pavadinimas nepasikeičia — sena ir nauja taisyklė jam sutampa, tad kandidatas VIENAS.
  assert.deepEqual(taskSlugCandidates("Plain ASCII title"), ["plain-ascii-title"]);
  // Lietuviškam — DU: naujas kūrimui, senasis jau esantiems failams atpažinti. Senoji reikšmė
  // `vardyti-s-ra` čia stovi kaip įrodymas, kaip toli nueidavo praradimas: iš „sąrašą" likdavo
  // „s-ra".
  assert.deepEqual(taskSlugCandidates("Įvardyti sąrašą"), ["ivardyti-sarasa", "vardyti-s-ra"]);
});

test("dependencies: kv/bullet/inline parsing, PDAG-2 placeholders, notice idempotence", () => {
  const text = [
    "# Task",
    "",
    "## Dependencies",
    "- depends_on: 0045-write-side, 0021",
    "- none",
    "- 0033-kitas.md",
    "",
    "## Veiksmas",
    "blocked_by: AG/tasks/queue/0011-inline.md",
  ].join("\n");
  const meta = parseTaskDependencies(text, "AG/tasks/queue/0046-join.md");
  assert.equal(meta.task_id, "0046-join");
  assert.equal(meta.file, "AG/tasks/queue/0046-join.md");
  assert.deepEqual(meta.blocked_by, ["0011-inline", "0021", "0033-kitas", "0045-write-side"]);
  assert.ok(isPlaceholderDependency("TBD"));
  assert.ok(isPlaceholderDependency("n/a".replace("/", "-")));
  assert.ok(DEPENDENCY_PLACEHOLDERS.has("none"));
  assert.equal(normalizeTaskReference("'AG/tasks/queue/0042 x.md'"), "0042-x");
  assert.ok(dependencyMatches("0042-full-name", "0042"));
  const withNotice = withBlockedNotice("# Task\n", "0001-blocker");
  assert.match(withNotice, /## Human review block/);
  assert.equal(withBlockedNotice(withNotice, "0002-else"), withNotice, "notice must be idempotent");
});

test("allowed-paths: structured errors, backtick priority, bare tokens, marker lines", () => {
  const canonical = "# Task\n\n## Failai\nLeidžiama:\n- `src/a.ts`\n- `src/b/**`\nDraudžiama:\n- `.env*`\n";
  assert.deepEqual(allowedPaths(canonical), ["src/a.ts", "src/b/**"]);
  assert.deepEqual(forbiddenPaths(canonical), [".env*"]);
  assert.ok(isScopeMarkerLine("Leidžiama:"));
  assert.ok(isScopeMarkerLine("Draudziama:"));
  assert.ok(!isScopeMarkerLine("Leidžiama: src/a.ts"));
  const missing = parseAllowedPaths("# Task\n\n## Tikslas\nT");
  assert.ok(!missing.ok && missing.error.code === "missing_failai_section");
  const empty = parseAllowedPaths("# Task\n\n## Failai\nLeidžiama:\n(nieko)\n");
  assert.ok(!empty.ok && empty.error.code === "empty_allowed_block");
  const inline = parseAllowedPaths("# Task\n\n## Failai\nLeidžiama: src/a.ts, src/b/**\n");
  assert.ok(inline.ok);
  assert.deepEqual(inline.ok ? inline.value : [], ["src/a.ts", "src/b/**"]);
});

test("allowed-paths: bullet eilutėje kelias yra TIK pirmas backtick tokenas", () => {
  // Etalono `## Failai` bullet'as dažnai turi pagrindimo tekstą su savo backtick'ais
  // (kodo identifikatoriai, `..` traversal minėjimas). Tie antriniai backtick'ai NĖRA
  // papildomi keliai — antraip pagrindimo `..` tampa „keliu" ir scope lock'as jį atmeta.
  const withJustification =
    "# Task\n\n## Failai\nLeidžiama:\n- `src/a/` — `..` traversal regresijos\n" +
    "- `src/ui/x.ts` — naujas: `Foo` + `bar`\nDraudžiama:\n- `.env*` — niekada `secret.key`\n";
  assert.deepEqual(allowedPaths(withJustification), ["src/a/", "src/ui/x.ts"]);
  assert.deepEqual(forbiddenPaths(withJustification), [".env*"]);

  // Sąmoningas pokytis: du keliai VIENAME bullet'e (du backtick tokenai be pagrindimo teksto
  // tarp jų) — etalonas reikalauja vieno kelio bullet'ui, tad imamas tik pirmas.
  const twoPathsOneBullet = "# Task\n\n## Failai\nLeidžiama:\n- `a.ts`, `b.ts`\n";
  assert.deepEqual(allowedPaths(twoPathsOneBullet), ["a.ts"]);

  // Inline forma (be bullet'o) ir bullet be backtick'ų (bare token fallback) — nepakitę.
  const inlineMultiBacktick = "# Task\n\n## Failai\nLeidžiama: `src/a.ts` `src/b.ts`\n";
  assert.deepEqual(allowedPaths(inlineMultiBacktick), ["src/a.ts", "src/b.ts"]);
  const bareBullet = "# Task\n\n## Failai\nLeidžiama:\n- src/plain.ts\n";
  assert.deepEqual(allowedPaths(bareBullet), ["src/plain.ts"]);
});

test("allowed-paths: laužytas bullet'as (tęstinė įtraukta eilutė) yra VIENAS loginis įrašas", () => {
  // Etalono bullet'as dažnai laužomas per kelias eilutes, o pagrindimas tęstinėje eilutėje
  // turi savo backtick'us (pvz. eksporto pavadinimą). Tęstinė eilutė NETURI bullet žymeklio,
  // tad be sulankstymo patenka į ne-bullet šaką ir jos backtick'ai klaidingai virsta keliais.
  const brokenAllow =
    "# Task\n\n## Failai\nLeidžiama:\n- `src/config.ts` — naudoja\n" +
    "  `MIN_ARCHITECTURE_TOKEN_LENGTH` eksportą\n" +
    "Draudžiama:\n- `dist/**` — niekada\n  keisti `generated/index.ts`\n";
  assert.deepEqual(allowedPaths(brokenAllow), ["src/config.ts"]);
  assert.deepEqual(forbiddenPaths(brokenAllow), ["dist/**"]);

  // Tuščia eilutė nutraukia įrašą — po jos einanti įtraukta eilutė NETĘSIA ankstesnio bullet'o.
  const blankBreaksEntry =
    "# Task\n\n## Failai\nLeidžiama:\n- `src/a.ts` — pagrindimas\n\n  `src/b.ts` klaidingai laisva\n";
  assert.deepEqual(allowedPaths(blankBreaksEntry), ["src/a.ts", "src/b.ts"]);

  // Esama inline ne-bullet forma (107-143 eil.) lieka nepakitusi po sulankstymo pridėjimo.
  const inline = parseAllowedPaths("# Task\n\n## Failai\nLeidžiama: src/a.ts, src/b/**\n");
  assert.ok(inline.ok);
  assert.deepEqual(inline.ok ? inline.value : [], ["src/a.ts", "src/b/**"]);
});

test("isValidRetryCount: tik NENEIGIAMAS SAUGUS SVEIKASIS yra skaitiklio būsena", () => {
  assert.equal(isValidRetryCount(0), true);
  assert.equal(isValidRetryCount(3), true);
  assert.equal(isValidRetryCount(Number.MAX_SAFE_INTEGER), true);

  // Visos šios formos yra baigtinės — būtent todėl `Number.isFinite` jų nematė (2026-08-24).
  assert.equal(isValidRetryCount(-5), false, "neigiamas skaitiklis atstato išnaudotą biudžetą");
  assert.equal(isValidRetryCount(1.5), false, "trupmena nėra bandymų skaičius");
  assert.equal(isValidRetryCount(1e300), false, "virš MAX_SAFE_INTEGER `x + 1 === x` — kilpa begalinė");
  assert.equal(isValidRetryCount(Number.MAX_SAFE_INTEGER + 1), false);

  assert.equal(isValidRetryCount("3"), false, "`\"3\" + 1 === \"31\"`");
  assert.equal(isValidRetryCount(null), false);
  assert.equal(isValidRetryCount(undefined), false);
  assert.equal(isValidRetryCount(Number.NaN), false);
  assert.equal(isValidRetryCount(Number.POSITIVE_INFINITY), false);
});

test("retry: max-1 dispatch budget semantics and repeated-signature escalation", () => {
  assert.equal(DEFAULT_MAX_RETRY_ATTEMPTS, 3);
  assert.equal(normalizeMaxRetryAttempts("5"), 5);
  assert.equal(normalizeMaxRetryAttempts(-1), 3);
  const atLimit = evaluateRetryLimit(3, 3);
  assert.deepEqual(atLimit, { reached: true, count: 3, max: 3, remaining: 0 });
  assert.equal(evaluateRetryLimit(2, 3).reached, false, "a task gets at most max-1 repair dispatches");
  const signature = normalizeErrorSignature("Error at src/x.ts:42:7 took 15ms LINE 9");
  assert.equal(signature, "error at src/x.ts:<loc> took <duration> line <n>");
  assert.ok(evaluateRepeatedErrorEscalation("E at a.ts:1:2", "E at a.ts:9:9").escalate);
  assert.ok(!evaluateRepeatedErrorEscalation("E kita", "E ana").escalate);
  assert.ok(!evaluateRepeatedErrorEscalation("E", undefined).escalate);
});

test("dispatch-paths: prefixes derive from buckets minus terminal rest states", () => {
  assert.deepEqual(dispatchTaskPrefixes, [
    "AG/tasks/queue",
    "AG/tasks/active",
    "AG/tasks/delegated",
    "AG/tasks/error",
    "AG/tasks/human-review",
  ]);
  const root = process.cwd();
  const resolved = resolveDispatchTaskFile(root, "AG/tasks/queue/0001-x.md");
  assert.ok(resolved.endsWith("0001-x.md"));
  assert.throws(() => resolveDispatchTaskFile(root, "AG/tasks/done/0001-x.md"), /must be inside/);
  assert.throws(() => resolveDispatchTaskFile(root, "AG/tasks/queue/0001-x.txt"), /must be a \.md file/);
});
