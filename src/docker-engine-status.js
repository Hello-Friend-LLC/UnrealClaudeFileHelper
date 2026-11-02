// Workspace container status read straight from the Docker Engine API (named pipe on
// Windows, unix socket elsewhere) instead of shelling out to `docker compose ps` and
// `docker stats`. Polling through the CLI spawned several processes per workspace every
// cycle, and when a call timed out Node killed docker.exe but not the docker-compose.exe
// plugin it had launched; while the engine was down (logon, before Docker Desktop is up)
// those orphans piled up by the hundred. An HTTP request has nothing to orphan, and an
// absent pipe fails instantly with ENOENT.

import http from 'http';

const API_TIMEOUT_MS = 5000;

export function emptyServiceStatus() {
  return { running: false, health: '', memUsage: null, memLimit: null, memPercent: null };
}

// Candidate endpoints in preference order, as http.request options.
export function dockerEndpointCandidates(env = process.env, platform = process.platform) {
  const host = env.DOCKER_HOST || '';
  if (host.startsWith('npipe://')) return [{ socketPath: host.slice('npipe://'.length).replace(/\//g, '\\') }];
  if (host.startsWith('unix://')) return [{ socketPath: host.slice('unix://'.length) }];
  if (host.startsWith('tcp://')) {
    const url = new URL(host.replace(/^tcp:/, 'http:'));
    return [{ host: url.hostname, port: Number(url.port) || 2375 }];
  }
  if (platform === 'win32') {
    return [{ socketPath: '\\\\.\\pipe\\dockerDesktopLinuxEngine' }, { socketPath: '\\\\.\\pipe\\docker_engine' }];
  }
  return [{ socketPath: '/var/run/docker.sock' }];
}

function apiGet(endpoint, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ ...endpoint, path, timeout: API_TIMEOUT_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Docker API ${path}: HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Docker API ${path}: timeout`)));
    req.on('error', reject);
  });
}

// Same rendering as the docker CLI (go-units BytesSize, "%.4g"): 278.3MiB, 5GiB.
export function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${parseFloat(value.toPrecision(4))}${units[i]}`;
}

// Memory as `docker stats` reports it: usage minus reclaimable page cache.
export function memoryFromStats(stats) {
  const mem = stats?.memory_stats;
  if (!mem?.usage || !mem.limit) return null;
  const cache = mem.stats?.inactive_file ?? mem.stats?.total_inactive_file ?? 0;
  const used = cache < mem.usage ? mem.usage - cache : mem.usage;
  const percent = Math.round((used / mem.limit) * 10000) / 100;
  return { memUsage: `${formatBytes(used)} / ${formatBytes(mem.limit)}`, memLimit: formatBytes(mem.limit), memPercent: percent };
}

// Health in `docker compose ps` vocabulary: healthy | unhealthy | starting | ''.
export function healthOf(container) {
  const status = container.Health?.Status;
  if (status) return status === 'none' ? '' : status;
  const m = /\((healthy|unhealthy|health: starting)\)/.exec(container.Status || '');
  if (!m) return '';
  return m[1] === 'health: starting' ? 'starting' : m[1];
}

// Generated compose files set container_name unreal-index-<workspace>; the service label
// covers containers created without it.
export function findWorkspaceContainer(containers, workspaceName) {
  const byName = containers.find(c => (c.Names || []).includes(`/unreal-index-${workspaceName}`));
  return byName || containers.find(c => c.Labels?.['com.docker.compose.service'] === workspaceName) || null;
}

export function createDockerEngineStatus({ candidates = dockerEndpointCandidates(), get = apiGet } = {}) {
  let endpoint = null;

  async function listContainers() {
    const order = endpoint ? [endpoint, ...candidates.filter(c => c !== endpoint)] : candidates;
    let lastErr;
    for (const candidate of order) {
      try {
        const containers = await get(candidate, '/containers/json?all=1');
        endpoint = candidate;
        return containers;
      } catch (err) {
        lastErr = err;
      }
    }
    endpoint = null;
    throw lastErr || new Error('Docker engine unreachable');
  }

  // Throws when the engine is unreachable so the caller can back off.
  async function getStatuses(workspaceNames) {
    const containers = await listContainers();
    return Promise.all(workspaceNames.map(async (name) => {
      const result = emptyServiceStatus();
      const container = findWorkspaceContainer(containers, name);
      if (!container) return result;
      result.running = container.State === 'running';
      result.health = healthOf(container);
      if (result.running) {
        try {
          const mem = memoryFromStats(await get(endpoint, `/containers/${container.Id}/stats?stream=false&one-shot=true`));
          if (mem) Object.assign(result, mem);
        } catch { /* stats unavailable, non-critical */ }
      }
      return result;
    }));
  }

  return { getStatuses };
}
