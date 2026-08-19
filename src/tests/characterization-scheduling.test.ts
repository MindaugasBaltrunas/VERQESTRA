// VQ-202 characterization (PAR-1): lease/scope-lock verdiktų runner'is prieš pažodinę
// AG_loop fixture kopiją (47 kontraktai). Determinizmas: `now` ISO → Date, gyvybės/
// aprėpties callback'ai iš deadOwnerIds/irrelevantLeaseIds sąrašų. Record režimo NĖRA.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  authorizeRuntimeMutation,
  leaseScopeCoversPath,
  type WorkerLease,
  type WorkerLeaseClaim,
  type WorkerLeaseScope,
} from "../domain/scheduling/worker-lease-rules.js";
import {
  authorizeScopedPath,
  scopeCovers,
  scopesConflict,
  type ScopeLock,
  type ScopeLockRegistry,
} from "../domain/scheduling/scope-lock-rules.js";

type VerdictCase = { id: string; fn: string; input: Record<string, unknown>; expect: Record<string, unknown> };

type SchedulingFixture = {
  schema_version: number;
  shared: Record<string, Record<string, unknown>>;
  cases: VerdictCase[];
};

const fixturePath = path.resolve(
  process.cwd(),
  "src",
  "tests",
  "fixtures",
  "characterization",
  "scheduling-verdicts.json",
);

const fixture: SchedulingFixture = JSON.parse(await readFile(fixturePath, "utf8"));

/** `"$vardas"` → shared kopija; `{"$base": "vardas", ...}` → shared kopija su perrašymais. */
function expand(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("$")) {
    const shared = fixture.shared[value.slice(1)];
    if (!shared) throw new Error(`fixture shared reference missing: ${value}`);
    return structuredClone(shared);
  }
  if (Array.isArray(value)) return value.map(expand);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record["$base"] === "string") {
      const shared = fixture.shared[record["$base"]];
      if (!shared) throw new Error(`fixture $base reference missing: ${record["$base"]}`);
      const { $base: _unused, ...overrides } = record;
      return { ...structuredClone(shared), ...overrides };
    }
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, expand(entry)]));
  }
  return value;
}

function runCase(verdictCase: VerdictCase): unknown {
  const input = expand(verdictCase.input) as Record<string, unknown>;
  switch (verdictCase.fn) {
    case "authorizeRuntimeMutation": {
      const deadOwnerIds = (input["deadOwnerIds"] as string[] | undefined) ?? [];
      const irrelevantLeaseIds = (input["irrelevantLeaseIds"] as string[] | undefined) ?? [];
      const result = authorizeRuntimeMutation({
        leases: input["leases"] as WorkerLease[],
        ...(input["claim"] === undefined ? {} : { claim: input["claim"] as WorkerLeaseClaim }),
        ...(input["taskId"] === undefined ? {} : { taskId: input["taskId"] as string }),
        ...(input["attempt"] === undefined ? {} : { attempt: input["attempt"] as number }),
        now: new Date(input["now"] as string),
        isOwnerProcessDead: (lease) => deadOwnerIds.includes(lease.owner_id),
        isLeaseRelevant: (lease) => !irrelevantLeaseIds.includes(lease.lease_id),
      });
      return { status: result.status, ok: result.ok, reason: result.reason, leasePresent: result.lease !== undefined };
    }
    case "leaseScopeCoversPath": {
      const scope = { lease: {} as WorkerLease, ...(input["scope"] as Record<string, unknown>) } as WorkerLeaseScope;
      return { result: leaseScopeCoversPath(scope, input["path"] as string) };
    }
    case "authorizeScopedPath": {
      const registry: ScopeLockRegistry = { schema_version: 1, locks: input["locks"] as ScopeLock[] };
      const result = authorizeScopedPath(
        registry,
        input["path"] as string,
        input["leaseId"] as string | undefined,
        new Date(input["now"] as string),
      );
      return { status: result.status, ok: result.ok, reason: result.reason, lockId: result.lock?.lock_id ?? null };
    }
    case "scopeCovers": {
      try {
        const result = scopeCovers(input["lock"] as Pick<ScopeLock, "kind" | "scope">, input["path"] as string);
        return { result };
      } catch {
        return { throws: true };
      }
    }
    case "scopesConflict":
      return {
        result: scopesConflict(
          input["left"] as Pick<ScopeLock, "kind" | "scope">,
          input["right"] as Pick<ScopeLock, "kind" | "scope">,
        ),
      };
    default:
      throw new Error(`fixture names unknown function: ${verdictCase.fn}`);
  }
}

test("scheduling fixture is well-formed (schema v1, unique ids)", () => {
  assert.equal(fixture.schema_version, 1);
  assert.ok(fixture.cases.length >= 47, "fixture must keep its recorded coverage");
  const ids = fixture.cases.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "case ids must be unique");
});

for (const verdictCase of fixture.cases) {
  test(`scheduling verdict: ${verdictCase.id}`, () => {
    const actual = JSON.parse(JSON.stringify(runCase(verdictCase)));
    assert.deepStrictEqual(actual, verdictCase.expect, verdictCase.id);
  });
}
