// Control-plane UI modelis (etalonas: AG_loop interfaces/ui-model/control-plane-model.ts).
//
// Šis sluoksnis TIK atvaizduoja domain + politikų skaitymus į pateikimo formas: jis nemutuoja
// politikos ir nesprendžia governance maršruto — tai gyvena application/policy-governance.
// Pasiūlymų statymas/sprendimas importuojamas iš ten, kad UI modelis liktų gryna skaitymo
// kompozicija.

import path from "node:path";
import type { ArchitectureStateFsPort } from "../../application/architecture/ports.js";
import {
  checkArchitectureGovernance,
  loadStackDecisionState,
} from "../../application/architecture/governance.js";
import {
  readLearningMemoryRecords,
  summarizeLearningMemory,
  type LearningMemoryRecord,
  type LearningMemorySummary,
} from "../../application/learning/learning-memory.js";
import type { LearningFsPort } from "../../application/learning/ports.js";
import {
  loadArchitectureStylePolicy,
  loadCodingPrinciplesPolicy,
  loadEnforcementPolicy,
} from "../../application/policy-governance/architecture-policies.js";
import { loadGitAutomationPolicy } from "../../application/policy-governance/git-automation-policy.js";
import {
  readResolvedProposals,
  type PolicyProposal,
} from "../../application/policy-governance/policy-proposals-log.js";
import type { PolicyConfigFileSystemPort } from "../../application/policy-governance/ports.js";
import { ENFORCEMENT_LEVELS } from "../../domain/policies/enforcement-level.js";
import type { StackDecision, StackDecisionConfidence } from "../../domain/policies/stack-decision.js";
import { firstHeading } from "../../shared/markdown.js";
import { toPosixPath } from "../../shared/paths.js";
import type { AgentActivity } from "./agent-activity.js";
import type { UiTokenBudget } from "./token-budget-view.js";

export type UiPolicyControl = {
  id: string;
  label: string;
  value: boolean | string | number;
  source: string;
  editable: boolean;
  route: string;
  allowed_values?: string[];
  pending_proposal?: PolicyProposal;
};

export type UiPolicyGroup = {
  group: string;
  label: string;
  controls: UiPolicyControl[];
};

export type UiConfigControl = {
  id: string;
  label: string;
  value: boolean | string | number;
  source: string;
  editable: boolean;
  command?: string;
};

export type UiHumanReviewTask = {
  file: string;
  task_id: string;
  title: string;
  blocked_by?: string;
  reason?: string;
  preview: string;
  actions: string[];
};

export type UiLearningRecommendation = {
  id: string;
  status: "pending" | "approved" | "rejected";
  summary: string;
  labels: string[];
  evidence: string[];
  task_id?: string;
  file?: string;
  actions: string[];
};

export type UiStackDecision = {
  selected_language: string | null;
  selected_framework: string | null;
  architecture_style: string;
  confidence: StackDecisionConfidence;
  human_review_required: boolean;
  reason: string;
};

/**
 * Realaus laiko slot'o užimtumas — bangos snapshot'o `live_slots[]` veidrodis, autoritetas dėl
 * task/attempt/started_at/worktree priskyrimo, įskaitant papildymus (refill), kurie jokiam
 * bangos planui nepriklauso. Šis modelis snapshot'o pats neskaito: kvietėjas jį jau turi iš savo
 * lygiagretaus skaitymo ir tik suneša į kontraktą.
 */
export type UiLiveSlot = {
  worker_id: string;
  task_id: string;
  attempt: number;
  started_at: string;
  worktree_path: string;
};

/**
 * Vieno gyvo slot'o agentų grandinės būsena — OPTIONAL blokas šalia globalių laukų.
 *
 * Kodėl atskiras įrašas, o ne vienas globalus: {@link AgentActivity} iki daugiaslot'inės bangos
 * buvo projekcija ant VIENO globalaus log'o, kurį lygiagretūs worker'iai perrašo vienas per kitą.
 * Antram slot'ui tai reiškė svetimą grandinę ir svetimą fazę. Čia kiekvienas įrašas turi savo
 * bandymo log'ą, tad `activity` priklauso būtent tam slot'ui.
 */
export type UiSlotActivity = {
  worker_id: string;
  task_id: string;
  attempt: number;
  /** Repo-relatyvus posix kelias, IŠ KURIO įrašas išparsintas — kilmė rodoma, o ne nutylima. */
  log_path: string;
  activity: AgentActivity;
};

export type UiControlPlaneData = {
  config_controls: UiConfigControl[];
  loop_controls: Array<{ id: "resume" | "stop"; label: string; endpoint: string; method: "POST" }>;
  human_review_tasks: UiHumanReviewTask[];
  learning_recommendations: UiLearningRecommendation[];
  learning_summary: LearningMemorySummary;
  policy_controls: UiPolicyGroup[];
  stack_decision?: UiStackDecision;
  live_slots?: UiLiveSlot[];
  token_budget?: UiTokenBudget;
};

/** Skaitymo portų sąjunga: UI modelis pernaudoja application skaitiklius, tad ir jų portus. */
export type ControlPlaneFsPort = ArchitectureStateFsPort &
  LearningFsPort &
  PolicyConfigFileSystemPort & {
    /** Failų vardai kataloge; nesamas katalogas — tuščias sąrašas. */
    listFiles(absoluteDir: string): Promise<string[]>;
  };

export type ControlPlanePorts = {
  fs: ControlPlaneFsPort;
};

export type ControlPlaneRoots = {
  projectRoot: string;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot: string;
};

export function toUiStackDecision(decision: StackDecision): UiStackDecision {
  return {
    selected_language: decision.selectedLanguage,
    selected_framework: decision.selectedFramework,
    architecture_style: decision.architectureStyle,
    confidence: decision.confidence,
    human_review_required: decision.humanReviewRequired,
    reason: decision.reason,
  };
}

/**
 * Naujausias LAUKIANTIS pasiūlymas kiekvienam (policy_file, setting_id), kad kiekvienas valdiklis
 * galėtų parodyti savo neišspręstą pasiūlymą be naujo persistencijos sluoksnio.
 */
export async function loadPendingProposalsBySetting(
  ports: ControlPlanePorts,
  runtimeRoot: string,
): Promise<Map<string, PolicyProposal>> {
  const resolved = await readResolvedProposals(ports.fs, runtimeRoot);
  const pending = new Map<string, PolicyProposal>();
  for (const { proposal, status } of resolved) {
    if (status !== "pending") continue;
    const key = `${proposal.policy_file}::${proposal.setting_id}`;
    const existing = pending.get(key);
    if (!existing || proposal.timestamp > existing.timestamp) pending.set(key, proposal);
  }
  return pending;
}

const ARCHITECTURE_SOURCE = "vq/architecture/architecture-style.json";
const CODING_SOURCE = "vq/architecture/coding-principles.json";
const ENFORCEMENT_SOURCE = "vq/architecture/enforcement-policy.json";
const GIT_POLICY_SOURCE = "vq/config/git-automation-policy.json";
const GIT_POLICY_EDIT_HINT = "vq/config/git-automation-policy.json keičiamas per AG užduotį / OpenSpec pakeitimą";

export async function loadUiPolicyControls(
  ports: ControlPlanePorts,
  runtimeRoot: string,
): Promise<UiPolicyGroup[]> {
  const [archPolicy, codingPolicy, enfPolicy, pendingBySetting] = await Promise.all([
    loadArchitectureStylePolicy(ports.fs, runtimeRoot),
    loadCodingPrinciplesPolicy(ports.fs, runtimeRoot),
    loadEnforcementPolicy(ports.fs, runtimeRoot),
    loadPendingProposalsBySetting(ports, runtimeRoot),
  ]);

  const withPending = (control: Omit<UiPolicyControl, "pending_proposal">): UiPolicyControl => {
    const pending = pendingBySetting.get(`${control.source}::${control.id}`);
    return pending ? { ...control, pending_proposal: pending } : control;
  };

  const level = (id: string, label: string, value: string): UiPolicyControl =>
    withPending({
      id,
      label,
      value,
      source: CODING_SOURCE,
      editable: true,
      route: "/api/policies/coding-principles/set",
      allowed_values: [...ENFORCEMENT_LEVELS],
    });

  const enforcement = (id: string, label: string, value: boolean | string | number): UiPolicyControl =>
    withPending({ id, label, value, source: ENFORCEMENT_SOURCE, editable: true, route: "/api/policies/enforcement/set" });

  return [
    {
      group: "architecture-style",
      label: "Architecture Style",
      controls: [
        withPending({
          id: "style",
          label: "Architecture style",
          value: archPolicy.style,
          source: ARCHITECTURE_SOURCE,
          editable: true,
          route: "/api/policies/architecture-style/set",
        }),
        withPending({
          id: "strictness",
          label: "Enforcement strictness",
          value: archPolicy.strictness,
          source: ARCHITECTURE_SOURCE,
          editable: true,
          route: "/api/policies/architecture-style/set",
          allowed_values: [...ENFORCEMENT_LEVELS],
        }),
      ],
    },
    {
      group: "coding-principles",
      label: "Coding Principles",
      controls: [
        level("single_responsibility", "Single responsibility", codingPolicy.single_responsibility),
        level("open_closed", "Open/closed principle", codingPolicy.open_closed),
        level("dependency_inversion", "Dependency inversion", codingPolicy.dependency_inversion),
        level("interface_segregation", "Interface segregation", codingPolicy.interface_segregation),
        level("dry", "DRY", codingPolicy.dry),
        level("yagni", "YAGNI", codingPolicy.yagni),
      ],
    },
    {
      group: "enforcement",
      label: "Enforcement",
      controls: [
        enforcement("max_files_per_task", "Max files per task", enfPolicy.max_files_per_task),
        enforcement("max_lines_per_file", "Max lines per file", enfPolicy.max_lines_per_file),
        enforcement(
          "max_responsibilities_per_task",
          "Max responsibilities per task",
          enfPolicy.max_responsibilities_per_task,
        ),
        enforcement(
          "require_tests_for_code_changes",
          "Require tests for code changes",
          enfPolicy.require_tests_for_code_changes,
        ),
        enforcement(
          "require_interface_contract_for_public_changes",
          "Require interface contract for public changes",
          enfPolicy.require_interface_contract_for_public_changes,
        ),
        enforcement(
          "broad_scope_requires_human_review",
          "Broad scope requires human review",
          enfPolicy.broad_scope_requires_human_review,
        ),
        enforcement(
          "global_policy_changes_require_human_review",
          "Global policy changes require human review",
          enfPolicy.global_policy_changes_require_human_review,
        ),
      ],
    },
  ];
}

export async function loadUiControlPlaneData(
  ports: ControlPlanePorts,
  roots: ControlPlaneRoots,
): Promise<UiControlPlaneData> {
  const root = path.resolve(roots.projectRoot);
  const [gitPolicy, architecture, learningSummary, stackDecision, humanReviewTasks, learningRecords, policyControls] =
    await Promise.all([
      loadGitAutomationPolicy(ports.fs, roots.runtimeRoot),
      checkArchitectureGovernance(ports.fs, root),
      summarizeLearningMemory(ports.fs, roots.runtimeRoot),
      loadStackDecisionState(ports.fs, root).catch(() => undefined),
      readHumanReviewTasks(ports, root),
      readLearningMemoryRecords(ports.fs, roots.runtimeRoot),
      loadUiPolicyControls(ports, roots.runtimeRoot),
    ]);

  const config = (id: string, label: string, value: boolean | string | number): UiConfigControl => ({
    id,
    label,
    value,
    source: GIT_POLICY_SOURCE,
    editable: true,
    command: GIT_POLICY_EDIT_HINT,
  });

  return {
    config_controls: [
      config("auto_commit_enabled", "Auto commit after successful checks", gitPolicy.auto_commit_enabled),
      config("auto_push_enabled", "Auto push after commit", gitPolicy.auto_push_enabled),
      config("conventional_commits_required", "Require Conventional Commits", gitPolicy.conventional_commits_required),
      config("pr_after_successful_task", "Prepare PR after successful task", gitPolicy.pr_after_successful_task),
      config(
        "release_notes_after_final_audit",
        "Generate release notes after final audit",
        gitPolicy.release_notes_after_final_audit,
      ),
      {
        id: "architecture_governance",
        label: "Architecture governance workspace",
        value: architecture.ok ? "ok" : `missing:${architecture.missing.length}`,
        source: "vq/architecture/governance.json",
        editable: false,
        command: "verqestra architecture check --json",
      },
    ],
    loop_controls: [
      { id: "resume", label: "Resume loop", endpoint: "/tasks/resume", method: "POST" },
      { id: "stop", label: "Request loop stop", endpoint: "/tasks/stop", method: "POST" },
    ],
    human_review_tasks: humanReviewTasks,
    learning_recommendations: latestLearningRecommendations(learningRecords),
    learning_summary: learningSummary,
    policy_controls: policyControls,
    ...(stackDecision === undefined ? {} : { stack_decision: toUiStackDecision(stackDecision) }),
  };
}

async function readHumanReviewTasks(ports: ControlPlanePorts, projectRoot: string): Promise<UiHumanReviewTask[]> {
  const dir = path.join(projectRoot, "AG", "tasks", "human-review");
  const names = (await ports.fs.listFiles(dir)).filter((name) => name.endsWith(".md"));

  const tasks: UiHumanReviewTask[] = [];
  for (const name of names) {
    const absolute = path.join(dir, name);
    const text = (await ports.fs.readTextFileIfExists(absolute)) ?? "";
    const blockedBy = fieldValue(text, "blocked_by");
    const reason = fieldValue(text, "reason");
    tasks.push({
      file: toPosixPath(path.relative(projectRoot, absolute)),
      task_id: name.replace(/\.md$/i, ""),
      title: firstHeading(text) ?? name,
      ...(blockedBy === undefined ? {} : { blocked_by: blockedBy }),
      ...(reason === undefined ? {} : { reason }),
      preview: text.split(/\r?\n/).slice(0, 12).join("\n"),
      actions: ["approve/requeue", "edit task", "reject/keep in human-review"],
    });
  }
  return tasks.sort((a, b) => a.file.localeCompare(b.file));
}

/** Naujausias įrašas kiekvienam rekomendacijos id — senesni to paties id įrašai yra istorija. */
export function latestLearningRecommendations(
  records: readonly LearningMemoryRecord[],
): UiLearningRecommendation[] {
  const latest = new Map<string, LearningMemoryRecord>();
  for (const record of records) {
    if (record.type === "policy_recommendation") latest.set(record.id, record);
  }
  return Array.from(latest.values())
    .sort((a, b) => b.ts.localeCompare(a.ts) || b.id.localeCompare(a.id))
    .map((record) => ({
      id: record.id,
      status: record.recommendation_status ?? "pending",
      summary: record.summary,
      labels: record.labels,
      evidence: record.evidence,
      ...(record.task_id === undefined ? {} : { task_id: record.task_id }),
      ...(record.file === undefined ? {} : { file: record.file }),
      // Veiksmai rodomi TIK neišspręstai rekomendacijai: jau patvirtinta ar atmesta neturi
      // siūlyti mygtuko, kuris tyliai nieko nedarytų.
      actions: record.recommendation_status && record.recommendation_status !== "pending" ? [] : ["approve", "reject"],
    }));
}

function fieldValue(text: string, field: string): string | undefined {
  const pattern = new RegExp(`^\\s*-?\\s*${field}\\s*:\\s*(.+)$`, "im");
  return text.match(pattern)?.[1]?.trim();
}
