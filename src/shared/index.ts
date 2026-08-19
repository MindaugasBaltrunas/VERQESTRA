// shared/ barrel — the ONLY sanctioned import path into this module (MOD-1).
// Seed content: the Result contract every layer speaks. The full shared
// primitives (errors, ids, json, markdown, hash, paths) arrive with wave E1,
// each rebuilt against its characterization fixtures — never copied blindly.

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}
