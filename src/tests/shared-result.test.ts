import assert from "node:assert/strict";
import test from "node:test";
import { andThen, err, isErr, isOk, map, mapErr, ok, unwrapOr, type Result } from "../shared/result.js";

test("ok/err carry their payloads and discriminate on the ok flag", () => {
  const success = ok(42);
  const failure = err("nope");
  assert.equal(success.ok, true);
  assert.equal(success.value, 42);
  assert.equal(failure.ok, false);
  assert.equal(failure.error, "nope");
  assert.ok(isOk(success));
  assert.ok(isErr(failure));
});

test("map transforms only the value; mapErr only the error", () => {
  const success: Result<number, string> = ok(2);
  const failure: Result<number, string> = err("bad");
  assert.deepEqual(map(success, (value: number) => value * 3), ok(6));
  assert.deepEqual(map(failure, (value: number) => value * 3), failure);
  assert.deepEqual(mapErr(failure, (error: string) => `${error}!`), err("bad!"));
  assert.deepEqual(mapErr(success, (error: string) => `${error}!`), success);
});

test("andThen chains with short-circuit; unwrapOr falls back only on Err", () => {
  const success: Result<number, string> = ok(2);
  const failure: Result<number, string> = err("bad");
  assert.deepEqual(andThen(success, (value: number) => (value > 1 ? ok(value + 1) : err("low"))), ok(3));
  assert.deepEqual(andThen(failure, () => ok(0)), failure);
  assert.equal(unwrapOr(success, 9), 2);
  assert.equal(unwrapOr(failure, 9), 9);
});
