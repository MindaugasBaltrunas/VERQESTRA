import type { AuditEvent, AuditPort } from "../application/ports/audit-port.js";

/**
 * Process-local, append-only audit sink.
 *
 * Records are never mutated or reordered; once the bound is reached the OLDEST
 * record is dropped, so a flood of fresh events cannot be used to suppress the
 * write of a newer one. Persistent, integrity-protected storage is a separate
 * unimplemented item (see `implementation-status.md`); this adapter exists so
 * the audit boundary is wired and testable at the HTTP edge today.
 */
export class InMemoryAuditLog implements AuditPort {
  private readonly events: AuditEvent[] = [];

  constructor(private readonly maxEvents = 10_000) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) {
      throw new Error("Audit log maxEvents must be a positive integer");
    }
  }

  async record(event: AuditEvent): Promise<void> {
    this.events.push(Object.freeze({ ...event }));
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }

  entries(): readonly AuditEvent[] {
    return [...this.events];
  }
}
