import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDockerEngineStatus,
  dockerEndpointCandidates,
  findWorkspaceContainer,
  formatBytes,
  healthOf,
  memoryFromStats,
} from './docker-engine-status.js';

describe('dockerEndpointCandidates', () => {
  it('prefers DOCKER_HOST npipe and converts it to a Windows pipe path', () => {
    assert.deepEqual(dockerEndpointCandidates({ DOCKER_HOST: 'npipe:////./pipe/docker_engine' }, 'win32'),
      [{ socketPath: '\\\\.\\pipe\\docker_engine' }]);
  });
  it('falls back to Docker Desktop pipes on Windows and the unix socket elsewhere', () => {
    assert.equal(dockerEndpointCandidates({}, 'win32').length, 2);
    assert.deepEqual(dockerEndpointCandidates({}, 'linux'), [{ socketPath: '/var/run/docker.sock' }]);
  });
  it('supports tcp DOCKER_HOST', () => {
    assert.deepEqual(dockerEndpointCandidates({ DOCKER_HOST: 'tcp://10.0.0.5:2376' }, 'linux'), [{ host: '10.0.0.5', port: 2376 }]);
  });
});

describe('formatting and parsing', () => {
  it('formats bytes like the docker CLI', () => {
    assert.equal(formatBytes(5368709120), '5GiB');
    assert.equal(formatBytes(291834265), '278.3MiB');
    assert.equal(formatBytes(512), '512B');
  });
  it('subtracts reclaimable cache from memory usage', () => {
    const mem = memoryFromStats({ memory_stats: { usage: 300 * 1048576, limit: 1024 * 1048576, stats: { inactive_file: 44 * 1048576 } } });
    assert.deepEqual(mem, { memUsage: '256MiB / 1GiB', memLimit: '1GiB', memPercent: 25 });
    assert.equal(memoryFromStats({ memory_stats: {} }), null);
  });
  it('maps health to docker compose vocabulary', () => {
    assert.equal(healthOf({ Health: { Status: 'healthy' } }), 'healthy');
    assert.equal(healthOf({ Health: { Status: 'none' } }), '');
    assert.equal(healthOf({ Status: 'Up 3 seconds (health: starting)' }), 'starting');
    assert.equal(healthOf({ Status: 'Exited (0) 2 minutes ago' }), '');
  });
  it('finds workspace containers by container_name, then compose service label', () => {
    const named = { Names: ['/unreal-index-prjefz'], Labels: {} };
    const labeled = { Names: ['/proj-tempnew-58-1'], Labels: { 'com.docker.compose.service': 'tempnew-58' } };
    assert.equal(findWorkspaceContainer([labeled, named], 'prjefz'), named);
    assert.equal(findWorkspaceContainer([labeled, named], 'tempnew-58'), labeled);
    assert.equal(findWorkspaceContainer([named], 'missing'), null);
  });
});

describe('createDockerEngineStatus', () => {
  const containers = [
    { Id: 'a1', Names: ['/unreal-index-prjefz'], State: 'running', Status: 'Up 1 minute (healthy)', Health: { Status: 'healthy' } },
    { Id: 'b2', Names: ['/unreal-index-tempnew-58'], State: 'exited', Status: 'Exited (0)' },
  ];
  const stats = { memory_stats: { usage: 512 * 1048576, limit: 2048 * 1048576, stats: { inactive_file: 0 } } };

  it('reports running/health/memory per workspace and falls through to the next endpoint', async () => {
    const calls = [];
    const get = async (endpoint, path) => {
      calls.push(`${endpoint.socketPath} ${path}`);
      if (endpoint.socketPath === 'first') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return path.startsWith('/containers/json') ? containers : stats;
    };
    const engine = createDockerEngineStatus({ candidates: [{ socketPath: 'first' }, { socketPath: 'second' }], get });
    const [prjefz, tempnew, missing] = await engine.getStatuses(['prjefz', 'tempnew-58', 'missing']);
    assert.deepEqual(prjefz, { running: true, health: 'healthy', memUsage: '512MiB / 2GiB', memLimit: '2GiB', memPercent: 25 });
    assert.equal(tempnew.running, false);
    assert.equal(tempnew.memUsage, null);
    assert.equal(missing.running, false);
    assert.ok(calls.includes('second /containers/a1/stats?stream=false&one-shot=true'));
    assert.ok(!calls.some(c => c.includes('b2')), 'no stats call for stopped containers');
  });

  it('throws when no endpoint answers so the caller can back off', async () => {
    const get = async () => { throw new Error('ENOENT'); };
    const engine = createDockerEngineStatus({ candidates: [{ socketPath: 'x' }], get });
    await assert.rejects(engine.getStatuses(['prjefz']));
  });
});
