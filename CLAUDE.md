# embark-claude-index

MCP server plugin providing fast code navigation for Unreal Engine projects. Indexes AngelScript, C++, Blueprints, and assets.

This is an offline source/asset index (MCP server `unreal-index`, tools `unreal_*`). It does not talk to Unreal Editor. Live-editor work (actors, Blueprints, Live Coding) goes through Epic's `unreal-mcp` server (ModelContextProtocol plugin) or the project's editor MCP, not this plugin.

## Tool Instructions

The `unreal_*` MCP tools search the configured Unreal workspaces (AngelScript, C++, assets), not this repository's own Node.js code. In
UE projects prefer them for type/member/file/content lookups; confirm every hit against the local file before citing it. To search THIS
repo use normal file search (Read, Grep).

## Architecture

- **Docker-only deployment**: Each workspace runs as a Docker container with service + Zoekt + SQLite
- **Multi-workspace**: Multiple P4 workspaces can be indexed independently, each with its own container and port
- **Windows watcher** (`src/watcher/watcher-client.js`): Watches project files, parses them, POSTs to the service container
- **Docker service** (`src/service/index.js`): Express API, SQLite DB, in-memory query index, Zoekt — all inside the container
- **MCP bridge** (`src/bridge/mcp-bridge.js`): Routes MCP tool calls to the correct workspace container based on the `workspace` parameter
- **Setup GUI** (`src/setup-gui.js`): Web-based setup at `http://localhost:3846` — auto-detects UE projects, configures workspaces, manages Docker containers, installs hooks

### Key Files

- `workspaces.json` — Single source of truth for workspace definitions (name, port, shared settings)
- `workspace-configs/<name>.json` — Per-workspace config (projects, paths, service settings)
- `docker-compose.yml` — Generated from `workspaces.json`, one service per workspace

## Development

- `npm run setup` — Open the web-based setup GUI at `http://localhost:3846` (no npm install needed)
- `npm start [-- <workspace>]` — validate configs, regenerate `docker-compose.yml` if out of sync, start containers, print health (`npm run validate` / `npm run status` for config-only and health-only)
- `docker compose up` — Start all workspace containers
- `docker compose up <workspace>` — Start a specific workspace container
- `npm run watcher -- --workspace <name>` — Start the file watcher for a specific workspace
- `npm run bridge` — Start the MCP bridge standalone
- `npm test` — Run tests
