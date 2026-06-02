// In-memory health surface. Intentionally minimal — anything that wants to
// observe boot/runtime liveness drops a value here keyed by component, and
// readers (status endpoints, future probes) can pull the whole map.
//
// Not persisted, not gating. If we ever add a status endpoint this is the
// source it should read.

const state = new Map<string, unknown>();

export function recordHealth(key: string, value: unknown): void {
  state.set(key, value);
}

export function getHealth(key: string): unknown {
  return state.get(key);
}

export function snapshotHealth(): Record<string, unknown> {
  return Object.fromEntries(state.entries());
}
