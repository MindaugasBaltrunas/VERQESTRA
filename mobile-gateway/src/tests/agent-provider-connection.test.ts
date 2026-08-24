import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_PROVIDERS,
  AgentProviderStatusService,
  type AgentProviderStatus,
} from "../application/agent-provider-status-service.js";
import type {
  AgentProviderAuthenticationResult,
  AgentProviderInstallation,
  AgentProviderProbePort,
} from "../application/ports/agent-provider-probe-port.js";
import type { AgentProvider } from "../domain/terminal-session.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone šis failas buvo 643 eilutės).
 *
 * Čia lieka APLIKACIJOS pusė: ką `AgentProviderStatusService` daro su hosto atsakymais —
 * kešas, TTL, `busy`, lygiagretūs skaitytojai, gedimų izoliacija. Hosto ZONDAS
 * (`HostCliAgentProviderProbe`: kokia komanda paleidžiama, kaip skaitoma versija, kur ieškoma
 * kredencialo) persikėlė į `agent-provider-host-probe.test.ts` — jis turi savo fikstūrą ir
 * atsako į kitą klausimą: ne „ką servisas daro su faktu", o „iš kur faktas atsiranda".
 */

/**
 * Fake provider. `verification-matrix.md` requires the CI contract run to detect
 * Claude Code and Codex without either being installed, so no test below starts
 * a real CLI, opens a PTY or touches the host filesystem.
 */
class FakeAgentProviderProbe implements AgentProviderProbePort {
  readonly installationCalls: AgentProvider[] = [];
  readonly authenticationCalls: AgentProvider[] = [];

  constructor(
    private readonly installations: Partial<Record<AgentProvider, AgentProviderInstallation | Error>>,
    private readonly authentications: Partial<
      Record<AgentProvider, AgentProviderAuthenticationResult | Error>
    > = {},
  ) {}

  async detectInstallation(provider: AgentProvider): Promise<AgentProviderInstallation> {
    this.installationCalls.push(provider);
    const value = this.installations[provider] ?? { present: false };
    if (value instanceof Error) throw value;
    return value;
  }

  async detectAuthentication(provider: AgentProvider): Promise<AgentProviderAuthenticationResult> {
    this.authenticationCalls.push(provider);
    const value = this.authentications[provider] ?? { state: "unknown" };
    if (value instanceof Error) throw value;
    return value;
  }
}

/**
 * Fake provider whose host answers are released by the test, one probe at a
 * time. It exists to observe what the service does *while* a probe is running —
 * the window in which a `refresh()` and a cache write can race.
 */
class DeferredAgentProviderProbe implements AgentProviderProbePort {
  readonly installationCalls: AgentProvider[] = [];
  private readonly pending: ((installation: AgentProviderInstallation) => void)[] = [];

  async detectInstallation(provider: AgentProvider): Promise<AgentProviderInstallation> {
    this.installationCalls.push(provider);
    return new Promise<AgentProviderInstallation>((resolve) => {
      this.pending.push(resolve);
    });
  }

  async detectAuthentication(): Promise<AgentProviderAuthenticationResult> {
    return { state: "authenticated" };
  }

  /** Answers the n-th probe that has started, counting from zero. */
  release(probeIndex: number, installation: AgentProviderInstallation): void {
    const resolve = this.pending[probeIndex];
    assert.ok(resolve, `probe ${probeIndex} has not started yet`);
    resolve(installation);
  }
}

function service(
  probe: AgentProviderProbePort,
  overrides: {
    activeSessions?: () => readonly { provider: AgentProvider; sessionId: string }[];
    clock?: () => Date;
    cacheTtlMs?: number;
  } = {},
): AgentProviderStatusService {
  return new AgentProviderStatusService({ probe, ...overrides });
}

function byProvider(statuses: readonly AgentProviderStatus[], provider: AgentProvider): AgentProviderStatus {
  const found = statuses.find((status) => status.provider === provider);
  assert.ok(found, `${provider} must be present in the listing`);
  return found;
}

test("both providers are listed, and a missing installation is not an error", async () => {
  const probe = new FakeAgentProviderProbe({
    "claude-code": { present: true, version: "1.2.3" },
    codex: { present: false },
  }, { "claude-code": { state: "authenticated" } });

  const statuses = await service(probe).statuses();

  assert.deepEqual(statuses.map((status) => status.provider), [...AGENT_PROVIDERS]);
  assert.deepEqual(byProvider(statuses, "claude-code"), {
    provider: "claude-code",
    availability: "ready",
    version: "1.2.3",
  });
  assert.deepEqual(byProvider(statuses, "codex"), {
    provider: "codex",
    availability: "unavailable",
    reasonCode: "not_installed",
  });
});

test("an absent provider is never asked for its sign-in state", async () => {
  const probe = new FakeAgentProviderProbe({ codex: { present: false } });
  await service(probe).status("codex");
  assert.deepEqual(probe.authenticationCalls, []);
});

test("a signed-out provider asks for authentication and still reports its version", async () => {
  const probe = new FakeAgentProviderProbe(
    { codex: { present: true, version: "0.9.1" } },
    { codex: { state: "unauthenticated", reasonCode: "cli_reports_signed_out" } },
  );
  assert.deepEqual(await service(probe).status("codex"), {
    provider: "codex",
    availability: "authentication_required",
    version: "0.9.1",
    reasonCode: "cli_reports_signed_out",
  });
});

test("an unprovable sign-in state fails closed instead of claiming ready", async () => {
  const probe = new FakeAgentProviderProbe(
    { "claude-code": { present: true } },
    { "claude-code": { state: "unknown" } },
  );
  assert.deepEqual(await service(probe).status("claude-code"), {
    provider: "claude-code",
    availability: "authentication_required",
    reasonCode: "auth_state_unknown",
  });
});

test("an unauthenticated verdict without a cause still carries a machine-readable code", async () => {
  const probe = new FakeAgentProviderProbe(
    { codex: { present: true } },
    { codex: { state: "unauthenticated" } },
  );
  const status = await service(probe).status("codex");
  assert.equal(status.availability, "authentication_required");
  assert.equal(status.reasonCode, "not_authenticated");
});

test("one provider's failure never hides the other", async () => {
  const probe = new FakeAgentProviderProbe(
    { "claude-code": new Error("claude probe exploded"), codex: { present: true } },
    { codex: { state: "authenticated" } },
  );

  const statuses = await service(probe).statuses();

  assert.deepEqual(byProvider(statuses, "claude-code"), {
    provider: "claude-code",
    availability: "error",
    reasonCode: "probe_failed",
  });
  assert.equal(byProvider(statuses, "codex").availability, "ready");
});

test("a failing probe reports a code and never the host error message", async () => {
  const probe = new FakeAgentProviderProbe({ codex: new Error("/home/operator/.codex/auth.json is corrupt") });
  const status = await service(probe).status("codex");
  assert.doesNotMatch(JSON.stringify(status), /home|operator|corrupt/i);
});

test("a live session makes the provider busy without probing it again", async () => {
  const probe = new FakeAgentProviderProbe(
    { "claude-code": { present: true, version: "1.2.3" } },
    { "claude-code": { state: "authenticated" } },
  );
  const statuses = service(probe, {
    activeSessions: () => [{ provider: "claude-code", sessionId: "session-1" }],
  });

  assert.deepEqual(await statuses.status("claude-code"), {
    provider: "claude-code",
    availability: "busy",
    activeSessionId: "session-1",
  });
  assert.deepEqual(probe.installationCalls, []);
  assert.deepEqual(probe.authenticationCalls, []);
});

test("a busy provider reuses the version already probed for it", async () => {
  const probe = new FakeAgentProviderProbe(
    { "claude-code": { present: true, version: "1.2.3" } },
    { "claude-code": { state: "authenticated" } },
  );
  let session: string | undefined;
  const statuses = service(probe, {
    activeSessions: () => (session ? [{ provider: "claude-code" as const, sessionId: session }] : []),
  });

  assert.equal((await statuses.status("claude-code")).availability, "ready");
  session = "session-1";
  assert.deepEqual(await statuses.status("claude-code"), {
    provider: "claude-code",
    availability: "busy",
    version: "1.2.3",
    activeSessionId: "session-1",
  });
});

test("host facts are cached for their TTL, re-probed after it and dropped on refresh", async () => {
  const probe = new FakeAgentProviderProbe(
    { codex: { present: true, version: "0.9.1" } },
    { codex: { state: "authenticated" } },
  );
  let now = new Date("2026-08-05T10:00:00.000Z");
  const statuses = service(probe, { clock: () => now, cacheTtlMs: 15_000 });

  await statuses.status("codex");
  now = new Date("2026-08-05T10:00:10.000Z");
  await statuses.status("codex");
  assert.deepEqual(probe.installationCalls, ["codex"]);

  now = new Date("2026-08-05T10:00:16.000Z");
  await statuses.status("codex");
  assert.equal(probe.installationCalls.length, 2);

  statuses.refresh("codex");
  await statuses.status("codex");
  assert.equal(probe.installationCalls.length, 3);
});

test("concurrent readers of one provider share a single host probe", async () => {
  const probe = new FakeAgentProviderProbe(
    { codex: { present: true } },
    { codex: { state: "authenticated" } },
  );
  const statuses = service(probe);
  const [first, second] = await Promise.all([statuses.status("codex"), statuses.status("codex")]);
  assert.deepEqual(first, second);
  assert.deepEqual(probe.installationCalls, ["codex"]);
});

test("refresh without a provider drops every cached provider", async () => {
  const probe = new FakeAgentProviderProbe(
    { "claude-code": { present: true }, codex: { present: true } },
    { "claude-code": { state: "authenticated" }, codex: { state: "authenticated" } },
  );
  const statuses = service(probe);

  await statuses.statuses();
  statuses.refresh();
  await statuses.statuses();

  assert.deepEqual(probe.installationCalls, ["claude-code", "codex", "claude-code", "codex"]);
});

test("a refresh during a probe discards the pre-refresh host facts", async () => {
  const probe = new DeferredAgentProviderProbe();
  const statuses = service(probe);

  // The operator signs in on the host while this probe is still running, so its
  // answer describes a host that no longer exists.
  const beforeRefresh = statuses.status("codex");
  statuses.refresh("codex");
  probe.release(0, { present: true, version: "0.9.1" });
  assert.equal(
    (await beforeRefresh).version,
    "0.9.1",
    "the caller that started the probe still gets the answer it waited for",
  );

  const afterRefresh = statuses.status("codex");
  probe.release(1, { present: true, version: "1.0.0" });
  assert.equal((await afterRefresh).version, "1.0.0", "the stale answer must not have been cached");
  assert.deepEqual(probe.installationCalls, ["codex", "codex"]);
});

test("a probe that outlives its refresh does not evict the probe that replaced it", async () => {
  const probe = new DeferredAgentProviderProbe();
  const statuses = service(probe);

  const beforeRefresh = statuses.status("codex");
  statuses.refresh("codex");
  const afterRefresh = statuses.status("codex");
  assert.deepEqual(probe.installationCalls, ["codex", "codex"], "the refresh starts a second probe");

  // The superseded probe settles first, while its replacement is still running.
  // Retiring it must not take the successor's in-flight entry with it, or the
  // next reader would start a third host process instead of joining the second.
  probe.release(0, { present: true, version: "0.9.1" });
  assert.equal((await beforeRefresh).version, "0.9.1");

  const joiner = statuses.status("codex");
  assert.equal(probe.installationCalls.length, 2, "a later reader joins the probe already in flight");

  probe.release(1, { present: true, version: "1.0.0" });
  assert.equal((await afterRefresh).version, "1.0.0");
  assert.equal((await joiner).version, "1.0.0");
});

test("a failed probe is retried far sooner than a successful one is refreshed", async () => {
  const probe = new FakeAgentProviderProbe({ codex: new Error("probe exploded") });
  let now = new Date("2026-08-05T10:00:00.000Z");
  const statuses = service(probe, { clock: () => now, cacheTtlMs: 15_000 });

  assert.equal((await statuses.status("codex")).availability, "error");

  now = new Date("2026-08-05T10:00:02.999Z");
  await statuses.status("codex");
  assert.deepEqual(probe.installationCalls, ["codex"], "a persistent fault must not spawn a process per read");

  now = new Date("2026-08-05T10:00:03.000Z");
  await statuses.status("codex");
  assert.equal(probe.installationCalls.length, 2, "a transient fault must not stick for the success TTL");
});

test("a failure is never cached longer than the configured window", async () => {
  const probe = new FakeAgentProviderProbe({ codex: new Error("probe exploded") });
  let now = new Date("2026-08-05T10:00:00.000Z");
  const statuses = service(probe, { clock: () => now, cacheTtlMs: 1_000 });

  await statuses.status("codex");
  now = new Date("2026-08-05T10:00:01.000Z");
  await statuses.status("codex");

  assert.equal(probe.installationCalls.length, 2, "the failure window may shorten the TTL, never extend it");
});

test("a recovered host replaces the cached failure once its window passes", async () => {
  // Mutated between reads so the second probe sees a host that has recovered.
  const installations: Partial<Record<AgentProvider, AgentProviderInstallation | Error>> = {
    codex: new Error("probe exploded"),
  };
  const probe = new FakeAgentProviderProbe(installations, { codex: { state: "authenticated" } });
  let now = new Date("2026-08-05T10:00:00.000Z");
  const statuses = service(probe, { clock: () => now, cacheTtlMs: 15_000 });

  assert.equal((await statuses.status("codex")).availability, "error");
  installations.codex = { present: true, version: "0.9.1" };
  now = new Date("2026-08-05T10:00:03.000Z");

  assert.deepEqual(await statuses.status("codex"), {
    provider: "codex",
    availability: "ready",
    version: "0.9.1",
  });
});

test("a failing session lookup is that provider's error, not a thrown listing", async () => {
  const probe = new FakeAgentProviderProbe(
    { "claude-code": { present: true }, codex: { present: true } },
    { "claude-code": { state: "authenticated" }, codex: { state: "authenticated" } },
  );
  const statuses = service(probe, {
    activeSessions: () => {
      throw new Error("/home/operator/.gateway/sessions.json is unreadable");
    },
  });

  const listing = await statuses.statuses();

  assert.deepEqual(listing.map((status) => status.availability), ["error", "error"]);
  assert.deepEqual(probe.installationCalls, [], "the host is not probed for a session state it cannot read");
  assert.doesNotMatch(JSON.stringify(listing), /home|operator|unreadable/i);
});

test("a provider status carries only the fields the contract declares", async () => {
  const probe = new FakeAgentProviderProbe(
    { "claude-code": { present: true, version: "1.2.3" }, codex: { present: true } },
    { "claude-code": { state: "authenticated" }, codex: { state: "unauthenticated" } },
  );
  const allowed = new Set(["provider", "availability", "version", "activeSessionId", "reasonCode"]);
  for (const status of await service(probe).statuses()) {
    for (const key of Object.keys(status)) {
      assert.ok(allowed.has(key), `${key} is not part of the mobile-visible status`);
    }
  }
});

test("an invalid cache TTL is refused at construction", () => {
  const probe = new FakeAgentProviderProbe({});
  assert.throws(() => service(probe, { cacheTtlMs: -1 }), /cache TTL is invalid/);
  assert.throws(() => service(probe, { cacheTtlMs: 1.5 }), /cache TTL is invalid/);
});
