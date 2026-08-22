/**
 * Writing into an isolated checkout.
 *
 * Only the deterministic control mode uses this: it produces its change by
 * applying a fixed script rather than by asking a model, so it needs to write
 * files without starting a process. The port exists so that the control mode
 * stays offline by construction — it is handed no process runner at all — and so
 * that path containment is one implementation rather than an assumption repeated
 * at each call site.
 */

export interface WorkspaceFileEdit {
  /**
   * Checkout-relative path, POSIX-separated. Absolute paths and any path that
   * leaves the checkout are refused, not resolved.
   */
  readonly path: string;
  readonly contents: string;
}

export interface WorkspaceFilePort {
  /**
   * Applies `edits` inside `worktreePath` and returns the paths written,
   * checkout-relative, POSIX-separated and sorted.
   *
   * Implementations refuse any edit that would land outside the checkout — via a
   * parent segment, an absolute path or a symbolic link — and refuse to write
   * into `.git`, which would let a fixture rewrite the history the sample is
   * measured against. A refusal throws: a control that could not apply its own
   * script produced no measurement, and reporting the write as done would make
   * the resulting empty diff read as the control's honest result.
   */
  apply(
    worktreePath: string,
    edits: readonly WorkspaceFileEdit[],
  ): Promise<readonly string[]>;
}
