// Reconciliation timestamps reported in the watcher heartbeat.
// lastStartedAt moves when a reconcile run (bootstrap or periodic) starts;
// lastSucceededAt (and its legacy alias lastRunAt) moves ONLY when a run
// finishes without error, so a failed run never looks fresh.

export function createReconcileState(now = () => new Date().toISOString()) {
  let lastStartedAt = null;
  let lastSucceededAt = null;

  return {
    markStarted() {
      lastStartedAt = now();
    },
    markSucceeded() {
      lastSucceededAt = now();
    },
    snapshot(nextRunAt = null) {
      return {
        lastRunAt: lastSucceededAt,
        lastStartedAt,
        lastSucceededAt,
        nextRunAt
      };
    }
  };
}
