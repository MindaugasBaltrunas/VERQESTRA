import { describe, expect, it } from "vitest";
import { buildFailureCsv, type FailureRecord } from "./failureCsv";

const HEADER = "task_id,type,phase,failed_at,fixed_at,status,reason,incident_tokens,diagnostic_tokens,retry_tokens,cache_tokens";

function record(overrides: Partial<FailureRecord> = {}): FailureRecord {
  return {
    taskId: "task-1",
    type: "coder",
    phase: "implement",
    failedAt: "2026-08-26T00:00:00Z",
    fixedAt: "2026-08-26T01:00:00Z",
    status: "fixed",
    reason: "timeout",
    totalTokens: 100,
    diagnosticTokens: 10,
    retryTokens: 20,
    cacheTokens: 5,
    ...overrides,
  } as FailureRecord;
}

describe("buildFailureCsv", () => {
  it("tuščias sąrašas grąžina tik antraštę, be duomenų eilučių", () => {
    expect(buildFailureCsv([])).toBe(`"${HEADER.split(",").join('","')}"`);
  });

  it("laukų tvarka stabili ir sutampa su specifikacija", () => {
    const csv = buildFailureCsv([]);
    const headerLine = csv.split("\n")[0];
    const fields = headerLine!.split(",").map((cell) => cell.replaceAll('"', ""));
    expect(fields).toEqual([
      "task_id", "type", "phase", "failed_at", "fixed_at", "status", "reason",
      "incident_tokens", "diagnostic_tokens", "retry_tokens", "cache_tokens",
    ]);
  });

  it("kablelis lauko viduje ekranuojamas quoted lauku", () => {
    const csv = buildFailureCsv([record({ reason: "a,b" })]);
    const dataLine = csv.split("\n")[1];
    expect(dataLine).toContain('"a,b"');
  });

  it("kabutės lauko viduje dvigubinamos ir laukas lieka quoted", () => {
    const csv = buildFailureCsv([record({ reason: 'say "hi"' })]);
    const dataLine = csv.split("\n")[1];
    expect(dataLine).toContain('"say ""hi"""');
  });

  it("naujos eilutės lauko viduje ekranuojamos pagal CSV taisykles", () => {
    const csv = buildFailureCsv([record({ reason: "line1\nline2" })]);
    const dataLine = csv.split("\n").slice(1).join("\n");
    expect(dataLine).toContain('"line1\nline2"');
  });

  it("visi laukai visada quoted, net be specialiųjų simbolių", () => {
    const csv = buildFailureCsv([record({ taskId: "task-1" })]);
    const dataLine = csv.split("\n")[1];
    expect(dataLine!.startsWith('"task-1"')).toBe(true);
  });

  it.each(["=", "+", "-", "@"])(
    "formula-injection hardening: laukas prasidedantis '%s' gauna ' prefiksą",
    (prefix) => {
      const csv = buildFailureCsv([record({ reason: `${prefix}cmd|calc` })]);
      const dataLine = csv.split("\n")[1];
      expect(dataLine).toContain(`"'${prefix}cmd|calc"`);
    },
  );

  it("formula-injection prefiksas taikomas nepriklausomai nuo lauko pozicijos (taskId ir reason)", () => {
    const csv = buildFailureCsv([record({ taskId: "=SUM(A1)", reason: "@cmd" })]);
    const dataLine = csv.split("\n")[1];
    expect(dataLine).toContain(`"'=SUM(A1)"`);
    expect(dataLine).toContain(`"'@cmd"`);
  });

  it("simbolis viduje (ne pradžioje) NEGAUNA prefikso", () => {
    const csv = buildFailureCsv([record({ reason: "a=b" })]);
    const dataLine = csv.split("\n")[1];
    expect(dataLine).toContain('"a=b"');
    expect(dataLine).not.toContain("'a=b");
  });

  it("undefined reikšmė laukui virsta tuščiu string, ne 'undefined' tekstu", () => {
    const csv = buildFailureCsv([record({ fixedAt: undefined })]);
    const dataLine = csv.split("\n")[1];
    expect(dataLine).not.toContain("undefined");
    // fixed_at yra penktas laukas (indeksas 4) — turi virsti tuščiu quoted lauku `""`.
    const cells = dataLine!.split(",");
    expect(cells[4]).toBe('""');
  });

  it("keli įrašai virsta keliomis eilutėmis, tvarka išsaugoma", () => {
    const csv = buildFailureCsv([
      record({ taskId: "task-1" }),
      record({ taskId: "task-2" }),
    ]);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]!.startsWith('"task-1"')).toBe(true);
    expect(lines[2]!.startsWith('"task-2"')).toBe(true);
  });

  it("skaitiniai laukai (token kiekiai) paverčiami į string ir citated", () => {
    const csv = buildFailureCsv([record({ totalTokens: 100, diagnosticTokens: 10, retryTokens: 20, cacheTokens: 5 })]);
    const dataLine = csv.split("\n")[1];
    expect(dataLine).toContain('"100"');
    expect(dataLine).toContain('"10"');
    expect(dataLine).toContain('"20"');
    expect(dataLine).toContain('"5"');
  });
});
