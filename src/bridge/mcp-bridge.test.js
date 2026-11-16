import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  UnrealIndexBridge,
  createHttpApp,
  buildAllowedHosts,
  readGatewayToken,
  isAuthorized,
  isAuthDisabled,
  routingFromConfig,
  MIN_TOKEN_LENGTH
} from './mcp-bridge.js';

const TOKEN = randomBytes(24).toString('hex');

// ── Stub workspace services (record every upstream request) ──

const upstreamRequests = [];

function startStub(name, { hangOn = null } = {}) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      upstreamRequests.push({ stub: name, method: req.method, url: req.url, headers: { ...req.headers } });
      if (hangOn && req.url.startsWith(hangOn)) return; // never answer
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stub: name, url: req.url, index: { complete: true, reasons: [] } }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

let stubs;
let routing;
let gateway;
let gatewayPort;

before(async () => {
  stubs = {
    alpha: await startStub('alpha'),
    beta: await startStub('beta'),
    slow: await startStub('slow', { hangOn: '/grep' })
  };
  routing = {
    urls: new Map(Object.entries(stubs).map(([k, v]) => [k, v.url])),
    defaultWorkspace: 'alpha',
    source: 'file'
  };
  const allowedHosts = new Set(['placeholder']);
  const app = createHttpApp({ token: TOKEN, routing, allowedHosts, statusPointer: 'status.json on the index host' });
  gateway = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gatewayPort = gateway.address().port;
  allowedHosts.clear();
  for (const h of buildAllowedHosts('127.0.0.1', gatewayPort)) allowedHosts.add(h);
});

after(async () => {
  for (const s of [gateway, ...Object.values(stubs).map(x => x.server)]) {
    s.closeAllConnections();
    await new Promise(resolve => s.close(resolve));
  }
});

// ── Request helpers ──────────────────────────────────────────

function rawRequest({ method = 'POST', path = '/mcp', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: gatewayPort,
      method,
      path,
      headers: { host: `127.0.0.1:${gatewayPort}`, ...headers }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const mcpHeaders = (token = TOKEN) => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  ...(token ? { authorization: `Bearer ${token}` } : {})
});

let rpcId = 0;
function rpc(method, params, token = TOKEN) {
  return rawRequest({ headers: mcpHeaders(token), body: { jsonrpc: '2.0', id: ++rpcId, method, params } });
}

async function callTool(name, args) {
  const res = await rpc('tools/call', { name, arguments: args });
  assert.equal(res.status, 200, res.text);
  return res.json.result;
}

async function listToolsInMemory(mode) {
  const bridge = new UnrealIndexBridge({ mode, routing });
  bridge.setupHandlers();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await bridge.server.connect(serverTransport);
  const client = new Client({ name: 'parity-test', version: '1.0.0' });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

// ── Token handling ───────────────────────────────────────────

test('readGatewayToken refuses empty, short and whitespace tokens without echoing them', () => {
  assert.throws(() => readGatewayToken({}), /refusing to start without auth/);
  const short = 'abc123';
  assert.throws(() => readGatewayToken({ UNREAL_INDEX_TOKEN: short }), err => {
    assert.match(err.message, new RegExp(`shorter than ${MIN_TOKEN_LENGTH}`));
    assert.ok(!err.message.includes(short));
    return true;
  });
  assert.throws(() => readGatewayToken({ UNREAL_INDEX_TOKEN: `${TOKEN} ${TOKEN}` }), /whitespace/);
  assert.equal(readGatewayToken({ UNREAL_INDEX_TOKEN: `  ${TOKEN}\n` }), TOKEN);
});

test('readGatewayToken reads UNREAL_INDEX_TOKEN_FILE and env wins over the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ue-index-token-'));
  try {
    const file = join(dir, 'token.txt');
    writeFileSync(file, `${TOKEN}\r\n`);
    assert.equal(readGatewayToken({ UNREAL_INDEX_TOKEN_FILE: file }), TOKEN);
    const other = 'z'.repeat(MIN_TOKEN_LENGTH);
    assert.equal(readGatewayToken({ UNREAL_INDEX_TOKEN: other, UNREAL_INDEX_TOKEN_FILE: file }), other);
    assert.throws(() => readGatewayToken({ UNREAL_INDEX_TOKEN_FILE: join(dir, 'missing.txt') }), /cannot read UNREAL_INDEX_TOKEN_FILE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createHttpApp refuses a short token and an empty routing table', () => {
  assert.throws(() => createHttpApp({ token: 'short', routing, allowedHosts: new Set(['x']) }), /at least/);
  const empty = { urls: new Map(), defaultWorkspace: null, source: 'file' };
  assert.throws(() => createHttpApp({ token: TOKEN, routing: empty, allowedHosts: new Set(['x']) }), /at least one workspace/);
});

test('isAuthorized accepts only an exact Bearer token', () => {
  assert.equal(isAuthorized(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(isAuthorized(`bearer ${TOKEN}`, TOKEN), true);
  assert.equal(isAuthorized(`Bearer ${TOKEN}x`, TOKEN), false);
  assert.equal(isAuthorized(`Basic ${TOKEN}`, TOKEN), false);
  assert.equal(isAuthorized(undefined, TOKEN), false);
  assert.equal(isAuthorized(`Bearer ${TOKEN}`, ''), false);
});

// ── HTTP surface ─────────────────────────────────────────────

test('GET /health is open and minimal', async () => {
  const res = await rawRequest({ method: 'GET', path: '/health' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true, mode: 'http', workspaces: ['alpha', 'beta', 'slow'] });
});

test('POST /mcp without, with a wrong, or with a non-Bearer token is 401', async () => {
  for (const authorization of [undefined, `Bearer ${'0'.repeat(48)}`, `Basic ${TOKEN}`]) {
    const headers = mcpHeaders(null);
    if (authorization) headers.authorization = authorization;
    const res = await rawRequest({ headers, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert.equal(res.status, 401);
    assert.equal(res.headers['www-authenticate'], 'Bearer');
    assert.equal(res.json.error.message, 'Unauthorized');
  }
});

test('UNREAL_INDEX_AUTH=off serves /mcp without any Authorization header', async () => {
  assert.equal(isAuthDisabled({ UNREAL_INDEX_AUTH: ' OFF ' }), true);
  assert.equal(isAuthDisabled({}), false);
  assert.equal(isAuthDisabled({ UNREAL_INDEX_TOKEN: TOKEN }), false);
  const hosts = new Set(['placeholder']);
  const open = createHttpApp({ token: '', authDisabled: true, routing, allowedHosts: hosts });
  const srv = await new Promise(resolve => { const s = open.listen(0, '127.0.0.1', () => resolve(s)); });
  const savedPort = gatewayPort;
  gatewayPort = srv.address().port;
  for (const h of buildAllowedHosts('127.0.0.1', gatewayPort)) hosts.add(h);
  try {
    const res = await rawRequest({ headers: mcpHeaders(null), body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert.equal(res.status, 200);
  } finally {
    gatewayPort = savedPort;
    srv.closeAllConnections();
    await new Promise(resolve => srv.close(resolve));
  }
});

test('only POST /mcp and GET /health are served', async () => {
  assert.equal((await rawRequest({ method: 'GET', path: '/mcp', headers: mcpHeaders() })).status, 405);
  assert.equal((await rawRequest({ method: 'DELETE', path: '/mcp', headers: mcpHeaders() })).status, 405);
  assert.equal((await rawRequest({ method: 'GET', path: '/mcp' })).status, 401);
  for (const [method, path] of [
    ['GET', '/internal/config'], ['POST', '/internal/heartbeat'], ['POST', '/refresh'],
    ['GET', '/find-type?name=AActor'], ['GET', '/mcp/x'], ['POST', '/register']
  ]) {
    const res = await rawRequest({ method, path, headers: mcpHeaders() });
    assert.equal(res.status, 404, `${method} ${path}`);
  }
  assert.ok(!upstreamRequests.some(r => r.url.startsWith('/internal/config') || r.url.startsWith('/refresh')));
});

test('foreign Host and any Origin are refused', async () => {
  const badHost = await rawRequest({ headers: { ...mcpHeaders(), host: 'evil.example:3850' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  assert.equal(badHost.status, 403);
  const healthBadHost = await rawRequest({ method: 'GET', path: '/health', headers: { host: 'evil.example' } });
  assert.equal(healthBadHost.status, 403);
  const badOrigin = await rawRequest({ headers: { ...mcpHeaders(), origin: 'http://evil.example' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  assert.equal(badOrigin.status, 403);
});

test('buildAllowedHosts covers loopback, the bind host and extras', () => {
  const hosts = buildAllowedHosts('192.168.1.5', 3850, 'Scott-Server, scott-server.lan:3850');
  for (const h of ['127.0.0.1:3850', 'localhost:3850', '[::1]:3850', '192.168.1.5:3850', 'scott-server:3850', 'scott-server.lan:3850']) {
    assert.ok(hosts.has(h), h);
  }
  assert.ok(!buildAllowedHosts('0.0.0.0', 3850).has('0.0.0.0:3850'));
});

test('request bodies over 1 MB are rejected with 413', async () => {
  const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(1024 * 1024 + 10) } });
  const res = await rawRequest({ headers: mcpHeaders(), body: big });
  assert.equal(res.status, 413);
});

// ── MCP behaviour ────────────────────────────────────────────

test('tools/list over HTTP equals stdio minus unreal_refresh_index, with workspace required', async () => {
  const res = await rpc('tools/list', {});
  assert.equal(res.status, 200, res.text);
  const httpTools = res.json.result.tools;
  const stdioTools = await listToolsInMemory('stdio');

  const stdioNames = stdioTools.map(t => t.name).sort();
  const httpNames = httpTools.map(t => t.name).sort();
  assert.ok(stdioNames.includes('unreal_refresh_index'));
  assert.deepEqual(httpNames, stdioNames.filter(n => n !== 'unreal_refresh_index'));

  // Identical schemas apart from the workspace field (description + required).
  const normalize = tool => {
    const copy = structuredClone(tool);
    delete copy.inputSchema.properties.workspace.description;
    copy.inputSchema.required = (copy.inputSchema.required || []).filter(r => r !== 'workspace');
    if (copy.inputSchema.required.length === 0) delete copy.inputSchema.required;
    return copy;
  };
  for (const httpTool of httpTools) {
    assert.ok(httpTool.inputSchema.required.includes('workspace'), `${httpTool.name} requires workspace`);
    const stdioTool = stdioTools.find(t => t.name === httpTool.name);
    assert.deepEqual(normalize(httpTool), normalize(stdioTool), httpTool.name);
  }
});

test('tools/call routes by workspace to the matching loopback service', async () => {
  for (const ws of ['alpha', 'beta']) {
    const result = await callTool('unreal_find_type', { name: 'AActor', workspace: ws });
    assert.equal(result.isError, undefined);
    assert.equal(JSON.parse(result.content[0].text).stub, ws);
  }
  assert.ok(upstreamRequests.some(r => r.stub === 'beta' && r.url.startsWith('/find-type?name=AActor')));
});

test('workspace is required and must be a configured name', async () => {
  // Ignore late fire-and-forget analytics posts from earlier tests.
  const queries = () => upstreamRequests.filter(r => !r.url.startsWith('/internal/mcp-tool-call')).length;
  const before = queries();
  const missing = await callTool('unreal_find_type', { name: 'AActor' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /"workspace" is required/);
  const unknown = await callTool('unreal_find_type', { name: 'AActor', workspace: 'nope' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Unknown workspace "nope"/);
  const proto = await callTool('unreal_find_type', { name: 'AActor', workspace: '__proto__' });
  assert.equal(proto.isError, true);
  assert.equal(queries(), before, 'no upstream call for rejected workspaces');
});

test('unreal_refresh_index is refused over HTTP and never reaches the service', async () => {
  const result = await callTool('unreal_refresh_index', { workspace: 'alpha' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /mirror-owned/);
  assert.match(result.content[0].text, /status\.json on the index host/);
  assert.ok(!upstreamRequests.some(r => r.url.startsWith('/refresh')));
});

test('upstream calls time out instead of hanging', async () => {
  const prev = process.env.UNREAL_INDEX_UPSTREAM_TIMEOUT_MS;
  process.env.UNREAL_INDEX_UPSTREAM_TIMEOUT_MS = '300';
  try {
    const result = await callTool('unreal_grep', { pattern: 'Foo', workspace: 'slow' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /timed out after 300 ms/);
  } finally {
    if (prev === undefined) delete process.env.UNREAL_INDEX_UPSTREAM_TIMEOUT_MS;
    else process.env.UNREAL_INDEX_UPSTREAM_TIMEOUT_MS = prev;
  }
});

test('resources over HTTP are per-workspace and require a workspace', async () => {
  const list = await rpc('resources/list', {});
  const uris = list.json.result.resources.map(r => r.uri);
  assert.ok(uris.includes('unreal://index/status?workspace=beta'));
  const read = await rpc('resources/read', { uri: 'unreal://index/status?workspace=beta' });
  assert.equal(JSON.parse(read.json.result.contents[0].text).stub, 'beta');
  const noWs = await rpc('resources/read', { uri: 'unreal://index/status' });
  assert.match(JSON.parse(noWs.json.result.contents[0].text).error, /"workspace" is required/);
});

test('HTTP instructions describe remote mirror paths, not local Read', async () => {
  const init = await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0.0' }
  });
  const instructions = init.json.result.instructions;
  assert.match(instructions, /project-relative mirror paths/);
  assert.match(instructions, /index\.complete/);
  assert.doesNotMatch(instructions, /Default workspace/);
});

test('the SDK Streamable HTTP client connects with the bearer and lists tools', async () => {
  const client = new Client({ name: 'sdk-client-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } }
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.some(t => t.name === 'unreal_grep'));
  await client.close();
});

test('the gateway bearer is never forwarded to workspace services', async () => {
  // Wait briefly for fire-and-forget analytics posts to land.
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(upstreamRequests.length > 0);
  for (const r of upstreamRequests) {
    assert.equal(r.headers.authorization, undefined, `${r.method} ${r.url}`);
    assert.ok(!JSON.stringify(r.headers).includes(TOKEN), `${r.method} ${r.url}`);
    assert.ok(!r.url.includes(TOKEN));
  }
});

// ── Routing table ────────────────────────────────────────────

test('routingFromConfig builds loopback URLs and skips invalid ports', () => {
  const r = routingFromConfig({
    defaultWorkspace: 'b',
    workspaces: { a: { port: 3861 }, b: { port: '3862' }, bad: { port: 'x' }, worse: { port: 70000 } }
  });
  assert.deepEqual([...r.urls.entries()], [['a', 'http://127.0.0.1:3861'], ['b', 'http://127.0.0.1:3862']]);
  assert.equal(r.defaultWorkspace, 'b');
});

test('stdio mode keeps the default workspace and exposes unreal_refresh_index', async () => {
  const tools = await listToolsInMemory('stdio');
  const refresh = tools.find(t => t.name === 'unreal_refresh_index');
  assert.ok(refresh);
  assert.equal(refresh.inputSchema.required, undefined);
  assert.match(refresh.inputSchema.properties.workspace.description, /Default: "alpha"/);
});

test('tool descriptions are generic: no hard-coded Embark project names, project filters point at unreal_list_modules', async () => {
  const tools = await listToolsInMemory('stdio');
  const text = JSON.stringify(tools);
  assert.doesNotMatch(text, /Discovery|Pioneer/);
  const projectFilters = tools.flatMap(t => {
    const props = t.inputSchema.properties || {};
    return props.project ? [props.project.description] : [];
  });
  assert.ok(projectFilters.length > 0);
  assert.ok(projectFilters.some(d => /unreal_list_modules/.test(d)));
  for (const d of projectFilters) assert.ok(d === 'Filter by project' || /unreal_list_modules/.test(d), d);
});

test('unreal_refresh_index description states it only reindexes host-visible paths', async () => {
  const tools = await listToolsInMemory('stdio');
  const refresh = tools.find(t => t.name === 'unreal_refresh_index');
  assert.match(refresh.description, /only the paths the index service itself can see/);
});
