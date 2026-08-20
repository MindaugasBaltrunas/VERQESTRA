// release-readiness use case (etalono release-notes.ts, WBR VQ-305): rendina release notes
// iš task ledger'io ir paskutinio release-check rezultato. Kviečia final-audit (kai visos
// patikros žalios) ir tiesioginis CLI (E5). Politika — policy-governance/git-automation-policy;
// visas FS — per portą.
export type ReleaseNotesLedgerEntry = {
  task_name?: string;
  state?: string;
  file?: string;
  updated_at?: string;
};

export type ReleaseNotesResult = {
  status: "generated" | "disabled";
  path: string;
  done_tasks: number;
  release_check_status: string;
};

export type ReleaseNotesPorts = {
  /** `loadGitAutomationPolicy` per composition — čia tik rezultatas. */
  loadPolicy(): Promise<{ release_notes_after_final_audit: boolean; release_notes_path: string }>;
  readTaskLedger(): Promise<Record<string, ReleaseNotesLedgerEntry>>;
  /** `vq/state/release-check-result.json` `status` laukas; "missing", kai failo nėra. */
  readReleaseCheckStatus(): Promise<string>;
  /** `vq/project/status.md` turinys (trim'intas); tuščia eilutė, kai failo nėra. */
  readProjectStatus(): Promise<string>;
  /** Įrašo notes į `release_notes_path` (projekto šaknies atžvilgiu). */
  writeNotes(relativePath: string, text: string): Promise<void>;
};

export async function generateReleaseNotes(ports: ReleaseNotesPorts, now = new Date()): Promise<ReleaseNotesResult> {
  const policy = await ports.loadPolicy();
  const relativePath = policy.release_notes_path;
  if (!policy.release_notes_after_final_audit) {
    return { status: "disabled", path: relativePath, done_tasks: 0, release_check_status: "disabled" };
  }

  const ledger = await ports.readTaskLedger();
  const doneTasks = Object.entries(ledger)
    .filter(([, entry]) => entry.state === "done")
    .sort((a, b) => (a[1].updated_at ?? "").localeCompare(b[1].updated_at ?? "") || a[0].localeCompare(b[0]));
  const releaseStatus = await ports.readReleaseCheckStatus();
  const projectStatus = await ports.readProjectStatus();
  const notes = renderReleaseNotes(now.toISOString(), releaseStatus, projectStatus, doneTasks);

  await ports.writeNotes(relativePath, notes);
  return { status: "generated", path: relativePath, done_tasks: doneTasks.length, release_check_status: releaseStatus };
}

export function renderReleaseNotes(
  generatedAt: string,
  releaseStatus: string,
  projectStatus: string,
  doneTasks: Array<[string, ReleaseNotesLedgerEntry]>,
): string {
  const tasks =
    doneTasks.length > 0
      ? doneTasks.map(([taskId, entry]) => `- ${taskId}: ${entry.task_name ?? entry.file ?? "done task"}`).join("\n")
      : "- No done tasks recorded.";
  return `# AG Release Notes\n\nGenerated: ${generatedAt}\n\n## Release check\n\nStatus: ${releaseStatus}\n\n## Project status\n\n${projectStatus || "No project status recorded."}\n\n## Completed tasks\n\n${tasks}\n`;
}
