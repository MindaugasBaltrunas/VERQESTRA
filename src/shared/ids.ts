// Generic branded ID primitive. No domain knowledge: callers supply their own brand tag
// (e.g. `Id<"TaskId">`) so distinct ID kinds cannot be assigned to each other by mistake.
//
// @internal/experimental (E1 decision): AG_loop has ZERO production importers of this
// module — it is migrated as a forward contract, and branding TaskId/RunId on top of it
// is a separate E2 decision, not an invitation.

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };
export type Id<B extends string> = Brand<string, B>;

/** Creates a branded id from a non-empty string. Throws on empty/whitespace-only input. */
export function createId<B extends string>(value: string): Id<B> {
  if (value.trim().length === 0) {
    throw new Error("id value must not be empty");
  }
  return value as Id<B>;
}

export function isNonEmptyId(value: string): boolean {
  return value.trim().length > 0;
}
