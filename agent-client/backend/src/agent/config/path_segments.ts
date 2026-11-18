/**
 * The single validator for any identifier that becomes a path segment.
 *
 * Before this module there were four divergent validators: two throwing regex
 * checks, one silently rewriting sanitizer (`workspace_store.sanitizePathSegment`
 * turned `a/b` into `a_b`, i.e. into a *different* session directory), and one
 * frontend copy. Every path segment now goes through here.
 */
const PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;

export function isPathSegment(value: unknown): boolean {
  return typeof value === 'string' && PATH_SEGMENT.test(value);
}

/** Returns the validated segment or throws with a labelled message. */
export function assertPathSegment(value: unknown, label: string): string {
  const segment = String(value ?? '').trim();
  if (!PATH_SEGMENT.test(segment)) {
    throw new Error(`Invalid ${label}.`);
  }
  return segment;
}
