# Docker Deployment

Each workspace runs as its own Docker container with a dedicated port, SQLite database, and Zoekt index.

## Prerequisites

- Docker Desktop with WSL 2 backend (Windows) or Docker Engine (Linux)
- At least 4 GB of RAM per workspace (more for engine source or large content roots; see Memory Tuning)

## Quick Start

The easiest way to get started is the setup GUI:

```bash
npm run setup
# Opens http://localhost:3846
```

The GUI walks you through creating workspaces, building the Docker image, and starting containers.

For manual control:

```bash
# Build and start all workspaces
docker compose up -d

# Check status
docker compose ps
docker compose logs -f <workspace-name>
curl http://localhost:3847/health

# Stop all workspaces
docker compose stop
```

## Architecture

```
Windows Host                          Docker Containers (one per workspace)
┌──────────────────┐
│ Watcher(s)        │                 ┌──────────────────────────┐
│ (watcher-client)  │  HTTP POST     │  prjefz (:3847)           │
│ --workspace prjefz│───────────────►│  node service/index.js    │
│ --workspace <ws2> │  :3847/:3848   │  Express + SQLite + Zoekt │
│                   │                 │  Volumes:                 │
│ MCP Bridge        │  HTTP GET      │    unreal-index-prjefz-db  │
│ (mcp-bridge)      │───────────────►│    ...-prjefz-mirror       │
│                   │  routed by     │    ...-prjefz-zoekt        │
│                   │  workspace     └──────────────────────────┘
└──────────────────┘
                                      ┌──────────────────────────┐
                                      │  spacewastecollector      │
                                      │  (:3848)                  │
                                      │  node service/index.js    │
                                      │  Express + SQLite + Zoekt │
                                      │  Volumes:                 │
                                      │    unreal-index-<ws>-db    │
                                      │    ...-<ws>-mirror         │
                                      │    ...-<ws>-zoekt          │
                                      └──────────────────────────┘
```

Each container bundles Node.js 22, Zoekt (built from source), and the service code. Data is persisted in per-workspace Docker volumes named `unreal-index-<workspace-name>-db|mirror|zoekt`.

## Configuration

Configuration is managed through the setup GUI (`npm run setup` at `http://localhost:3846`), which generates:

- **`workspaces.json`** — Workspace definitions (name, port, shared settings)
- **`workspace-configs/<name>.json`** — Per-workspace config (project paths, service settings)
- **`docker-compose.yml`** — Generated Compose file with one service per workspace

To customize manually:

1. Copy `workspaces.example.json` to `workspaces.json` and edit
2. Create `workspace-configs/<name>.json` for each workspace
3. Run `npm run setup` to regenerate `docker-compose.yml`

Key per-workspace config values:
- `service.host`: Must be `"0.0.0.0"` for Docker port mapping
- `service.port`: `3847` inside the container (mapped to workspace-specific host port)
- `zoekt.parallelism`: `4` (reduce to `2` if memory is tight)

## Network exposure

The workspace service has no authentication, including its `/internal/*` control routes.
Generated `docker-compose.yml` files therefore publish every workspace on loopback only
(`"127.0.0.1:<port>:3847"`), and the setup GUI (whose `/api/service-proxy` forwards any
path) listens on `127.0.0.1:3846`. Regenerate an older compose file (`npm run setup`) to
pick up the loopback binding; `validateComposeSync` reports the old form as a port drift.

## HTTP MCP gateway

`node src/bridge/mcp-bridge.js --http` runs the bridge as a stateless Streamable HTTP MCP
server on the index host, in front of the loopback workspace services:

| Env | Meaning |
|-----|---------|
| `UNREAL_INDEX_TOKEN` or `UNREAL_INDEX_TOKEN_FILE` | Shared read-only bearer (file holds only the token). Required (at least 32 characters, never logged) unless `UNREAL_INDEX_AUTH=off`. |
| `UNREAL_INDEX_AUTH` | `off` serves `POST /mcp` with no Authorization header and ignores the token vars (trusted-LAN deployment; logs a warning at start). Default: bearer required. |
| `UNREAL_INDEX_HTTP_HOST` / `UNREAL_INDEX_HTTP_PORT` | Bind address (default `127.0.0.1`) and port (default `3850`). Bind the LAN IP explicitly, not `0.0.0.0`. |
| `UNREAL_INDEX_HTTP_ALLOWED_HOSTS` | Extra `Host` header values to accept (comma list), e.g. the server's DNS name. Loopback and the bind host are always allowed. |
| `UNREAL_INDEX_HTTP_ALLOWED_ORIGINS` | Browser origins to accept (comma list). Default none: any request with an `Origin` header is refused. |
| `UNREAL_INDEX_WORKSPACES_FILE` | Path to `workspaces.json` (default: repo root). The gateway refuses to start without at least one workspace. |
| `UNREAL_INDEX_UPSTREAM_TIMEOUT_MS` | Timeout for each call to a workspace service (default `60000`). |
| `UNREAL_INDEX_STATUS_POINTER` | Optional text appended to the `unreal_refresh_index` refusal, e.g. where the mirror status file lives. |

Surface: `POST /mcp` (bearer required unless `UNREAL_INDEX_AUTH=off`, 1 MB body cap) and an open, minimal `GET /health`
(`{ok, mode, workspaces}`); `GET`/`DELETE /mcp` are 405 and every other path is 404, so
`/internal/*`, `/refresh` and the raw query routes are never reachable through the gateway.
Each request gets a fresh MCP server; the bearer is checked in constant time and is never
forwarded to the workspace services. `workspace` is required on every tool call and must
name a workspace from `workspaces.json`. `unreal_refresh_index` is omitted from
`tools/list` and refused if called, because server-side mirrors own reindexing. Resources
are listed per workspace (`unreal://index/status?workspace=<name>`).

Accepted risk: the gateway speaks plain HTTP with one shared bearer on a trusted LAN, so
anyone who can sniff that LAN can read the token. TLS (or per-client enrolment) is the
planned upgrade path.

## Volume Management

Volumes are named `unreal-index-<workspace-name>-db|mirror|zoekt`:

```bash
# View volume sizes
docker system df -v | grep -E "unreal-index-"

# Backup a workspace database
docker compose cp <workspace-name>:/data/db/index.db ./backup-index.db

# Reset all data for all workspaces (stops containers, removes volumes)
docker compose down -v

# Reset just Zoekt index for a workspace (rebuilds on next start)
docker volume rm unreal-index-<workspace-name>-zoekt
```

## Memory Tuning

Default limit per workspace is auto-calculated from its projects (2 GB base plus about 1.5 GB for content, 2 GB for engine C++, 0.5 GB for game C++ or AngelScript; clamped to 4-16 GB; swap limit = memory + 2 GB). Override it in the setup GUI.

| Consumer | Typical Usage |
|----------|--------------|
| Node.js V8 heap | up to 3 GB |
| SQLite page cache | ~256 MB |
| Zoekt webserver | ~150-200 MB |
| Zoekt indexer (transient) | ~200-500 MB |

If you're running out of memory:
1. Reduce `zoekt.parallelism` to `2` in the workspace config
2. Adjust memory limits in the setup GUI or directly in `docker-compose.yml`

Monitor with: `docker stats`

## Development

Use the dev overlay for live reload during development:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up <workspace-name>
```

This mounts `./src` and `./public` read-only into the container and uses `node --watch` for automatic restarts. Port 6070 is also exposed for direct Zoekt debugging.

**Note:** The service name in `docker-compose.dev.yml` must match the workspace name in your generated `docker-compose.yml`. See `docker-compose.dev.yml` for details.

## Troubleshooting

**Container exits immediately**
```bash
docker compose logs <workspace-name>
```
Common causes: config syntax error, port already in use.

**Health check failing**
```bash
# Check if the service is still starting up (start-period is 60s)
docker inspect unreal-index-<workspace-name> --format='{{.State.Health.Status}}'

# Check service logs
docker compose logs --tail=50 <workspace-name>
```

**Zoekt not available**
```bash
docker compose exec <workspace-name> which zoekt-index zoekt-webserver
```

**Database corruption after OOM kill**
SQLite WAL mode recovers automatically on restart. If issues persist:
```bash
docker compose down
docker volume rm unreal-index-<workspace-name>-db
docker compose up -d
# Re-run watcher to repopulate
```
