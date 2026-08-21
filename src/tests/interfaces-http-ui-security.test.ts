// VQ-503 (5/5-c) testai — UI serverio saugos riba ir klaidų atvaizdis. Svarbiausia, ką jie
// pin'ina: `Host` vartai atmeta viską, kas nėra loopback (DNS rebinding); token'as lyginamas
// pastovaus laiko palyginimu ir skirtingas ilgis nesukelia išimties; statinis kelias niekada
// neišeina už dist ribų; o VARTOTOJO klaida niekada nevirsta 500.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  UI_TOKEN_HEADER,
  createUiToken,
  hasValidApiToken,
  headerToken,
  isLoopbackHost,
  resolveStaticPath,
  responseHeaders,
  tokenMatches,
} from "../interfaces/http/ui-security.js";
import {
  FORBIDDEN_TOKEN_RESPONSE,
  INTERNAL_ERROR_RESPONSE,
  mapJsonBodyError,
  mapPolicyError,
  mapTaskTriageError,
  mapUploadError,
} from "../interfaces/http/ui-error-mapping.js";
import { InvalidUploadError, UploadTooLargeError } from "../interfaces/http/task-upload.js";
import {
  InvalidTaskReferenceError,
  TaskAuthorityError,
  TaskBucketConflictError,
  TaskNotFoundError,
} from "../interfaces/http/ui-task-actions.js";

test("isLoopbackHost: viskas, kas nėra loopback, atmetama", () => {
  assert.equal(isLoopbackHost("127.0.0.1:4173"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("[::1]:4173"), true);

  // DNS rebinding: domenas, rezolvuojamas į 127.0.0.1, per naršyklę pasiektų UI same-origin.
  assert.equal(isLoopbackHost("evil.example.com"), false);
  assert.equal(isLoopbackHost("127.0.0.1.evil.com"), false);
  assert.equal(isLoopbackHost("192.168.1.10:4173"), false);
  // `Host` privaloma HTTP/1.1 — jos nebuvimas nėra „turbūt loopback".
  assert.equal(isLoopbackHost(undefined), false);
  assert.equal(isLoopbackHost(""), false);
});

test("tokenMatches: skirtingas ilgis atmetamas be išimties, sutampantis — priimamas", () => {
  const token = createUiToken();
  assert.equal(token.length >= 40, true, "32 baitai base64url");
  assert.notEqual(token, createUiToken(), "kiekvienas startas turi savo paslaptį");

  assert.equal(tokenMatches(token, token), true);
  assert.equal(tokenMatches(`${token}x`, token), false);
  assert.equal(tokenMatches("", token), false);
  assert.equal(tokenMatches(undefined, token), false);
});

test("headerToken ir hasValidApiToken: masyvo antraštė paima pirmą įrašą", () => {
  const token = createUiToken();
  assert.equal(headerToken({ [UI_TOKEN_HEADER]: [token, "kitas"] }), token);
  assert.equal(headerToken({}), undefined);

  assert.equal(hasValidApiToken({ [UI_TOKEN_HEADER]: token }, token), true);
  assert.equal(hasValidApiToken({ [UI_TOKEN_HEADER]: "svetimas" }, token), false);
  assert.equal(hasValidApiToken({}, token), false);
});

test("responseHeaders: CSP ir sniffing apsauga eina su KIEKVIENU atsakymu", () => {
  const headers = responseHeaders("application/json; charset=utf-8");
  assert.equal(headers["content-type"], "application/json; charset=utf-8");
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["referrer-policy"], "no-referrer");
  // Dashboard'as renderina laisvą tekstą iš logų — riba tarp „rodoma" ir „vykdoma".
  assert.match(headers["content-security-policy"] ?? "", /script-src 'self'/);
  assert.match(headers["content-security-policy"] ?? "", /object-src 'none'/);
  assert.match(headers["content-security-policy"] ?? "", /frame-ancestors 'none'/);
});

test("resolveStaticPath: kelias niekada neišeina už dist ribų", () => {
  const dist = path.resolve("/repo/ui/dist");
  assert.equal(resolveStaticPath(dist, "/index.html"), path.join(dist, "index.html"));
  assert.equal(resolveStaticPath(dist, "/assets/app.js"), path.join(dist, "assets", "app.js"));
  assert.equal(resolveStaticPath(dist, "/"), dist);

  // Klasikinis path traversal: `resolve` sutraukia `..` leksiškai, bet be patikros rezultatas
  // vis tiek nurodytų svetimą failą.
  assert.equal(resolveStaticPath(dist, "/../../etc/passwd"), undefined);
  assert.equal(resolveStaticPath(dist, "/../dist-evil/app.js"), undefined);
});

test("mapUploadError: vartotojo klaida NIEKADA nevirsta 500", () => {
  assert.deepEqual(mapUploadError(new InvalidUploadError("Only Markdown files are allowed: a.txt")), {
    status: 400,
    body: { error: "Only Markdown files are allowed: a.txt" },
  });
  assert.deepEqual(mapUploadError(new UploadTooLargeError("Task file exceeds 512 KB: a.md")), {
    status: 413,
    body: { error: "Task file exceeds 512 KB: a.md" },
  });
  // Nežinoma klaida lieka generinė: detalės neatskleidžiamos.
  assert.deepEqual(mapUploadError(new Error("EACCES /repo/vq/state")), INTERNAL_ERROR_RESPONSE);
});

test("mapTaskTriageError: nuosavybės žinutė į klientą NEPERDUODAMA", () => {
  assert.equal(mapTaskTriageError(new InvalidTaskReferenceError("bloga nuoroda")).status, 400);
  assert.equal(mapTaskTriageError(new TaskNotFoundError("nėra")).status, 404);
  assert.equal(mapTaskTriageError(new TaskBucketConflictError("active", "svetimas bucket'as")).status, 409);

  const authority = mapTaskTriageError(new TaskAuthorityError("lease w1 pid=4242", "detalės su PID"));
  assert.equal(authority.status, 409);
  // Klientui pakanka žinoti, kad task'ą valdo workeris.
  assert.equal(authority.body?.error, "task is held by an active worker lease");
});

test("mapJsonBodyError ir mapPolicyError: kodai skiriasi pagal priežastį", () => {
  assert.equal(mapJsonBodyError(true).status, 413);
  assert.equal(mapJsonBodyError(false).status, 400);

  assert.equal(mapPolicyError("unsupported-file", "nepalaikomas failas").status, 400);
  assert.equal(mapPolicyError("not-approved", "dar nepatvirtinta").status, 409);
  // 403, ne 409: tai ne būsenos konfliktas, o atsisakymas suteikti teisę — UI nėra tas žmogus.
  assert.equal(mapPolicyError("human-review-required", "reikia žmogaus").status, 403);
  assert.deepEqual(mapPolicyError(undefined, "nežinoma"), INTERNAL_ERROR_RESPONSE);

  assert.equal(FORBIDDEN_TOKEN_RESPONSE.status, 403);
});
