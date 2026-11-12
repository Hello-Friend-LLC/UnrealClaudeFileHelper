import test from 'node:test';
import assert from 'node:assert/strict';
import { createReconcileState } from './reconcile-state.js';

function clock() {
  let n = 0;
  return () => `t${++n}`;
}

test('reconcile state starts empty: no fabricated "now"', () => {
  const state = createReconcileState(clock());
  assert.deepEqual(state.snapshot(), {
    lastRunAt: null,
    lastStartedAt: null,
    lastSucceededAt: null,
    nextRunAt: null
  });
});

test('a started-but-failed run moves lastStartedAt only', () => {
  const state = createReconcileState(clock());
  state.markStarted();
  const snap = state.snapshot('next');
  assert.equal(snap.lastStartedAt, 't1');
  assert.equal(snap.lastSucceededAt, null);
  assert.equal(snap.lastRunAt, null);
  assert.equal(snap.nextRunAt, 'next');
});

test('a successful run sets lastSucceededAt and the lastRunAt alias', () => {
  const state = createReconcileState(clock());
  state.markStarted();
  state.markSucceeded();
  state.markStarted();
  const snap = state.snapshot();
  assert.equal(snap.lastStartedAt, 't3');
  assert.equal(snap.lastSucceededAt, 't2');
  assert.equal(snap.lastRunAt, 't2');
});
