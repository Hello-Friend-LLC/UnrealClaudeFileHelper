#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { readFileSync, existsSync, realpathSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID, timingSafeEqual, createHash } from 'crypto';
import { Agent } from 'undici';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SESSION_ID = randomUUID();

// ── Connection pool ──────────────────────────────────────────

const httpAgent = new Agent({
  keepAliveTimeout: 60_000,
  connections: 10,
  pipelining: 1
});

// ── Workspace routing ────────────────────────────────────────

const INSIDE_CONTAINER = !!process.env.INSIDE_CONTAINER;
const FALLBACK_SERVICE_URL = 'http://127.0.0.1:3847';

function defaultWorkspacesFile() {
  return process.env.UNREAL_INDEX_WORKSPACES_FILE || join(__dirname, '..', '..', 'workspaces.json');
}

/**
 * Build the routing table { urls: Map<workspace, loopback service URL>, defaultWorkspace, source }
 * from a parsed workspaces.json. Entries with an invalid port are skipped.
 */
export function routingFromConfig(cfg) {
  const urls = new Map();
  for (const [name, ws] of Object.entries(cfg?.workspaces || {})) {
    const port = Number(ws?.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`[Bridge] WARNING: workspace "${name}" has an invalid port; skipped`);
      continue;
    }
    urls.set(name, `http://127.0.0.1:${port}`);
  }
  const defaultWorkspace = cfg?.defaultWorkspace || [...urls.keys()][0] || null;
  return { urls, defaultWorkspace, source: 'file' };
}

export function loadRouting({ insideContainer = INSIDE_CONTAINER, workspacesFile = defaultWorkspacesFile() } = {}) {
  if (insideContainer) {
    // Inside Docker: always route to local service
    return { urls: new Map([['default', FALLBACK_SERVICE_URL]]), defaultWorkspace: 'default', source: 'container' };
  }
  try {
    return routingFromConfig(JSON.parse(readFileSync(workspacesFile, 'utf-8')));
  } catch {
    return { urls: new Map([['default', FALLBACK_SERVICE_URL]]), defaultWorkspace: 'default', source: 'fallback' };
  }
}

let defaultRouting = null;
function getDefaultRouting() {
  if (!defaultRouting) defaultRouting = loadRouting();
  return defaultRouting;
}

// Pre-flight: warn about missing workspace configs (non-blocking)
function warnMissingWorkspaceConfigs(routing) {
  if (routing.source !== 'file') return;
  const configDir = join(__dirname, '..', '..', 'workspace-configs');
  for (const name of routing.urls.keys()) {
    const configPath = join(configDir, `${name}.json`);
    if (!existsSync(configPath)) {
      console.error(`[Bridge] WARNING: Missing workspace-configs/${name}.json for workspace "${name}". Run "npm run setup" or "npm start" to fix.`);
    }
  }
}

/**
 * Map a workspace name to its loopback service URL. Only names present in the
 * fixed routing table resolve; with requireWorkspace (HTTP gateway) there is no default.
 */
export function resolveServiceUrl(routing, workspace, { requireWorkspace = false } = {}) {
  const available = [...routing.urls.keys()].join(', ');
  if (workspace === undefined || workspace === null || workspace === '') {
    if (requireWorkspace) {
      throw new Error(`"workspace" is required on the HTTP gateway. Available: ${available}`);
    }
    return routing.urls.get(routing.defaultWorkspace) || FALLBACK_SERVICE_URL;
  }
  if (typeof workspace !== 'string' || !routing.urls.has(workspace)) {
    throw new Error(`Unknown workspace "${workspace}". Available: ${available}`);
  }
  return routing.urls.get(workspace);
}

// ── HTTP helpers ─────────────────────────────────────────────

const DEFAULT_UPSTREAM_TIMEOUT_MS = 60_000;

function upstreamTimeoutMs() {
  const value = Number(process.env.UNREAL_INDEX_UPSTREAM_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_UPSTREAM_TIMEOUT_MS;
}

// Every upstream call carries its own headers and a timeout; client request
// headers (including the gateway bearer) are never forwarded.
async function requestService(url, init = {}) {
  const timeoutMs = upstreamTimeoutMs();
  try {
    const response = await fetch(url, { ...init, dispatcher: httpAgent, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    return await response.json();
  } catch (err) {
    if (err?.name === 'TimeoutError') {
      throw new Error(`Upstream index service timed out after ${timeoutMs} ms`);
    }
    throw err;
  }
}

async function fetchService(serviceUrl, endpoint, params = {}) {
  const url = new URL(endpoint, serviceUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return requestService(url.toString());
}

async function postService(serviceUrl, endpoint) {
  const url = new URL(endpoint, serviceUrl);
  return requestService(url.toString(), { method: 'POST' });
}

async function fetchBatch(serviceUrl, queries) {
  if (!queries || !Array.isArray(queries) || queries.length === 0) {
    throw new Error('queries array is required and must not be empty');
  }
  const url = new URL('/batch', serviceUrl);
  return requestService(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries })
  });
}

// ── Mode-specific tool surface and instructions ──────────────

// Tools the HTTP gateway never exposes: the index is mirror-owned there.
const HTTP_DISABLED_TOOLS = new Set(['unreal_refresh_index']);

function buildWorkspaceParam(routing, mode) {
  const available = [...routing.urls.keys()].join(', ');
  return {
    workspace: {
      type: 'string',
      description: mode === 'http'
        ? `Workspace to query (required). Available: ${available}`
        : `Workspace to query. Available: ${available}. Default: "${routing.defaultWorkspace}"`
    }
  };
}

function adaptToolsForMode(tools, mode) {
  if (mode !== 'http') return tools;
  return tools
    .filter(tool => !HTTP_DISABLED_TOOLS.has(tool.name))
    .map(tool => ({
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        required: [...new Set([...(tool.inputSchema.required || []), 'workspace'])]
      }
    }));
}

function buildInstructions(routing, mode) {
  const available = [...routing.urls.keys()].join(', ');
  const toolBullets = `- Use unreal_find_file instead of \`find\` or \`ls\` to locate source files by name
- Use unreal_grep instead of \`grep\`, \`rg\`, or \`sed -n\` to search file contents or find line numbers
- Use unreal_find_type instead of grep to locate class/struct/enum definitions
- Use unreal_find_member instead of grep to locate function/property definitions`;
  if (mode === 'http') {
    return `IMPORTANT: Prefer these unreal-index tools over Bash commands for searching Unreal Engine/AngelScript code.
${toolBullets}
This is a remote, central index reached over HTTP. It indexes a read-only server-side mirror of each workspace, not files on this machine:
- Result paths are project-relative mirror paths ("<Project>/<path inside that project>"), never files you can Read as-is. Map the part after the project name onto your local checkout of that project, then Read the local file.
- The mirror syncs on a schedule, so it can lag or lead your checkout. If the local file differs from a hit, trust the local file.
- Check the "index" block of each response: when index.complete is false, treat missing or odd results as inconclusive.
- unreal_refresh_index is not available here; the mirrors own reindexing.
If a search returns no results, check the hints in the response for guidance (wrong project filter, try fuzzy, etc).
The "workspace" parameter is required on every call. Available workspaces: ${available}.`;
  }
  return `IMPORTANT: Always use these unreal-index tools instead of Bash commands for searching Unreal Engine/AngelScript code.
${toolBullets}
- Use the Read tool (not sed/cat/head) to read file contents after finding them
Never fall back to Bash find/grep — these tools are faster, project-aware, and return structured results.
If a search returns no results, check the hints in the response for guidance (wrong project filter, try fuzzy, etc).
Available workspaces: ${available}. Default workspace: "${routing.defaultWorkspace}". Use the "workspace" parameter to query a specific workspace.`;
}

function refreshDisabledMessage(statusPointer) {
  const pointer = statusPointer ? ` Freshness status: ${statusPointer}.` : '';
  return 'unreal_refresh_index is disabled on the HTTP gateway: the index is mirror-owned ' +
    '(server-side P4/Git mirrors sync and reindex on their own schedule). ' +
    `Read the unreal://index/status?workspace=<name> resource or check the index.complete flag on query responses.${pointer}`;
}

// Resource URIs may carry ?workspace=<name>; returns { base, workspace }.
function parseResourceUri(uri) {
  const text = String(uri || '');
  const q = text.indexOf('?');
  if (q < 0) return { base: text, workspace: null };
  return { base: text.slice(0, q), workspace: new URLSearchParams(text.slice(q + 1)).get('workspace') };
}

export class UnrealIndexBridge {
  constructor({ mode = 'stdio', routing = getDefaultRouting(), statusPointer = process.env.UNREAL_INDEX_STATUS_POINTER || '' } = {}) {
    this.mode = mode;
    this.routing = routing;
    this.statusPointer = statusPointer;
    this.server = new Server(
      {
        name: 'unreal-index',
        version: '2.1.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
        instructions: buildInstructions(routing, mode),
      }
    );
  }

  async initialize() {
    this.setupHandlers();
  }

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const workspaceParam = buildWorkspaceParam(this.routing, this.mode);
      return {
        tools: adaptToolsForMode([
          {
            name: 'unreal_find_type',
            description: 'Find file(s) containing a class, struct, enum, event, or delegate by name. Use INSTEAD of bash grep/find for locating type definitions. Searches AngelScript, C++, and Blueprint assets. Returns file path and line number.',
            inputSchema: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Type name to search for (e.g. ADiscoveryPlayerController, AActor, FVector, ESpectatorState)'
                },
                fuzzy: {
                  type: 'boolean',
                  default: false,
                  description: 'Enable fuzzy/partial matching for uncertain names'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project (Discovery, Pioneer, Shared, Engine, EnginePlugins, DiscoveryPlugins)'
                },
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp', 'csharp', 'blueprint'],
                  default: 'all',
                  description: 'Filter by source language. Note: C++ types exposed to AngelScript via bindings are stored as cpp, so use "all" (default) to find all types usable from AngelScript.'
                },
                kind: {
                  type: 'string',
                  enum: ['class', 'struct', 'enum', 'interface', 'delegate', 'event', 'namespace'],
                  description: 'Filter by type kind'
                },
                maxResults: {
                  type: 'number',
                  default: 10,
                  description: 'Maximum results to return'
                },
                includeAssets: {
                  type: 'boolean',
                  description: 'Include blueprint/asset types in results. Default: true for exact match, false for fuzzy.'
                },
                contextLines: {
                  type: 'number',
                  default: 0,
                  description: 'Lines of source context to include around the type definition. Set to 5-10 to see the type definition inline without needing to Read the file.'
                },
                ...workspaceParam
              },
              required: ['name']
            }
          },
          {
            name: 'unreal_find_children',
            description: 'Find all classes inheriting from a given parent class. Includes source code types (AngelScript, C++) and Blueprint subclasses.',
            inputSchema: {
              type: 'object',
              properties: {
                parentClass: {
                  type: 'string',
                  description: 'Parent class name (e.g. AActor, UActorComponent, ADiscoveryPlayerControllerBase)'
                },
                recursive: {
                  type: 'boolean',
                  default: true,
                  description: 'Include all descendants, not just direct children'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project (Discovery, Pioneer, Shared, Engine, EnginePlugins, DiscoveryPlugins)'
                },
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp', 'csharp', 'blueprint'],
                  default: 'all',
                  description: 'Filter by source language. Note: C++ types exposed to AngelScript via bindings are stored as cpp, so use "all" (default) to find all types usable from AngelScript.'
                },
                maxResults: {
                  type: 'number',
                  default: 50,
                  description: 'Maximum results to return'
                },
                ...workspaceParam
              },
              required: ['parentClass']
            }
          },
          {
            name: 'unreal_browse_module',
            description: 'List all types and files in a module/directory. Use to explore a specific area of the codebase.',
            inputSchema: {
              type: 'object',
              properties: {
                module: {
                  type: 'string',
                  description: 'Module path (e.g. Discovery.UI, Engine.Source.Runtime, EnginePlugins.Online)'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project'
                },
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp', 'csharp'],
                  default: 'all',
                  description: 'Filter by language: all, angelscript, cpp, or csharp'
                },
                maxResults: {
                  type: 'number',
                  default: 100,
                  description: 'Maximum types to return'
                },
                ...workspaceParam
              },
              required: ['module']
            }
          },
          {
            name: 'unreal_find_file',
            description: 'Find source files by filename. Searches AngelScript (.as), C++ (.h, .cpp), and config (.ini) files. Pass only the filename (not a full path). If no results with a project filter, retry without it. Do NOT fall back to bash find commands.',
            inputSchema: {
              type: 'object',
              properties: {
                filename: {
                  type: 'string',
                  description: 'Filename to search for (e.g. Actor, PlayerController, GameMode, DefaultEngine.ini)'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project (Discovery, Pioneer, Shared, Engine, EnginePlugins, DiscoveryPlugins, DiscoveryConfig, EngineConfig)'
                },
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp', 'csharp', 'config'],
                  default: 'all',
                  description: 'Filter by language: all, angelscript, cpp, csharp, or config'
                },
                maxResults: {
                  type: 'number',
                  default: 20,
                  description: 'Maximum results to return'
                },
                ...workspaceParam
              },
              required: ['filename']
            }
          },
          {
            name: 'unreal_refresh_index',
            description: 'Rebuild the file index. Optionally specify a language to rebuild only that index.',
            inputSchema: {
              type: 'object',
              properties: {
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp', 'csharp'],
                  default: 'all',
                  description: 'Language to refresh: all, angelscript, cpp, or csharp'
                },
                ...workspaceParam
              }
            }
          },
          {
            name: 'unreal_find_member',
            description: 'Find functions, properties, or enum values by name. Search across class/struct members in AngelScript and C++. Use this to find method implementations, property definitions, or enum values. Note: Blueprint members are not available (binary format) — use unreal_find_type or unreal_find_asset for blueprint classes.',
            inputSchema: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Member name to search for (e.g. BeginPlay, TakeDamage, MaxHealth, DeathCam)'
                },
                fuzzy: {
                  type: 'boolean',
                  default: false,
                  description: 'Enable fuzzy/partial matching'
                },
                containingType: {
                  type: 'string',
                  description: 'Filter to members of a specific type (e.g. AActor, UWidget)'
                },
                memberKind: {
                  type: 'string',
                  enum: ['function', 'property', 'enum_value'],
                  description: 'Filter by member kind'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project'
                },
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp', 'csharp'],
                  default: 'all',
                  description: 'Filter by language'
                },
                maxResults: {
                  type: 'number',
                  default: 20,
                  description: 'Maximum results to return'
                },
                contextLines: {
                  type: 'number',
                  default: 0,
                  description: 'Lines of source context around each member definition. Set to 3-5 to see signatures and surrounding code inline.'
                },
                includeSignatures: {
                  type: 'boolean',
                  default: false,
                  description: 'Include the source signature line for each member. Lightweight alternative to contextLines when you only need the declaration.'
                },
                ...workspaceParam
              },
              required: ['name']
            }
          },
          {
            name: 'unreal_explain_type',
            description: 'Get comprehensive information about a type in a single call: definition, members (functions/properties), and children. Replaces the common pattern of find_type + find_member + find_children. Use this when you need to understand a class or struct.',
            inputSchema: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Type name to look up (e.g. AActor, UWidget, FVector)'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project'
                },
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp', 'csharp'],
                  default: 'all',
                  description: 'Filter by language'
                },
                contextLines: {
                  type: 'number',
                  default: 0,
                  description: 'Lines of source context around the type definition and member declarations'
                },
                includeMembers: {
                  type: 'boolean',
                  default: true,
                  description: 'Include member functions, properties, and enum values'
                },
                includeChildren: {
                  type: 'boolean',
                  default: true,
                  description: 'Include child classes/structs that inherit from this type'
                },
                maxFunctions: {
                  type: 'number',
                  default: 30,
                  description: 'Maximum functions to return (independent budget from properties)'
                },
                maxProperties: {
                  type: 'number',
                  default: 30,
                  description: 'Maximum properties to return (independent budget from functions)'
                },
                maxChildren: {
                  type: 'number',
                  default: 20,
                  description: 'Maximum children to return'
                },
                ...workspaceParam
              },
              required: ['name']
            }
          },
          {
            name: 'unreal_find_asset',
            description: 'Find Unreal assets (Blueprints, Materials, Maps, DataAssets, etc.) by name. Searches 400K+ indexed assets. Returns content browser paths, asset class type, and parent class for Blueprints. By default uses partial matching (fuzzy=true) — set fuzzy=false only when you need an exact name match. Works offline without a running editor.',
            inputSchema: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Asset name to search for (e.g. BP_ATK_MapBorder, M_Highlight, MI_Default). Partial names work with fuzzy=true (default).'
                },
                fuzzy: {
                  type: 'boolean',
                  default: true,
                  description: 'Enable partial/substring matching (default: true). Set to false for exact name match only.'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project (DiscoveryContent, PioneerContent, EngineContent)'
                },
                folder: {
                  type: 'string',
                  description: 'Filter by content browser folder path (e.g. /Game/Discovery/Props)'
                },
                maxResults: {
                  type: 'number',
                  default: 20,
                  description: 'Maximum results to return'
                },
                ...workspaceParam
              },
              required: ['name']
            }
          },
          {
            name: 'unreal_grep',
            description: 'Search file contents for a pattern (regex or literal string). Use INSTEAD of bash grep/rg/sed. Scoped to indexed projects. Use for finding usages, string references, variable assignments, function calls, or any content pattern. Use contextLines for surrounding code. Set includeAssets=true to also search asset names/paths.',
            inputSchema: {
              type: 'object',
              properties: {
                pattern: {
                  type: 'string',
                  description: 'Search pattern (regex supported, e.g. "GameModeTagExclusionFilter", "UPROPERTY.*EditAnywhere")'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project (Discovery, Pioneer, Shared, Engine, EnginePlugins, DiscoveryPlugins, DiscoveryConfig, EngineConfig)'
                },
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp', 'csharp', 'config'],
                  default: 'all',
                  description: 'Filter by language: all, angelscript, cpp, csharp, or config'
                },
                caseSensitive: {
                  type: 'boolean',
                  default: true,
                  description: 'Case sensitive search'
                },
                maxResults: {
                  type: 'number',
                  default: 20,
                  description: 'Maximum matching lines to return'
                },
                contextLines: {
                  type: 'number',
                  default: 0,
                  description: 'Lines of context before and after each match'
                },
                includeAssets: {
                  type: 'boolean',
                  default: false,
                  description: 'Also search asset names/paths and return matches in an "assets" section'
                },
                ...workspaceParam
              },
              required: ['pattern']
            }
          },
          {
            name: 'unreal_list_modules',
            description: 'List available modules/directories in the codebase. Use to discover code organization and navigate the module tree.',
            inputSchema: {
              type: 'object',
              properties: {
                parent: {
                  type: 'string',
                  description: 'Parent module path to list children of (empty for root level modules)'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project'
                },
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp', 'csharp'],
                  default: 'all',
                  description: 'Filter by language'
                },
                depth: {
                  type: 'number',
                  default: 1,
                  description: 'How many levels deep to return'
                },
                ...workspaceParam
              }
            }
          },
          {
            name: 'unreal_batch',
            description: 'Execute multiple index queries in a single call. Use when you need results from several queries (e.g. look up 3 types at once). Each query specifies a method and arguments. Maximum 10 queries per batch.',
            inputSchema: {
              type: 'object',
              properties: {
                queries: {
                  type: 'array',
                  description: 'Array of queries to execute',
                  maxItems: 10,
                  items: {
                    type: 'object',
                    properties: {
                      method: {
                        type: 'string',
                        enum: ['findTypeByName', 'findMember', 'findChildrenOf', 'findFileByName', 'findAssetByName', 'listModules', 'browseModule'],
                        description: 'Query method to call'
                      },
                      args: {
                        type: 'array',
                        description: 'Arguments array for the method. E.g. ["AActor", {"project": "Discovery"}] for findTypeByName.'
                      }
                    },
                    required: ['method', 'args']
                  }
                },
                ...workspaceParam
              },
              required: ['queries']
            }
          }
        ], this.mode)
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const callStartMs = performance.now();

      if (this.mode === 'http' && HTTP_DISABLED_TOOLS.has(name)) {
        return {
          content: [{ type: 'text', text: `Error: ${refreshDisabledMessage(this.statusPointer)}` }],
          isError: true
        };
      }

      // Resolve workspace → service URL
      let serviceUrl;
      try {
        serviceUrl = resolveServiceUrl(this.routing, args?.workspace, { requireWorkspace: this.mode === 'http' });
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true
        };
      }

      // Fire-and-forget analytics tracking
      const trackCall = (result) => {
        const durationMs = Math.round(performance.now() - callStartMs);
        const resultText = result?.content?.[0]?.text;
        const resultSize = resultText ? resultText.length : 0;
        const argsSummary = args ? JSON.stringify(Object.fromEntries(
          Object.entries(args).filter(([k]) => k !== 'workspace').map(([k, v]) => [k, typeof v === 'string' && v.length > 50 ? v.slice(0, 50) + '...' : v])
        )) : null;
        fetch(new URL('/internal/mcp-tool-call', serviceUrl).toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool: name, args: argsSummary, durationMs, resultSize, sessionId: SESSION_ID }),
          dispatcher: httpAgent,
          signal: AbortSignal.timeout(5000)
        }).catch(() => {});
      };

      try {
        let toolResult;
        switch (name) {
          case 'unreal_find_type':
            toolResult = await fetchService(serviceUrl, '/find-type', {
              name: args.name, fuzzy: args.fuzzy, project: args.project,
              language: args.language, kind: args.kind, maxResults: args.maxResults,
              includeAssets: args.includeAssets, contextLines: args.contextLines
            });
            break;

          case 'unreal_find_children':
            toolResult = await fetchService(serviceUrl, '/find-children', {
              parent: args.parentClass || args.parent || args.name || args.className, recursive: args.recursive,
              project: args.project, language: args.language, maxResults: args.maxResults
            });
            break;

          case 'unreal_browse_module':
            toolResult = await fetchService(serviceUrl, '/browse-module', {
              module: args.module, project: args.project,
              language: args.language, maxResults: args.maxResults
            });
            break;

          case 'unreal_find_file':
            toolResult = await fetchService(serviceUrl, '/find-file', {
              filename: args.filename || args.name, project: args.project,
              language: args.language, maxResults: args.maxResults
            });
            break;

          case 'unreal_refresh_index': {
            const endpoint = args.language && args.language !== 'all'
              ? `/refresh?language=${args.language}`
              : '/refresh';
            toolResult = await postService(serviceUrl, endpoint);
            break;
          }

          case 'unreal_find_member':
            toolResult = await fetchService(serviceUrl, '/find-member', {
              name: args.name, fuzzy: args.fuzzy, containingType: args.containingType,
              memberKind: args.memberKind, project: args.project, language: args.language,
              maxResults: args.maxResults, contextLines: args.contextLines,
              includeSignatures: args.includeSignatures
            });
            break;

          case 'unreal_explain_type':
            toolResult = await fetchService(serviceUrl, '/explain-type', {
              name: args.name, project: args.project, language: args.language,
              contextLines: args.contextLines, includeMembers: args.includeMembers,
              includeChildren: args.includeChildren, maxFunctions: args.maxFunctions,
              maxProperties: args.maxProperties, maxChildren: args.maxChildren
            });
            break;

          case 'unreal_find_asset':
            toolResult = await fetchService(serviceUrl, '/find-asset', {
              name: args.name, fuzzy: args.fuzzy !== false,
              project: args.project, folder: args.folder, maxResults: args.maxResults
            });
            break;

          case 'unreal_grep':
            toolResult = await fetchService(serviceUrl, '/grep', {
              pattern: args.pattern || args.query || args.search, project: args.project, language: args.language,
              caseSensitive: args.caseSensitive, maxResults: args.maxResults,
              contextLines: args.contextLines, includeAssets: args.includeAssets
            });
            break;

          case 'unreal_list_modules':
            toolResult = await fetchService(serviceUrl, '/list-modules', {
              parent: args.parent, project: args.project,
              language: args.language, depth: args.depth
            });
            break;

          case 'unreal_batch':
            toolResult = await fetchBatch(serviceUrl, args.queries);
            break;

          default: {
            const errResult = {
              content: [{ type: 'text', text: `Unknown tool: ${name}` }],
              isError: true
            };
            trackCall(errResult);
            return errResult;
          }
        }

        const mcpResult = {
          content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }]
        };
        trackCall(mcpResult);
        return mcpResult;
      } catch (error) {
        const isConnectionError = error.cause?.code === 'ECONNREFUSED' ||
                                  error.message.includes('ECONNREFUSED') ||
                                  error.message.includes('fetch failed');

        let errResult;
        if (isConnectionError) {
          const wsName = args?.workspace || this.routing.defaultWorkspace;
          errResult = {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: `Unreal Index Service is not running (workspace: ${wsName})`,
                hint: this.mode === 'http'
                  ? 'The central index service for this workspace is down on the gateway host; report it to the index owner.'
                  : `Start the container: docker compose up ${wsName}`
              }, null, 2)
            }],
            isError: true
          };
        } else {
          errResult = {
            content: [{ type: 'text', text: `Error: ${error.message}` }],
            isError: true
          };
        }
        trackCall(errResult);
        return errResult;
      }
    });

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const baseResources = [
        {
          uri: 'unreal://index/summary',
          name: 'Unreal Index Summary',
          description: 'Compact summary of the code index: project names, languages, type statistics, and indexing status',
          mimeType: 'application/json'
        },
        {
          uri: 'unreal://index/status',
          name: 'Unreal Index Status',
          description: 'Current indexing status for each language (ready, indexing, error)',
          mimeType: 'application/json'
        }
      ];
      if (this.mode !== 'http') {
        return { resources: baseResources };
      }
      // HTTP gateway: no default workspace, so list one resource per workspace.
      const resources = [];
      for (const ws of this.routing.urls.keys()) {
        for (const r of baseResources) {
          resources.push({ ...r, uri: `${r.uri}?workspace=${encodeURIComponent(ws)}`, name: `${r.name} (${ws})` });
        }
      }
      return { resources };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      const { base, workspace } = parseResourceUri(uri);
      let serviceUrl;
      try {
        serviceUrl = resolveServiceUrl(this.routing, workspace, { requireWorkspace: this.mode === 'http' });
      } catch (error) {
        return {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ error: error.message }, null, 2) }]
        };
      }

      if (base === 'unreal://index/summary' || base === 'angelscript://index/summary') {
        try {
          const summary = await fetchService(serviceUrl, '/summary');
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(summary, null, 2)
              }
            ]
          };
        } catch (error) {
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify({ error: error.message }, null, 2)
              }
            ]
          };
        }
      }

      if (base === 'unreal://index/status') {
        try {
          const status = await fetchService(serviceUrl, '/status');
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(status, null, 2)
              }
            ]
          };
        } catch (error) {
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify({ error: error.message }, null, 2)
              }
            ]
          };
        }
      }

      return {
        contents: [
          {
            uri,
            mimeType: 'text/plain',
            text: `Unknown resource: ${uri}`
          }
        ]
      };
    });
  }

  async run() {
    await this.initialize();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

// ── HTTP gateway mode (--http) ───────────────────────────────
// Stateless Streamable HTTP: a new Server + transport per POST /mcp.
// One shared read-only bearer gates /mcp unless UNREAL_INDEX_AUTH=off (open
// gateway, trusted-LAN deployments); GET /health is open and minimal.
// Workspace services stay loopback-only; the gateway never proxies raw
// service routes (/internal/*, /refresh, ...) and never forwards the bearer.

export const MIN_TOKEN_LENGTH = 32;
export const HTTP_BODY_LIMIT = '1mb';
export const DEFAULT_HTTP_PORT = 3850;

function tokenDigest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest();
}

export function isAuthorized(header, expectedToken) {
  if (!expectedToken || typeof header !== 'string') return false;
  const match = /^Bearer +(\S+) *$/i.exec(header);
  if (!match) return false;
  return timingSafeEqual(tokenDigest(match[1]), tokenDigest(expectedToken));
}

/**
 * Read the gateway bearer from UNREAL_INDEX_TOKEN or UNREAL_INDEX_TOKEN_FILE
 * (file holds only the token). Throws without ever including the token value.
 */
export function isAuthDisabled(env = process.env) {
  return String(env.UNREAL_INDEX_AUTH || '').trim().toLowerCase() === 'off';
}

export function readGatewayToken(env = process.env) {
  let token = env.UNREAL_INDEX_TOKEN || '';
  if (!token && env.UNREAL_INDEX_TOKEN_FILE) {
    try {
      token = readFileSync(env.UNREAL_INDEX_TOKEN_FILE, 'utf-8');
    } catch (err) {
      throw new Error(`cannot read UNREAL_INDEX_TOKEN_FILE (${err.code || 'error'}); refusing to start without auth`);
    }
  }
  token = token.trim();
  if (!token) {
    throw new Error('--http requires UNREAL_INDEX_TOKEN or UNREAL_INDEX_TOKEN_FILE; refusing to start without auth');
  }
  if (/\s/.test(token)) {
    throw new Error('gateway token must not contain whitespace; refusing to start');
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`gateway token is shorter than ${MIN_TOKEN_LENGTH} characters; refusing to start`);
  }
  return token;
}

function splitList(value) {
  return String(value || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

/** Host header values the gateway answers to: loopback, the bind host, plus extras. */
export function buildAllowedHosts(host, port, extra = '') {
  const names = ['127.0.0.1', 'localhost', '[::1]'];
  if (host && host !== '0.0.0.0' && host !== '::') {
    names.push(host.includes(':') && !host.startsWith('[') ? `[${host}]` : host);
  }
  names.push(...splitList(extra));
  const allowed = new Set();
  for (const name of names) {
    const lower = name.toLowerCase();
    allowed.add(lower);
    if (!/:\d+$/.test(lower)) allowed.add(`${lower}:${port}`);
  }
  return allowed;
}

function sendJsonRpcError(res, status, code, message) {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

export function createHttpApp({
  token,
  routing,
  allowedHosts,
  allowedOrigins = new Set(),
  statusPointer = process.env.UNREAL_INDEX_STATUS_POINTER || '',
  authDisabled = false
}) {
  if (!authDisabled && (!token || token.length < MIN_TOKEN_LENGTH)) {
    throw new Error(`createHttpApp requires a token of at least ${MIN_TOKEN_LENGTH} characters`);
  }
  if (!routing || !(routing.urls instanceof Map) || routing.urls.size === 0) {
    throw new Error('createHttpApp requires a routing table with at least one workspace');
  }
  if (!(allowedHosts instanceof Set) || allowedHosts.size === 0) {
    throw new Error('createHttpApp requires a non-empty allowedHosts set');
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  // DNS-rebinding / cross-site guard: fixed Host allow-list; browsers' Origin
  // is refused unless explicitly allowed (MCP clients send none).
  app.use((req, res, next) => {
    const hostHeader = String(req.headers.host || '').toLowerCase();
    if (!allowedHosts.has(hostHeader)) {
      sendJsonRpcError(res, 403, -32000, 'Forbidden: Host not allowed');
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(String(origin).toLowerCase())) {
      sendJsonRpcError(res, 403, -32000, 'Forbidden: Origin not allowed');
      return;
    }
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, mode: 'http', workspaces: [...routing.urls.keys()] });
  });

  app.all('/mcp', (req, res, next) => {
    if (!authDisabled && !isAuthorized(req.headers.authorization, token)) {
      res.set('WWW-Authenticate', 'Bearer');
      sendJsonRpcError(res, 401, -32001, 'Unauthorized');
      return;
    }
    next();
  });

  // Parse every body as JSON under the cap; the SDK still enforces Content-Type/Accept.
  app.post('/mcp', express.json({ limit: HTTP_BODY_LIMIT, type: () => true }), async (req, res) => {
    const bridge = new UnrealIndexBridge({ mode: 'http', routing, statusPointer });
    bridge.setupHandlers();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    res.on('close', () => {
      transport.close().catch(() => {});
      bridge.server.close().catch(() => {});
    });
    try {
      await bridge.server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`[Bridge] /mcp error: ${err.message}`);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, 'Internal error');
      }
    }
  });

  app.all('/mcp', (_req, res) => {
    res.set('Allow', 'POST');
    sendJsonRpcError(res, 405, -32000, 'Method not allowed (stateless server)');
  });

  app.use((_req, res) => {
    sendJsonRpcError(res, 404, -32000, 'Not found');
  });

  // Body parser and other errors: never echo request content back.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (res.headersSent) return;
    if (err?.type === 'entity.too.large') {
      sendJsonRpcError(res, 413, -32000, `Request body exceeds ${HTTP_BODY_LIMIT}`);
    } else if (err?.type === 'entity.parse.failed') {
      sendJsonRpcError(res, 400, -32700, 'Parse error');
    } else {
      console.error(`[Bridge] request error: ${err?.message || err}`);
      sendJsonRpcError(res, err?.status && err.status < 500 ? err.status : 500, -32603, 'Request error');
    }
  });

  return app;
}

function parsePort(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function runHttp() {
  let token = '';
  const authDisabled = isAuthDisabled();
  try {
    if (!authDisabled) token = readGatewayToken();
  } catch (err) {
    console.error(`[Bridge] ${err.message}`);
    process.exit(2);
  }
  const routing = loadRouting({ insideContainer: false });
  if (routing.source !== 'file' || routing.urls.size === 0) {
    console.error('[Bridge] --http requires a workspaces.json with at least one workspace (default: repo root, override: UNREAL_INDEX_WORKSPACES_FILE)');
    process.exit(2);
  }
  // No workspace-configs check here: the gateway only needs workspace ports.
  const host = process.env.UNREAL_INDEX_HTTP_HOST || '127.0.0.1';
  const port = parsePort(process.env.UNREAL_INDEX_HTTP_PORT, DEFAULT_HTTP_PORT);
  if (port === null) {
    console.error('[Bridge] UNREAL_INDEX_HTTP_PORT is not a valid port');
    process.exit(2);
  }
  if (authDisabled) {
    console.error('[Bridge] UNREAL_INDEX_AUTH=off: /mcp is unauthenticated; keep this gateway on a trusted network');
  }
  const app = createHttpApp({
    token,
    authDisabled,
    routing,
    allowedHosts: buildAllowedHosts(host, port, process.env.UNREAL_INDEX_HTTP_ALLOWED_HOSTS),
    allowedOrigins: new Set(splitList(process.env.UNREAL_INDEX_HTTP_ALLOWED_ORIGINS))
  });
  const server = app.listen(port, host, () => {
    console.error(`[Bridge] HTTP MCP gateway listening on http://${host}:${port}/mcp (workspaces: ${[...routing.urls.keys()].join(', ')})`);
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
  server.on('error', (err) => {
    console.error(`[Bridge] HTTP gateway failed to listen on ${host}:${port}: ${err.message}`);
    process.exit(1);
  });
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const entry = realpathSync(process.argv[1]);
    const self = realpathSync(__filename);
    return process.platform === 'win32' ? entry.toLowerCase() === self.toLowerCase() : entry === self;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  if (process.argv.includes('--http')) {
    runHttp();
  } else {
    const routing = getDefaultRouting();
    warnMissingWorkspaceConfigs(routing);
    const bridge = new UnrealIndexBridge({ mode: 'stdio', routing });
    bridge.run().catch(console.error);
  }
}
