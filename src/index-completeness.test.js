// Index-completeness signal (DEC-2671): every query route must report whether
// an empty result is a verified zero (complete: true) or an index gap
// (complete: false + reasons).
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from './service/api.js';

const READY_AT = '2026-08-20T10:00:00.000Z';

async function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function getJson(url) {
  const res = await fetch(url);
  return { status: res.status, data: await res.json() };
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, data: await res.json() };
}

// The status getters are read live so a test can change index state after the
// app is built.
function makeDatabase({ indexStatus, isEmpty }) {
  const db = {
    prepare() {
      return {
        all() { return []; },
        get() { return { count: 0, min_path: null, max_path: null }; },
        run() { return { changes: 0 }; }
      };
    }
  };
  return {
    db,
    projectExists() { return true; },
    getDistinctProjects() { return []; },
    getMetadata() { return null; },
    getAllIndexStatus() { return indexStatus(); },
    isEmpty() { return isEmpty(); },
    _logSlowQuery() {},
    // Query methods used by the routes under test
    findTypeByName() { return []; },
    findMember() { return []; },
    findFileByName() { return []; },
    listModules() { return []; }
  };
}

describe('index completeness block (DEC-2671)', () => {
  let app;
  let server;
  let port;
  let zoektStatus;
  let indexStatus;
  let dbEmpty;

  async function build() {
    const database = makeDatabase({
      indexStatus: () => indexStatus,
      isEmpty: () => dbEmpty
    });
    const indexer = { isIndexing: false, config: { watcher: {} } };
    const zoektManager = {
      getStatus() { return zoektStatus; },
      isAvailable() { return zoektStatus.running; }
    };
    app = createApi(database, indexer, null, { zoektManager });
    server = await startServer(app);
    port = server.address().port;
  }

  // Register an active watcher so 'no-active-watcher' does not fire by default.
  async function heartbeat(watcherId = 'test-watcher') {
    await postJson(`http://127.0.0.1:${port}/internal/heartbeat`, { watcherId });
  }

  beforeEach(async () => {
    zoektStatus = { running: true, available: true, indexing: false };
    indexStatus = [{ language: 'angelscript', status: 'ready', last_updated: READY_AT }];
    dbEmpty = false;
    await build();
    await heartbeat();
  });

  afterEach(() => {
    if (app?._depthDebounceTimer) clearTimeout(app._depthDebounceTimer);
    if (app?._watcherPruneInterval) clearInterval(app._watcherPruneInterval);
    if (server) server.close();
  });

  it('reports complete: true with an empty result when the index is healthy', async () => {
    const { status, data } = await getJson(`http://127.0.0.1:${port}/find-type?name=NoSuchType`);
    assert.equal(status, 200);
    assert.deepEqual(data.results, []);
    assert.ok(data.index, 'response carries an index block');
    assert.equal(data.index.complete, true);
    assert.deepEqual(data.index.reasons, []);
    assert.equal(data.index.lastIndexTime, READY_AT);
  });

  it('reports complete: false with a reason when Zoekt is not running', async () => {
    zoektStatus = { running: false, available: false, indexing: false };
    const { status, data } = await getJson(`http://127.0.0.1:${port}/find-type?name=NoSuchType`);
    assert.equal(status, 200);
    assert.equal(data.index.complete, false);
    assert.ok(Array.isArray(data.index.reasons) && data.index.reasons.length > 0);
    assert.ok(data.index.reasons.includes('zoekt-not-running'), `reasons: ${data.index.reasons}`);
    // lastIndexTime is still reported when known, even while incomplete
    assert.equal(data.index.lastIndexTime, READY_AT);
  });

  it('reports indexing-in-progress while a language index is building', async () => {
    indexStatus = [{ language: 'angelscript', status: 'indexing', last_updated: READY_AT }];
    const { data } = await getJson(`http://127.0.0.1:${port}/find-type?name=NoSuchType`);
    assert.equal(data.index.complete, false);
    assert.ok(data.index.reasons.includes('indexing-in-progress'), `reasons: ${data.index.reasons}`);
    // no 'ready' row and no lastBuild → no known index time
    assert.equal(data.index.lastIndexTime, null);
  });

  it('reports never-indexed only when nothing has been indexed at all', async () => {
    indexStatus = [];
    dbEmpty = true;
    const { data } = await getJson(`http://127.0.0.1:${port}/find-type?name=NoSuchType`);
    assert.equal(data.index.complete, false);
    assert.ok(data.index.reasons.includes('never-indexed'), `reasons: ${data.index.reasons}`);
    assert.equal(data.index.lastIndexTime, null);
  });

  it('does not report never-indexed for a populated index with no recorded build', async () => {
    indexStatus = [];
    dbEmpty = false;
    const { data } = await getJson(`http://127.0.0.1:${port}/find-type?name=NoSuchType`);
    assert.equal(data.index.reasons.includes('never-indexed'), false, `reasons: ${data.index.reasons}`);
  });

  it('attaches the index block to /find-member, /find-file and /list-modules', async () => {
    for (const path of ['/find-member?name=Foo', '/find-file?filename=Foo.as', '/list-modules']) {
      const { status, data } = await getJson(`http://127.0.0.1:${port}${path}`);
      assert.equal(status, 200, path);
      assert.ok(data.index, `${path} carries an index block`);
      assert.equal(typeof data.index.complete, 'boolean', path);
      assert.ok(Array.isArray(data.index.reasons), path);
      assert.ok('lastIndexTime' in data.index, path);
    }
  });

  it('gives every /batch sub-result its own index block', async () => {
    const { status, data } = await postJson(`http://127.0.0.1:${port}/batch`, {
      queries: [
        { method: 'findTypeByName', args: ['NoSuchType', {}] },
        { method: 'notAllowed', args: [] }
      ]
    });
    assert.equal(status, 200);
    assert.equal(data.results.length, 2);
    assert.equal(data.index.complete, true);
    for (const sub of data.results) {
      assert.ok(sub.index, 'sub-result carries an index block');
      assert.equal(sub.index.complete, true);
      assert.deepEqual(sub.index.reasons, []);
      assert.equal(sub.index.lastIndexTime, READY_AT);
    }
  });

  it('reports no-active-watcher once the watcher stops heartbeating', async () => {
    // Ask the watcher to stop; its next heartbeat is consumed as a shutdown and
    // removes it from the active set.
    await postJson(`http://127.0.0.1:${port}/internal/stop-watcher`, { watcherId: 'test-watcher' });
    await heartbeat();
    const { data } = await getJson(`http://127.0.0.1:${port}/find-type?name=NoSuchType`);
    assert.equal(data.index.complete, false);
    assert.ok(data.index.reasons.includes('no-active-watcher'), `reasons: ${data.index.reasons}`);
  });
});
