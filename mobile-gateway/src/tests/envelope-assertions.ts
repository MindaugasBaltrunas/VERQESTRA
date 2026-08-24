import assert from "node:assert/strict";
import {
  GATEWAY_ERROR_CODES,
  GATEWAY_RECOVERABLE_BY_CODE,
  GATEWAY_STATUS_BY_CODE,
  type GatewayErrorCode,
} from "../interfaces/http/remote-gateway-router.js";

/**
 * One statement of the envelope rule, shared by every remote router test that
 * already holds a failed response.
 *
 * `api-contract-conformance.test.ts` pins the two tables against literal maps,
 * which makes them complete and stable. This is the other half: that the LIVE
 * router agrees with them. The code is read out of the response rather than
 * passed in, so the assertion cannot be weakened by a probe that expected the
 * wrong code — it compares the router against the tables, never against the
 * test's own guess.
 *
 * Coverage is not accumulated across files: `node --test` runs each test file in
 * its own process, so a module-level set of seen codes would prove nothing.
 * Completeness is asserted structurally in the conformance file instead.
 *
 * NUKRYPIMAS (formos, ne elgesio): voko laukai skaitomi per bracket —
 * `noPropertyAccessFromIndexSignature`. Vokas čia yra `Record<string, unknown>` būtent todėl,
 * kad tikrinama neįrodyta atsakymo forma.
 */
export function assertEnvelopeMatchesTables(
  response: { status: number; body: Readonly<Record<string, unknown>> },
  label: string,
): string {
  const error = response.body["error"] as Record<string, unknown> | undefined;
  assert.ok(error, `${label} must answer with an error envelope`);
  assert.deepEqual(
    Object.keys(error).sort(),
    ["code", "correlationId", "message", "recoverable"],
    `${label} must use exactly the contract error envelope fields`,
  );
  const code = error["code"];
  assert.ok(
    typeof code === "string" && (GATEWAY_ERROR_CODES as readonly string[]).includes(code),
    `${label} answered with undeclared error code ${String(code)}`,
  );
  const declared = code as GatewayErrorCode;
  assert.equal(
    response.status,
    GATEWAY_STATUS_BY_CODE[declared],
    `${label}: ${declared} must always answer ${GATEWAY_STATUS_BY_CODE[declared]}`,
  );
  assert.equal(
    error["recoverable"],
    GATEWAY_RECOVERABLE_BY_CODE[declared],
    `${label}: ${declared} must always report recoverable=${GATEWAY_RECOVERABLE_BY_CODE[declared]}`,
  );
  assert.match(String(error["correlationId"]), /^[0-9a-f-]{36}$/, label);
  assert.equal(typeof error["message"], "string", label);
  return declared;
}
