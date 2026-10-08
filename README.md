# embark-claude-index

Fast code search for Unreal Engine projects in Claude Code.

## What it does

- **11 MCP tools** for searching types, members, files, assets, and code
- Indexes **AngelScript, C++, Blueprints, and config files**
- Sub-20ms queries across 100K+ types and 600K+ members
- Full-text code search via Zoekt (optional)
- Offline asset search across 400K+ content assets

## Quick Install

> **HF fork:** on HF machines, `/hf-onboard` (phase 5c) does all of this:
> clones this fork, installs dependencies, sets `UNREAL_INDEX_DIR`,
> registers the marketplace and installs the plugin, and (with
> `--setup-ue-index-workspace`) creates the workspace, containers and
> watcher. The upstream `/embark-claude-index:setup` skill is removed in
> this fork because it cloned a second copy into
> `~/.claude/repos/embark-claude-index`.

### 1. Add the marketplace and install

In Claude Code, run:
```
/plugin marketplace add Hello-Friend-LLC/UnrealClaudeFileHelper
/plugin install embark-claude-index@embark-claude-index
```

Or use the interactive plugin manager:
```
/plugin
```

### 2. Restart Claude Code

Restart to load the plugin and MCP tools.

### 3. Run setup

Run `npm run setup` in the clone to open the web-based setup GUI at
`http://localhost:3846`. It handles dependencies, workspace and project-path
configuration, Docker containers, and the file watcher.

## Prerequisites

- **Node.js 20.18+** (22+ recommended) — for the watcher and MCP bridge
- **Docker Desktop** with WSL2 backend — the indexing service runs in Docker containers

## Architecture

```
┌─────────────────┐     POST /internal/ingest     ┌──────────────────┐
│  File Watcher    │ ──────────────────────────── │  Indexing Service │
│  (Windows)       │                               │  (Docker)        │
│  chokidar watch  │                               │  Express + SQLite │
└─────────────────┘                               │  In-memory index  │
                                                   │  Zoekt            │
                                                   └────────┬─────────┘
                                                            │ HTTP API
                                                   ┌────────┴─────────┐
                                                   │   MCP Bridge     │
                                                   │  (stdio ↔ HTTP)  │
                                                   └──────────────────┘
                                                            │
                                                   Claude Code reads
                                                   tools via MCP
```

Each workspace runs as its own Docker container with a dedicated port, SQLite database, and Zoekt index.

- **Setup GUI** (`http://localhost:3846`): Web UI for managing workspaces, configuring projects, and monitoring service health.
- **File Watcher** (`src/watcher/watcher-client.js`): Watches project directories for file changes, parses source files, and sends them to the service via HTTP. Use `--workspace <name>` to target a specific workspace.
- **Indexing Service** (`src/service/index.js`): Runs inside Docker. Stores data in SQLite, loads everything into memory for fast queries. Integrates with Zoekt for full-text search.
- **MCP Bridge** (`src/bridge/mcp-bridge.js`): Translates MCP tool calls from Claude Code into HTTP API calls, routing to the correct workspace container.

## MCP Tools

| Tool | Description |
|------|-------------|
| `unreal_find_type` | Find classes, structs, enums, delegates by name |
| `unreal_find_children` | Find all classes inheriting from a parent |
| `unreal_find_member` | Find functions, properties, enum values by name |
| `unreal_explain_type` | Get comprehensive type info (definition + members + children) |
| `unreal_find_file` | Find source files by filename |
| `unreal_find_asset` | Search 400K+ Unreal assets by name |
| `unreal_browse_module` | List types and files in a module/directory |
| `unreal_list_modules` | Discover code organization and module tree |
| `unreal_grep` | Full-text search across indexed source code |
| `unreal_refresh_index` | Rebuild the index on demand |
| `unreal_batch` | Execute multiple queries in a single call |

### Index completeness (`index` block)

Every query response (`/find-type`, `/find-member`, `/find-file`, `/find-asset`,
`/find-children`, `/explain-type`, `/browse-module`, `/list-modules`, `/grep`,
and `/batch` — including each `/batch` sub-result) carries a top-level `index`
block so a caller can tell an empty result that is trustworthy from one that
merely reflects an index gap:

```json
"index": { "complete": true, "reasons": [], "lastIndexTime": "2026-08-20T10:00:00.000Z" }
```

- `complete: true` — no results means **no such thing exists** in the indexed
  scope. This is the only state where an empty result is ground truth.
- `complete: false` — the index may not have been able to answer. `reasons` is
  non-empty and holds one or more of: `health-not-ok`, `zoekt-not-running`,
  `indexing-in-progress`, `no-active-watcher`, `never-indexed`.
- `lastIndexTime` — ISO-8601 timestamp of the last successful index run, or
  `null` when no run has been recorded.

Permanent scope limits (e.g. Blueprint bodies are binary and not text-indexable)
are *not* incompleteness — they never set `complete: false`.

## Configuration

Configuration is managed through the setup GUI (`npm run setup` or `http://localhost:3846`):

- **`workspaces.json`** — Defines workspaces (name, port, shared settings). See `workspaces.example.json`.
- **`workspace-configs/<name>.json`** — Per-workspace config with project paths and service settings.
- **`docker-compose.yml`** — Generated from `workspaces.json`, one service per workspace.

All three files are gitignored since they contain local paths. Run `npm run setup` to generate them.

Supported project languages: `angelscript`, `cpp`, `content` (assets), `config` (ini files).

## Troubleshooting

**Tools say "Unreal Index Service is not running"**
- Start containers: `docker compose up -d`
- Check health: `curl http://127.0.0.1:3847/health`
- View logs: `docker compose logs -f <workspace-name>`

**No results returned**
- Check that the file watcher is running and has completed initial indexing
- Open the setup GUI (`http://localhost:3846`) to verify project paths
- Try removing the `project` filter — it may not match your project names

**Setup GUI doesn't detect my project**
- Run `npm run setup` and add projects manually via the web UI
- Or copy `workspaces.example.json` to `workspaces.json` and edit by hand
