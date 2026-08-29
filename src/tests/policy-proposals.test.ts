// Policy governance pasiūlymų testai (VQ-305 3/3-g): registras, append-only žurnalas ir
// service su human-review approval marker vartais (2026-08-06 UI audito pataisa).

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  requirePolicyFileEntry,
  supportedPolicyFiles,
  UnsupportedPolicyFileError,
} from "../application/policy-governance/policy-file-registry.js";
import {
  buildPolicyProposal,
  decidePolicyProposal,
  humanReviewApprovalMarkerPath,
  HumanReviewApprovalRequiredError,
  listPolicyProposals,
  ProposalCancelConflictError,
  ProposalNotApprovedError,
  type PolicyProposalServicePorts,
} from "../application/policy-governance/policy-proposal-service.js";
import {
  appendPolicyProposal,
  countPendingProposals,
  policyProposalsDir,
  resolveProposalStatus,
  type PolicyDecision,
} from "../application/policy-governance/policy-proposals-log.js";

const ROOT = path.resolve("/repo");
const RUNTIME_ROOT = path.join(ROOT, "vq");
const norm = (p: string): string => p.replace(/\\/g, "/");

function makePorts(): PolicyProposalServicePorts & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    fs: {
      readTextFileIfExists: async (p) => files.get(norm(p)),
      appendTextFile: async (p, text) => {
        files.set(norm(p), (files.get(norm(p)) ?? "") + text);
      },
      makeDirectory: async () => {},
      exists: async (p) => files.has(norm(p)),
      writeTextFile: async (p, content) => {
        files.set(norm(p), content);
      },
    },
  };
}

const ENFORCEMENT_FILE = "vq/architecture/enforcement-policy.json";

test("registras: žinomi failai išvardyti, nežinomas — tipizuota klaida", () => {
  assert.deepEqual(supportedPolicyFiles(), [
    "vq/architecture/architecture-style.json",
    "vq/architecture/coding-principles.json",
    "vq/architecture/enforcement-policy.json",
    "vq/config/preflight-limits.json",
  ]);
  assert.equal(requirePolicyFileEntry(ENFORCEMENT_FILE).group, "enforcement");
  assert.throws(() => requirePolicyFileEntry("vq/config/nesamas.json"), UnsupportedPolicyFileError);
});

test("buildPolicyProposal: dabartinė reikšmė, schema validacija ir routing iš enforcement guard'o", async () => {
  const ports = makePorts();
  const proposal = await buildPolicyProposal(
    ports,
    RUNTIME_ROOT,
    "enforcement",
    "require_tests_for_code_changes",
    true,
    "įjungiam testų vartus",
  );
  assert.equal(proposal.policy_file, ENFORCEMENT_FILE);
  assert.equal(proposal.old_value, false);
  assert.equal(proposal.requested_value, true);
  // Default enforcement: global_policy_changes_require_human_review = true.
  assert.equal(proposal.routing, "human-review");

  await assert.rejects(() =>
    buildPolicyProposal(ports, RUNTIME_ROOT, "enforcement", "max_files_per_task", "ne skaičius", "bloga reikšmė"),
  );
});

test("buildPolicyProposal: reason neprivalomas — nepaduotas tampa \"\", senas tekstinis reason lieka validus", async () => {
  const ports = makePorts();
  const withoutReason = await buildPolicyProposal(
    ports,
    RUNTIME_ROOT,
    "enforcement",
    "require_tests_for_code_changes",
    true,
  );
  assert.equal(withoutReason.reason, "");
  await appendPolicyProposal(ports.fs, RUNTIME_ROOT, withoutReason);

  const withReason = await buildPolicyProposal(
    ports,
    RUNTIME_ROOT,
    "enforcement",
    "require_tests_for_code_changes",
    false,
    "sena priežastis",
  );
  assert.equal(withReason.reason, "sena priežastis");
  await appendPolicyProposal(ports.fs, RUNTIME_ROOT, withReason);

  assert.equal(await countPendingProposals(ports.fs, RUNTIME_ROOT), 2);
});

test("apply vartai: be approve — klaida; approved + human-review be markerio — klaida; su markeriu — failas įrašomas", async () => {
  const ports = makePorts();
  const proposal = await buildPolicyProposal(
    ports,
    RUNTIME_ROOT,
    "enforcement",
    "require_tests_for_code_changes",
    true,
    "įjungiam testų vartus",
  );
  await appendPolicyProposal(ports.fs, RUNTIME_ROOT, proposal);
  assert.equal(await countPendingProposals(ports.fs, RUNTIME_ROOT), 1);

  const ref = {
    policy_file: ENFORCEMENT_FILE,
    setting_id: "require_tests_for_code_changes",
    actor: "operator",
    reason: "review",
  };

  await assert.rejects(
    () => decidePolicyProposal(ports, RUNTIME_ROOT, "apply", ref),
    ProposalNotApprovedError,
  );

  const afterApprove = await decidePolicyProposal(ports, RUNTIME_ROOT, "approve", ref);
  assert.equal(afterApprove.proposals[0]?.status, "approved");

  await assert.rejects(
    () => decidePolicyProposal(ports, RUNTIME_ROOT, "apply", ref),
    HumanReviewApprovalRequiredError,
  );

  // Žmogus sukuria out-of-band žymę — apply praeina ir įrašo policy failą.
  const marker = humanReviewApprovalMarkerPath(RUNTIME_ROOT, ref.policy_file, ref.setting_id);
  ports.files.set(norm(marker), "approved");
  const afterApply = await decidePolicyProposal(ports, RUNTIME_ROOT, "apply", ref);
  assert.equal(afterApply.proposals[0]?.status, "applied");

  const written = JSON.parse(ports.files.get(norm(path.join(ROOT, ENFORCEMENT_FILE)))!) as Record<string, unknown>;
  assert.equal(written["require_tests_for_code_changes"], true);
});

test("decide validuoja policy failą kiekvienam verbui, o statusas — paskutinis sprendimas", async () => {
  const ports = makePorts();
  await assert.rejects(
    () =>
      decidePolicyProposal(ports, RUNTIME_ROOT, "approve", {
        policy_file: "vq/config/nesamas.json",
        setting_id: "x",
        actor: "operator",
        reason: "r",
      }),
    UnsupportedPolicyFileError,
  );

  const decisions: PolicyDecision[] = [
    { policy_file: "a", setting_id: "s", actor: "op", reason: "", timestamp: "1", decision: "approved" },
    { policy_file: "a", setting_id: "s", actor: "op", reason: "", timestamp: "2", decision: "rejected" },
    { policy_file: "b", setting_id: "s", actor: "op", reason: "", timestamp: "3", decision: "applied" },
  ];
  assert.equal(resolveProposalStatus(decisions, { policy_file: "a", setting_id: "s" }), "rejected");
  assert.equal(resolveProposalStatus(decisions, { policy_file: "c", setting_id: "s" }), "pending");

  assert.deepEqual(await listPolicyProposals(ports, RUNTIME_ROOT), { proposals: [] });
});

test("cancel: pending pasiūlymą galima atšaukti — žurnalas append-only, įrašų skaičius tik auga", async () => {
  const ports = makePorts();
  const proposal = await buildPolicyProposal(
    ports,
    RUNTIME_ROOT,
    "enforcement",
    "require_tests_for_code_changes",
    true,
    "įjungiam testų vartus",
  );
  await appendPolicyProposal(ports.fs, RUNTIME_ROOT, proposal);

  const ref = {
    policy_file: ENFORCEMENT_FILE,
    setting_id: "require_tests_for_code_changes",
    actor: "operator",
    reason: "persigalvota",
  };

  const decisionsBefore = (await readResolvedProposalsDecisionCount(ports));
  const afterCancel = await decidePolicyProposal(ports, RUNTIME_ROOT, "cancel", ref);
  assert.equal(afterCancel.proposals[0]?.status, "cancelled");
  const decisionsAfter = (await readResolvedProposalsDecisionCount(ports));
  assert.ok(decisionsAfter > decisionsBefore);
});

test("cancel: approved (dar nepritaikytą) pasiūlymą galima atšaukti", async () => {
  const ports = makePorts();
  const proposal = await buildPolicyProposal(
    ports,
    RUNTIME_ROOT,
    "enforcement",
    "require_tests_for_code_changes",
    true,
    "įjungiam testų vartus",
  );
  await appendPolicyProposal(ports.fs, RUNTIME_ROOT, proposal);

  const ref = {
    policy_file: ENFORCEMENT_FILE,
    setting_id: "require_tests_for_code_changes",
    actor: "operator",
    reason: "review",
  };

  const afterApprove = await decidePolicyProposal(ports, RUNTIME_ROOT, "approve", ref);
  assert.equal(afterApprove.proposals[0]?.status, "approved");

  const afterCancel = await decidePolicyProposal(ports, RUNTIME_ROOT, "cancel", {
    ...ref,
    reason: "persigalvota po approve",
  });
  assert.equal(afterCancel.proposals[0]?.status, "cancelled");
  assert.equal(afterCancel.proposals[0]?.history.length, 2);
});

test("cancel: konfliktas iš applied ir iš rejected — žurnalas nesikeičia", async () => {
  const ports = makePorts();
  const proposal = await buildPolicyProposal(
    ports,
    RUNTIME_ROOT,
    "enforcement",
    "require_tests_for_code_changes",
    true,
    "įjungiam testų vartus",
  );
  await appendPolicyProposal(ports.fs, RUNTIME_ROOT, proposal);

  const applyRef = {
    policy_file: ENFORCEMENT_FILE,
    setting_id: "require_tests_for_code_changes",
    actor: "operator",
    reason: "review",
  };
  await decidePolicyProposal(ports, RUNTIME_ROOT, "approve", applyRef);
  const marker = humanReviewApprovalMarkerPath(RUNTIME_ROOT, applyRef.policy_file, applyRef.setting_id);
  ports.files.set(norm(marker), "approved");
  await decidePolicyProposal(ports, RUNTIME_ROOT, "apply", applyRef);

  const decisionsBeforeConflict = await readResolvedProposalsDecisionCount(ports);
  await assert.rejects(
    () => decidePolicyProposal(ports, RUNTIME_ROOT, "cancel", applyRef),
    ProposalCancelConflictError,
  );
  assert.equal(await readResolvedProposalsDecisionCount(ports), decisionsBeforeConflict);

  const rejectedProposal = await buildPolicyProposal(
    ports,
    RUNTIME_ROOT,
    "enforcement",
    "max_files_per_task",
    5,
    "kitas pasiūlymas",
  );
  await appendPolicyProposal(ports.fs, RUNTIME_ROOT, rejectedProposal);
  const rejectRef = {
    policy_file: ENFORCEMENT_FILE,
    setting_id: "max_files_per_task",
    actor: "operator",
    reason: "atmesta",
  };
  await decidePolicyProposal(ports, RUNTIME_ROOT, "reject", rejectRef);

  await assert.rejects(
    () => decidePolicyProposal(ports, RUNTIME_ROOT, "cancel", rejectRef),
    ProposalCancelConflictError,
  );
});

async function readResolvedProposalsDecisionCount(
  ports: PolicyProposalServicePorts & { files: Map<string, string> },
): Promise<number> {
  const raw = (await ports.fs.readTextFileIfExists(
    norm(path.join(policyProposalsDir(RUNTIME_ROOT), "decisions.jsonl")),
  )) ?? "";
  return raw.split(/\r?\n/).filter((line) => line.trim()).length;
}
