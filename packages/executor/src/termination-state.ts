export type DiscoAbortCause = 'coordinator_termination' | 'sdk_health_failure';

const abortCauses = new WeakMap<AbortController, DiscoAbortCause>();

export function markDiscoAbortCause(controller: AbortController, cause: DiscoAbortCause): void {
  abortCauses.set(controller, cause);
}

export function hasDiscoAbortCause(controller: AbortController, cause: DiscoAbortCause): boolean {
  return abortCauses.get(controller) === cause;
}

/** Mark an abort whose terminal task transition is owned by the daemon coordinator. */
export function markCoordinatorTerminationAbort(controller: AbortController): void {
  markDiscoAbortCause(controller, 'coordinator_termination');
}

export function isCoordinatorTerminationAbort(controller: AbortController): boolean {
  return hasDiscoAbortCause(controller, 'coordinator_termination');
}

/** Whether a daemon workflow, rather than the executor fail-safe, owns terminality. */
export function isDaemonOwnedAbort(controller: AbortController): boolean {
  return abortCauses.has(controller);
}
