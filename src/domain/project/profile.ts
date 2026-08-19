// Pure project-profile resolution rules. This is a low domain layer: no node/FS/process/git
// imports and no side effects — only the value types and the total function that resolves a set
// of already-gathered workspace signals plus any explicit caller choice into a project profile.
// The FS-reading adapter (E4 infrastructure) gathers the evidence and persists profile.json;
// the domain never touches disk. Behaviour etalon: AG_loop domain/project/profile.ts.

/** Where a resolved profile field's value came from. */
export type ProfileFieldSource = "explicit" | "inferred";

/** A single resolved profile field: its value plus where that value came from. */
export type ProfileField<T> = {
  value: T;
  source: ProfileFieldSource;
};

/**
 * Side-effect-free snapshot of what the workspace (or a previously persisted profile) suggests
 * for each profile field. The adapter gathers these values; the domain never touches disk.
 */
export type InputEvidence = {
  name?: string;
  language?: string;
  packageManager?: string;
  sourceRoots: string[];
  forbiddenPaths: string[];
};

/** Explicit choices a user or caller has made, overriding whatever the evidence would infer. */
export type ExplicitProfileChoices = {
  name?: string;
  language?: string;
  packageManager?: string;
  sourceRoots?: string[];
  forbiddenPaths?: string[];
};

/** The resolved, in-memory project profile: every field records whether it is explicit or inferred. */
export type ProjectProfile = {
  name: ProfileField<string | undefined>;
  language: ProfileField<string | undefined>;
  packageManager: ProfileField<string | undefined>;
  sourceRoots: ProfileField<string[]>;
  forbiddenPaths: ProfileField<string[]>;
};

/**
 * Resolves a {@link ProjectProfile} from workspace {@link InputEvidence} plus any
 * {@link ExplicitProfileChoices}. Precedence, per field: an explicit choice always wins over the
 * inferred evidence value for that same field; a field left unset by the caller falls back to
 * whatever the evidence carries.
 */
export function resolveProjectProfile(
  evidence: InputEvidence,
  explicit: ExplicitProfileChoices = {},
): ProjectProfile {
  return {
    name: resolveField(explicit.name, evidence.name),
    language: resolveField(explicit.language, evidence.language),
    packageManager: resolveField(explicit.packageManager, evidence.packageManager),
    sourceRoots: resolveField(explicit.sourceRoots, evidence.sourceRoots),
    forbiddenPaths: resolveField(explicit.forbiddenPaths, evidence.forbiddenPaths),
  };
}

function resolveField<T>(explicitValue: T | undefined, inferredValue: T): ProfileField<T> {
  return explicitValue === undefined
    ? { value: inferredValue, source: "inferred" }
    : { value: explicitValue, source: "explicit" };
}
