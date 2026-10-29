import { isIP } from 'node:net';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { ResolvedMcpServer, TransportConfig } from '@mavis/mcp';

import { readPluginSkill } from '../../skill/reader.js';
import {
  canonicalizePluginRoot,
  isRecord,
  listDirectChildDirectories,
  pluginPathExists,
  readPluginJsonObject,
  resolvePluginDirectory,
  resolvePluginFile,
  type CanonicalPluginRoot,
} from './filesystem.js';
import { PluginReaderError, readerFail } from './reader-errors.js';
import type {
  PluginMcpServer,
  PluginReaderDiagnostic,
  PluginSkill,
  ReadPluginPackage,
} from './types.js';

const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const PLUGIN_FIELDS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
]);
const AUTHOR_FIELDS = new Set(['name', 'email', 'url']);
const MCP_ROOT_FIELDS = new Set(['$schema', 'mcpServers']);
const STDIO_FIELDS = new Set(['type', 'command', 'args', 'env', 'cwd']);
const REMOTE_FIELDS = new Set(['type', 'url', 'headers']);
const PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const SKILL_NAME = /^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const RESERVED_ENV = new Set(['PLUGIN_ROOT', 'PLUGIN_DATA']);
const PLUGIN_ROOT_TOKEN = ['$', '{PLUGIN_ROOT}'].join('');
const PLUGIN_DATA_TOKEN = ['$', '{PLUGIN_DATA}'].join('');
const MAX_AGENT_PLUGIN_SKILLS = 64;
const MAX_AGENT_PLUGIN_MCP_SERVERS = 8;

export interface ReadAgentPluginOptions {
  readonly dataDir: string;
  readonly createPluginData?: boolean;
}

/** Reads the Agent Plugins 1.0.0 portable subset supported by Shards Code. */
export async function readAgentPluginPackage(
  packageRoot: string,
  options: ReadAgentPluginOptions,
): Promise<ReadPluginPackage> {
  const root = await canonicalizePluginRoot(packageRoot, { rejectSymlink: true });
  const { path: manifestPath, value } = await readPluginJsonObject(root, 'plugin.json');
  const diagnostics: PluginReaderDiagnostic[] = [];
  const manifest = readManifest(value, diagnostics);
  const canonicalDataDir = await realpath(options.dataDir);
  const pluginData = path.join(
    canonicalDataDir,
    'v2',
    'plugin-data',
    'agent-plugins',
    manifest.name,
  );
  if (options.createPluginData) await mkdir(pluginData, { recursive: true });

  const skills = await readSkills(root, diagnostics);
  const mcpServers = await readMcp(
    root,
    pluginData,
    Boolean(options.createPluginData),
    diagnostics,
  );
  return {
    source: 'LOCAL_AGENT_PLUGIN',
    manifestKind: 'AGENT_PLUGINS_V1',
    rootPath: root.path,
    manifestPath,
    name: manifest.name,
    displayName: manifest.name,
    ...(manifest.version ? { version: manifest.version } : {}),
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(manifest.author ? { author: manifest.author } : {}),
    category: 'Other',
    exampleQueries: [],
    apps: [],
    mcpServers,
    skills,
    hooks: [],
    diagnostics,
  };
}

interface AgentManifest {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly author?: string;
}

function readManifest(
  value: Record<string, unknown>,
  diagnostics: PluginReaderDiagnostic[],
): AgentManifest {
  validateManifestSchema(value, diagnostics);
  const name = requiredString(value.name, 'name');
  if (name.length > 64 || !PLUGIN_NAME.test(name)) {
    readerFail('MANIFEST_SCHEMA_INVALID', 'plugin.json name is invalid');
  }
  const version = optionalString(value.version, 'version');
  const description = optionalString(value.description, 'description');
  const author = readAuthor(value.author);
  validateOptionalManifestFields(value, diagnostics);
  return {
    name,
    ...(version ? { version } : {}),
    ...(description ? { description } : {}),
    ...(author ? { author } : {}),
  };
}

function validateManifestSchema(
  value: Record<string, unknown>,
  diagnostics: PluginReaderDiagnostic[],
): void {
  if (value.$schema !== PLUGIN_SCHEMA) {
    readerFail('MANIFEST_SCHEMA_INVALID', 'plugin.json targets an unsupported schema');
  }
  for (const field of Object.keys(value)) {
    if (!PLUGIN_FIELDS.has(field)) {
      diagnostics.push({ code: 'MANIFEST_UNKNOWN_FIELD_IGNORED', name: field });
    }
  }
}

function validateOptionalManifestFields(
  value: Record<string, unknown>,
  diagnostics: PluginReaderDiagnostic[],
): void {
  for (const key of ['homepage', 'repository', 'license'] as const) optionalString(value[key], key);
  if (
    value.keywords !== undefined &&
    (!Array.isArray(value.keywords) || value.keywords.some((item) => typeof item !== 'string'))
  ) {
    readerFail('MANIFEST_SCHEMA_INVALID', 'plugin.json keywords must contain strings');
  }
  if (value.extensions !== undefined && !isRecord(value.extensions)) {
    diagnostics.push({ code: 'MANIFEST_EXTENSIONS_IGNORED' });
  }
}

function readAuthor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).some((key) => !AUTHOR_FIELDS.has(key))) {
    readerFail('MANIFEST_SCHEMA_INVALID', 'plugin.json author is invalid');
  }
  for (const key of AUTHOR_FIELDS) optionalString(value[key], `author.${key}`);
  return optionalString(value.name, 'author.name');
}

async function readSkills(
  root: CanonicalPluginRoot,
  diagnostics: PluginReaderDiagnostic[],
): Promise<PluginSkill[]> {
  if (!(await pluginPathExists(root, 'skills', 'directory'))) return [];
  const children = await listDirectChildDirectories(root, 'skills');
  if (children.length > MAX_AGENT_PLUGIN_SKILLS) {
    readerFail(
      'PLUGIN_CAPABILITY_LIMIT_EXCEEDED',
      `Agent Plugin contains more than ${MAX_AGENT_PLUGIN_SKILLS} Skill directories`,
    );
  }
  const skills: PluginSkill[] = [];
  for (const child of children) {
    const relativePath = `${child.relativePath}/SKILL.md`;
    if (!(await pluginPathExists(root, relativePath, 'file'))) continue;
    try {
      const skill = await readPluginSkill(root, relativePath, {
        expectedName: child.name,
        agentSkills: true,
      });
      if (
        skill.name.length > 64 ||
        !SKILL_NAME.test(skill.name) ||
        skill.description.length > 1_024
      ) {
        readerFail('SKILL_SCHEMA_INVALID', `${relativePath} violates Agent Skills`);
      }
      skills.push(skill);
    } catch (error) {
      if (!(error instanceof PluginReaderError)) throw error;
      diagnostics.push({ code: error.code, capability: 'SKILL', name: child.name });
    }
  }
  return skills;
}

async function readMcp(
  root: CanonicalPluginRoot,
  pluginData: string,
  createPluginData: boolean,
  diagnostics: PluginReaderDiagnostic[],
): Promise<PluginMcpServer[]> {
  if (!(await pluginPathExists(root, 'mcp.json', 'file'))) return [];
  const value = await readMcpRoot(root, diagnostics);
  if (!value) return [];
  const entries = Object.entries(value.mcpServers as Record<string, unknown>);
  if (entries.length > MAX_AGENT_PLUGIN_MCP_SERVERS) {
    readerFail(
      'PLUGIN_CAPABILITY_LIMIT_EXCEEDED',
      `Agent Plugin contains more than ${MAX_AGENT_PLUGIN_MCP_SERVERS} MCP servers`,
    );
  }
  const context = { root, pluginData, createPluginData };
  const servers: PluginMcpServer[] = [];
  for (const [name, raw] of entries) {
    try {
      validateMcpServerEntry(name, raw);
      servers.push(await readMcpServer(context, name, raw as Record<string, unknown>));
    } catch (error) {
      if (!(error instanceof PluginReaderError)) throw error;
      diagnostics.push({ code: error.code, capability: 'MCP', name });
    }
  }
  return servers;
}

async function readMcpRoot(
  root: CanonicalPluginRoot,
  diagnostics: PluginReaderDiagnostic[],
): Promise<Record<string, unknown> | undefined> {
  try {
    const { value } = await readPluginJsonObject(root, 'mcp.json');
    if (
      value.$schema !== MCP_SCHEMA ||
      Object.keys(value).some((key) => !MCP_ROOT_FIELDS.has(key)) ||
      !isRecord(value.mcpServers)
    ) {
      readerFail('MCP_SCHEMA_INVALID', 'mcp.json has an invalid wrapper');
    }
    return value;
  } catch (error) {
    if (!(error instanceof PluginReaderError)) throw error;
    diagnostics.push({ code: error.code, capability: 'MCP' });
    return undefined;
  }
}

function validateMcpServerEntry(name: string, raw: unknown): void {
  if (!isRecord(raw)) {
    readerFail('MCP_SCHEMA_INVALID', `${name} is not a valid server entry`);
  }
}

interface McpReadContext {
  readonly root: CanonicalPluginRoot;
  readonly pluginData: string;
  readonly createPluginData: boolean;
}

async function readMcpServer(
  context: McpReadContext,
  name: string,
  raw: Record<string, unknown>,
): Promise<PluginMcpServer> {
  const type = raw.type;
  let transport: TransportConfig;
  if (type === 'stdio') transport = await readStdio(context, name, raw);
  else if (type === 'streamable-http' || type === 'sse') transport = readRemote(name, raw, type);
  else readerFail('MCP_SCHEMA_INVALID', `${name} has an unsupported transport`);
  const resolvedServer: ResolvedMcpServer = { name, transport, enabled: true };
  return { name, resolvedServer, declaredTools: [], configJson: JSON.stringify(raw) };
}

async function readStdio(
  context: McpReadContext,
  name: string,
  raw: Record<string, unknown>,
): Promise<TransportConfig> {
  if (Object.keys(raw).some((key) => !STDIO_FIELDS.has(key))) {
    readerFail('MCP_SCHEMA_INVALID', `${name} contains an unknown field`);
  }
  const rawCommand = requiredString(raw.command, `${name}.command`, 'MCP_SCHEMA_INVALID');
  let command: string;
  if (rawCommand.startsWith('./')) command = await resolvePluginFile(context.root, rawCommand);
  else if (/[/\\]/u.test(rawCommand)) {
    readerFail('MCP_SCHEMA_INVALID', `${name}.command must be a bare executable or ./ path`);
  } else command = rawCommand;
  const args = raw.args === undefined ? [] : stringArray(raw.args, `${name}.args`);
  const configuredEnv = raw.env === undefined ? {} : stringRecord(raw.env, `${name}.env`);
  if (Object.keys(configuredEnv).some(isReservedEnvironmentName)) {
    readerFail('MCP_SCHEMA_INVALID', `${name}.env overrides a reserved variable`);
  }
  const cwd = await resolveAgentCwd(context, raw.cwd);
  return {
    type: 'stdio',
    command,
    args: args.map((value) => expandPlaceholders(value, context.root.path, context.pluginData)),
    env: {
      ...Object.fromEntries(
        Object.entries(configuredEnv).map(([key, value]) => [
          key,
          expandPlaceholders(value, context.root.path, context.pluginData),
        ]),
      ),
      PLUGIN_ROOT: context.root.path,
      PLUGIN_DATA: context.pluginData,
    },
    cwd,
  };
}

function isReservedEnvironmentName(name: string): boolean {
  return RESERVED_ENV.has(process.platform === 'win32' ? name.toUpperCase() : name);
}

function readRemote(
  name: string,
  raw: Record<string, unknown>,
  type: 'streamable-http' | 'sse',
): TransportConfig {
  if (Object.keys(raw).some((key) => !REMOTE_FIELDS.has(key))) {
    readerFail('MCP_SCHEMA_INVALID', `${name} contains an unknown field`);
  }
  const url = requiredString(raw.url, `${name}.url`, 'MCP_SCHEMA_INVALID');
  if (!isSafeRemoteUrl(url)) readerFail('MCP_SCHEMA_INVALID', `${name}.url is not safe HTTPS`);
  const headers = raw.headers === undefined ? undefined : readHeaders(raw.headers, name);
  return {
    type: type === 'sse' ? 'sse' : 'http',
    url,
    ...(headers ? { headers } : {}),
    protectHeadersOnRedirect: true,
  };
}

async function resolveAgentCwd(context: McpReadContext, raw: unknown): Promise<string> {
  if (raw === undefined) return context.root.path;
  const value = requiredString(raw, 'cwd', 'MCP_SCHEMA_INVALID');
  const target = resolveCwdTarget(context, value);
  if (target.create) await mkdir(target.candidate, { recursive: true });
  if (target.allowMissing) return target.candidate;
  return canonicalizeCwd(target);
}

interface CwdTarget {
  readonly candidate: string;
  readonly containmentRoot: string;
  readonly create: boolean;
  readonly allowMissing: boolean;
}

function resolveCwdTarget(context: McpReadContext, value: string): CwdTarget {
  if (value.startsWith('./')) {
    return cwdTarget(context.root.path, value.slice(2), false, false);
  }
  if (value === PLUGIN_ROOT_TOKEN || value.startsWith(`${PLUGIN_ROOT_TOKEN}/`)) {
    return cwdTarget(context.root.path, value.slice(PLUGIN_ROOT_TOKEN.length), false, false);
  }
  if (value === PLUGIN_DATA_TOKEN || value.startsWith(`${PLUGIN_DATA_TOKEN}/`)) {
    return cwdTarget(
      context.pluginData,
      value.slice(PLUGIN_DATA_TOKEN.length),
      context.createPluginData,
      !context.createPluginData,
    );
  }
  readerFail('MCP_SCHEMA_INVALID', 'cwd has an unsupported form');
}

function cwdTarget(
  containmentRoot: string,
  suffix: string,
  create: boolean,
  allowMissing: boolean,
): CwdTarget {
  const candidate = path.resolve(containmentRoot, suffix.replace(/^\//u, ''));
  if (!isInside(containmentRoot, candidate))
    readerFail('PATH_OUTSIDE_ROOT', 'cwd escapes its root');
  return { candidate, containmentRoot, create, allowMissing };
}

async function canonicalizeCwd(target: CwdTarget): Promise<string> {
  try {
    const canonical = await realpath(target.candidate);
    if (!isInside(target.containmentRoot, canonical))
      readerFail('PATH_OUTSIDE_ROOT', 'cwd escapes its root');
    await resolvePluginDirectory(
      { path: target.containmentRoot },
      path.relative(target.containmentRoot, canonical) || '.',
    );
    return canonical;
  } catch (error) {
    if (error instanceof PluginReaderError) throw error;
    readerFail('MCP_SCHEMA_INVALID', 'cwd does not exist');
  }
}

function isSafeRemoteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && isLoopbackHost(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  const ip = isIP(hostname.replace(/^\[|\]$/gu, ''));
  if (ip === 4) return hostname.startsWith('127.');
  return ip === 6 && ['[::1]', '::1'].includes(hostname);
}

function expandPlaceholders(value: string, pluginRoot: string, pluginData: string): string {
  return value.replaceAll(PLUGIN_ROOT_TOKEN, pluginRoot).replaceAll(PLUGIN_DATA_TOKEN, pluginData);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function requiredString(value: unknown, label: string, code = 'MANIFEST_SCHEMA_INVALID'): string {
  if (value !== undefined && typeof value !== 'string') {
    readerFail(code, `${label} must be a string`);
  }
  const result = value as string | undefined;
  if (result === undefined || result.length === 0) {
    readerFail(code, `${label} is required`);
  }
  return result;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') readerFail('MANIFEST_SCHEMA_INVALID', `${label} must be a string`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    readerFail('MCP_SCHEMA_INVALID', `${label} must contain strings`);
  }
  return value as string[];
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== 'string')) {
    readerFail('MCP_SCHEMA_INVALID', `${label} must map strings to strings`);
  }
  return value as Record<string, string>;
}

function readHeaders(value: unknown, serverName: string): Record<string, string> {
  const headers = stringRecord(value, `${serverName}.headers`);
  const names = new Set<string>();
  try {
    for (const [name, headerValue] of Object.entries(headers)) {
      const normalizedName = name.toLocaleLowerCase('en-US');
      if (names.has(normalizedName)) {
        readerFail('MCP_SCHEMA_INVALID', `${serverName}.headers contains a duplicate name`);
      }
      names.add(normalizedName);
      const validated = new Headers([[name, headerValue]]);
      if (!validated.has(name)) {
        readerFail('MCP_SCHEMA_INVALID', `${serverName}.headers contains an invalid field`);
      }
    }
  } catch (error) {
    if (error instanceof PluginReaderError) throw error;
    readerFail('MCP_SCHEMA_INVALID', `${serverName}.headers contains an invalid field`);
  }
  return headers;
}
