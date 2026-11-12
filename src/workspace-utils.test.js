import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDockerComposeContent, validateComposeSync, ensureWorkspacesDefaults } from './workspace-utils.js';

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'ue-index-compose-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const wsConfig = () => ensureWorkspacesDefaults({
  workspaces: {
    prjefz: { port: 3861 },
    'tempnew-58': { port: 3863 }
  }
});

test('generated compose publishes every workspace on loopback only', () => withRoot(root => {
  const content = generateDockerComposeContent(wsConfig(), root);
  const portLines = content.split('\n').filter(l => /^\s+- "[\d.:]+"$/.test(l));
  assert.deepEqual(portLines.map(l => l.trim()), ['- "127.0.0.1:3861:3847"', '- "127.0.0.1:3863:3847"']);
  assert.doesNotMatch(content, /- "\d+:3847"/);
}));

test('regenerated compose is in sync and stays loopback', () => withRoot(root => {
  const cfg = wsConfig();
  writeFileSync(join(root, 'docker-compose.yml'), generateDockerComposeContent(cfg, root));
  const result = validateComposeSync(root, cfg);
  assert.equal(result.inSync, true);
  assert.match(result.expected, /127\.0\.0\.1:3861:3847/);
}));

test('an old all-interfaces compose is reported as a port drift', () => withRoot(root => {
  const cfg = wsConfig();
  const legacy = generateDockerComposeContent(cfg, root).replace(/"127\.0\.0\.1:(\d+):3847"/g, '"$1:3847"');
  writeFileSync(join(root, 'docker-compose.yml'), legacy);
  const result = validateComposeSync(root, cfg);
  assert.equal(result.inSync, false);
  assert.ok(result.diffs.some(d => d.includes("port for 'prjefz' differs: actual 3861:3847 vs expected 127.0.0.1:3861:3847")), result.diffs.join('; '));
}));
