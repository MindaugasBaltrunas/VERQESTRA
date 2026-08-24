// Patikimumo analitikos atsakymas (`GET /api/reliability-analytics`). Elgesio etalonas:
// AG_loop orchestrator/learning/reliability-analytics.ts (kompozicijos pusė). VERQESTRA
// skirtumai: git/session įvestis paduodama per ReliabilityPorts (žalias tekstas/duomenys —
// adapterio E4/E5 darbas), žurnalai skaitomi per LearningFsPort tolerantiškais parseriais.
// Visas kelias tolerant: sugadinti duomenys degraduoja skaičius, o ne nuverčia atsakymą.

import path from "node:path";
import { aggregateFileActivity, dateKey, parseGitNumstat, summarizeFileChanges, type FileActivityBucket } from "./file-activity.js";
import { buildFailureAnalytics, type FailureAnalytics } from "./failure-analytics.js";
import { parseJsonlObjects, parseTolerantUsageRecords, selectLearningTaskEvents } from "./usage-view.js";
import type { LearningFsPort } from "./ports.js";

export type SessionFileKind = "created" | "modified" | "deleted" | "unknown";

/**
 * Kompozicijos įvestys, kurių application sluoksnis pats pasiimti negali:
 * git istorija/būsena ir sesijos rašymo evidencija (AG runtime artefaktai).
 */
export type ReliabilityPorts = {
  fs: LearningFsPort;
  /** `git log --since=<d>.days --date=iso-strict --pretty=format:@@%H|%aI|%s --name-status --no-merges` output'as; `undefined` — git neprieinamas. */
  gitLog(sinceDays: number): Promise<string | undefined>;
  /** `git status --porcelain --untracked-files=all` output'as; `undefined` — git neprieinamas. */
  gitStatusPorcelain(): Promise<string | undefined>;
  /** Sesijos rašymo ledger'is (session-writes); trūkstamas/sugadintas — tuščias sąrašas. */
  sessionWrites(): Promise<string[]>;
  /** Write-time įvykių žurnalo kind'ai per failą; tuščias Map — žurnalo nėra (legacy kelias). */
  sessionFileKinds(): Promise<Map<string, SessionFileKind>>;
};

export type ReliabilityAnalyticsResponse = {
  generatedAt: string;
  coverage: {
    gitSinceDays: number;
    gitAvailable: boolean;
    taskEvents: number;
    tokenRecords: number;
    limitations: string[];
  };
  files: {
    session: { touched: number; created: number; modified: number; deleted: number };
    today: { created: number; modified: number; deleted: number; commits: number; uniqueFiles: number };
    week: { created: number; modified: number; deleted: number; commits: number; uniqueFiles: number };
    byDay: FileActivityBucket[];
    byExtension: Array<{ extension: string; files: number }>;
  };
  reliability: FailureAnalytics;
};

// `compressionCohorts` ISTRINTAS 2026-08-24 (UI auditas, septintas ratas).
//
// Laukas buvo skaičiuojamas KIEKVIENAM `/api/reliability-analytics` kvietimui — o tą endpoint'ą
// dashboard'as pollina — ir neturėjo NĖ VIENO skaitytojo: nei `src/`, nei `ui-app/` (kliento
// tipas jo net nedeklaravo). Kartu su juo krito visas `context-size-metrics.jsonl` skaitymas ir
// parsinimas, egzistavęs tik jam.
//
// Kohortos NEDINGO: `buildCompressionCohortReport` gyvas ir turi tikrą kvietėją —
// `verqestra report` (`interfaces/cli/reports/report.ts`), kuris jas ir renderina. Čia buvo
// ANTRA to paties skaičiavimo kopija, kurios rezultatas keliaudavo į naršyklę ir būdavo
// numetamas.

export type BuildReliabilityOptions = {
  runtimeRoot?: string;
  now?: Date;
};

const GIT_SINCE_DAYS = 90;

export async function buildReliabilityAnalytics(
  ports: ReliabilityPorts,
  options: BuildReliabilityOptions = {},
): Promise<ReliabilityAnalyticsResponse> {
  const runtimeRoot = options.runtimeRoot ?? path.join(process.cwd(), "vq");
  const now = options.now ?? new Date();

  const gitRaw = await ports.gitLog(GIT_SINCE_DAYS);
  const commits = gitRaw === undefined ? [] : parseGitNumstat(gitRaw);
  const activity = aggregateFileActivity(commits, GIT_SINCE_DAYS, now);

  const rawEvents = parseJsonlObjects(
    await ports.fs.readTextFileIfExists(path.join(runtimeRoot, "logs", "task-events.jsonl")),
  );
  const events = selectLearningTaskEvents(rawEvents);
  const tokens = parseTolerantUsageRecords(
    await ports.fs.readTextFileIfExists(path.join(runtimeRoot, "logs", "token-usage.jsonl")),
  );
  const sessionWrites = await ports.sessionWrites();
  const uniqueSessionWrites = [...new Set(sessionWrites)];
  const session = { touched: uniqueSessionWrites.length, created: 0, modified: 0, deleted: 0 };
  // Task 0049: kind'ai imami iš write-time įvykių žurnalo, nes `git status` čia atsakymo
  // neturi — kai sesijos darbas jau sucommit'intas, medis švarus ir kiekvienas failas
  // atrodo nepaliestas.
  const eventKinds = await ports.sessionFileKinds();
  if (eventKinds.size > 0) {
    // Jungiklis eina pagal PARSE'INTŲ įvykių kiekį, ne pagal failo egzistavimą: tuščias arba
    // visiškai sugadintas žurnalas degraduoja į legacy git kelią, o ne į tylų nulį.
    // `touched` lieka ledger'io atsakomybė (jis yra staging'o source of truth); įvykiai
    // prideda tik tai, ko ledger'is pasakyti negali — kind'ą.
    session.touched = new Set([...uniqueSessionWrites, ...eventKinds.keys()]).size;
    for (const kind of eventKinds.values()) {
      if (kind === "created") session.created += 1;
      else if (kind === "modified") session.modified += 1;
      else if (kind === "deleted") session.deleted += 1;
      // `unknown` sąmoningai nekonvertuojamas: toks failas skaičiuojamas tik į `touched`.
    }
  } else {
    // Legacy kelias sesijoms, prasidėjusioms be įvykių žurnalo. `git status` reikalingas TIK čia.
    const statusRaw = await ports.gitStatusPorcelain();
    if (statusRaw !== undefined) {
      const statusMap = new Map(
        statusRaw.split(/\r?\n/).filter(Boolean).map((line) => [line.slice(3).trim(), line.slice(0, 2)]),
      );
      for (const file of uniqueSessionWrites) {
        const code = statusMap.get(file) ?? "";
        if (code === "??" || code.includes("A")) session.created += 1;
        else if (code.includes("D")) session.deleted += 1;
        // Be git status įrašo failas yra švarus (dažniausiai — jau sucommit'intas), tad apie
        // jo kind'ą nieko nežinome; `modified` čia buvo spėjimas, kuris rodė nulius po commit'o.
        else if (/[MRCT]/.test(code)) session.modified += 1;
      }
    }
  }

  const todayKey = now.toISOString().slice(0, 10);
  const weekStart = new Date(now);
  weekStart.setUTCDate(weekStart.getUTCDate() - 6);
  const weekKey = weekStart.toISOString().slice(0, 10);
  const zero = { created: 0, modified: 0, deleted: 0, commits: 0, uniqueFiles: 0 };
  const today = activity.byDay.find((bucket) => bucket.date === todayKey) ?? { date: todayKey, ...zero };
  const weekSummary = summarizeFileChanges(
    commits.filter((commit) => dateKey(commit.timestamp) >= weekKey && dateKey(commit.timestamp) <= todayKey),
  );
  const week = {
    created: weekSummary.created,
    modified: weekSummary.modified,
    deleted: weekSummary.deleted,
    commits: weekSummary.commits,
    uniqueFiles: weekSummary.uniqueFiles,
  };

  return {
    generatedAt: now.toISOString(),
    coverage: {
      gitSinceDays: GIT_SINCE_DAYS,
      gitAvailable: gitRaw !== undefined,
      taskEvents: events.length,
      tokenRecords: tokens.length,
      limitations: [
        "Historical file activity is commit-based; uncommitted history is unavailable.",
        "Failure cost includes tokens recorded between failure and recovery, not currency pricing.",
        "Daily activity and incidents are grouped by UTC date.",
        // Canary vs control apribojimas ČIA NEBERAŠOMAS: kartu su `compressionCohorts` lauku šis
        // atsakymas kohortų nebeneša, o apribojimas apie nesamą duomenį yra teiginys apie spragą,
        // kurios nėra. Jis gyvas ten, kur kohortos realiai rodomos — `verqestra report`.
        ...(gitRaw !== undefined ? [] : ["Git history is unavailable to the UI server; file history is shown as zero."]),
      ],
    },
    files: {
      session,
      today: { created: today.created, modified: today.modified, deleted: today.deleted, commits: today.commits, uniqueFiles: today.uniqueFiles },
      week,
      byDay: activity.byDay,
      byExtension: activity.byExtension,
    },
    reliability: buildFailureAnalytics(events, tokens),
  };
}

const reliabilityCache = new Map<string, { expiresAt: number; value: Promise<ReliabilityAnalyticsResponse> }>();

/** 10 s TTL cache UI keliui — raktas pagal runtimeRoot, klaida cache'ą išvalo. */
export function loadReliabilityAnalytics(
  ports: ReliabilityPorts,
  options: BuildReliabilityOptions = {},
  fresh = false,
): Promise<ReliabilityAnalyticsResponse> {
  const key = options.runtimeRoot ?? path.join(process.cwd(), "vq");
  const cached = reliabilityCache.get(key);
  if (!fresh && cached && cached.expiresAt > Date.now()) return cached.value;
  const value = buildReliabilityAnalytics(ports, options);
  reliabilityCache.set(key, { expiresAt: Date.now() + 10_000, value });
  void value.catch(() => {
    if (reliabilityCache.get(key)?.value === value) reliabilityCache.delete(key);
  });
  return value;
}
