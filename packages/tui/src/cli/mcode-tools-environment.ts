import path from 'node:path';

import { stripRuntimeBoundaryKeysFrom } from '@mavis/shared/runtime-boundary-env';

type ProcessEnvironment = Record<string, string | undefined>;

const HOST_ENVIRONMENT_KEYS = {
  runtimeExecutable: '__MAVIS_MCODE_TOOLS_RUNTIME_EXECUTABLE',
  brokerEndpoint: '__MAVIS_MCODE_TOOLS_BROKER_ENDPOINT',
  brokerCapabilityFile: '__MAVIS_MCODE_TOOLS_BROKER_CAPABILITY_FILE',
  configDir: '__MAVIS_MCODE_TOOLS_CONFIG_DIR',
  region: '__MAVIS_MCODE_TOOLS_REGION',
  extraHeaders: '__MAVIS_MCODE_TOOLS_EXTRA_HEADERS',
} as const;

const CHILD_ENVIRONMENT_KEYS_TO_CLEAR = [
  'IS_SANDBOX',
  'MCODE_API_BASE_URL',
  'MCODE_AUTH_BASE_URL',
  'MCODE_CLIENT_ID',
  'MCODE_SCOPE',
  'MCODE_AUTH_PROVIDER',
  'MCODE_AUTH_BROKER_ENDPOINT',
  'MCODE_AUTH_BROKER_CAPABILITY_FILE',
  'MCODE_EXTRA_HEADERS',
  'MCODE_REGION',
  'MCODE_CONFIG_DIR',
] as const;

export interface TuiMcodeToolsHostEnvironmentActivation {
  ensureCommandPath(): void;
  restore(): void;
}

export function activateTuiMcodeToolsHostEnvironment(
  environment: ProcessEnvironment,
  options: {
    runtimeExecutable: string;
    brokerEndpoint: string;
    brokerCapabilityFile: string;
    configDir: string;
    region: 'cn' | 'en';
    commandBinDir: string;
    bedrockLane?: string;
  },
): TuiMcodeToolsHostEnvironmentActivation {
  if (!path.isAbsolute(options.runtimeExecutable)) {
    throw new Error('The Shards Code mcode-tools runtime executable must be absolute.');
  }
  const assigned: ProcessEnvironment = {
    [HOST_ENVIRONMENT_KEYS.runtimeExecutable]: options.runtimeExecutable,
    [HOST_ENVIRONMENT_KEYS.brokerEndpoint]: options.brokerEndpoint,
    [HOST_ENVIRONMENT_KEYS.brokerCapabilityFile]: options.brokerCapabilityFile,
    [HOST_ENVIRONMENT_KEYS.configDir]: options.configDir,
    [HOST_ENVIRONMENT_KEYS.region]: options.region,
    [HOST_ENVIRONMENT_KEYS.extraHeaders]: options.bedrockLane
      ? `bedrock_lane:${options.bedrockLane},bedrock-lane:${options.bedrockLane}`
      : undefined,
  };
  const previous = Object.fromEntries(
    Object.keys(assigned).map((key) => [key, environment[key]]),
  ) as ProcessEnvironment;
  for (const [key, value] of Object.entries(assigned)) setEnvironmentValue(environment, key, value);

  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const commandBinDir = path.normalize(options.commandBinDir);
  const commandPathWasPresent = splitPath(environment[pathKey]).includes(commandBinDir);
  const ensureCommandPath = (): void => {
    const entries = splitPath(environment[pathKey]).filter((entry) => entry !== commandBinDir);
    environment[pathKey] = [commandBinDir, ...entries].join(path.delimiter);
  };
  ensureCommandPath();

  let restored = false;
  return {
    ensureCommandPath,
    restore(): void {
      if (restored) return;
      restored = true;
      for (const [key, value] of Object.entries(previous)) {
        if (environment[key] === assigned[key]) setEnvironmentValue(environment, key, value);
      }
      if (!commandPathWasPresent) {
        environment[pathKey] = splitPath(environment[pathKey])
          .filter((entry) => entry !== commandBinDir)
          .join(path.delimiter);
      }
    },
  };
}

export function configureMcodeToolsChildEnvironment(
  environment: ProcessEnvironment = process.env,
): boolean {
  const brokerEndpoint = environment[HOST_ENVIRONMENT_KEYS.brokerEndpoint]?.trim();
  const brokerCapabilityFile = environment[HOST_ENVIRONMENT_KEYS.brokerCapabilityFile]?.trim();
  const configDir = environment[HOST_ENVIRONMENT_KEYS.configDir]?.trim();
  const region = environment[HOST_ENVIRONMENT_KEYS.region]?.trim();
  const extraHeaders = environment[HOST_ENVIRONMENT_KEYS.extraHeaders]?.trim();
  const runtimeExecutable = environment[HOST_ENVIRONMENT_KEYS.runtimeExecutable]?.trim();
  const hostValues = [runtimeExecutable, brokerEndpoint, brokerCapabilityFile, configDir, region];
  if (hostValues.every((value) => !value)) return false;
  if (hostValues.some((value) => !value) || (region !== 'cn' && region !== 'en')) {
    throw new Error('The Shards Code mcode-tools host environment is incomplete. Restart Shards Code.');
  }

  stripRuntimeBoundaryKeysFrom(environment, 'agent-runtime');
  const hostEnvironmentKeys: readonly string[] = Object.values(HOST_ENVIRONMENT_KEYS);
  for (const key of Object.keys(environment)) {
    const normalizedKey = key.toUpperCase();
    if (
      CHILD_ENVIRONMENT_KEYS_TO_CLEAR.includes(
        normalizedKey as (typeof CHILD_ENVIRONMENT_KEYS_TO_CLEAR)[number],
      ) ||
      hostEnvironmentKeys.includes(normalizedKey)
    ) {
      delete environment[key];
    }
  }

  environment.ELECTRON_RUN_AS_NODE = '1';
  environment.MCODE_REGION = region;
  environment.MCODE_CONFIG_DIR = configDir;
  environment.MCODE_AUTH_PROVIDER = 'shared-broker';
  environment.MCODE_AUTH_BROKER_ENDPOINT = brokerEndpoint;
  environment.MCODE_AUTH_BROKER_CAPABILITY_FILE = brokerCapabilityFile;
  if (extraHeaders) environment.MCODE_EXTRA_HEADERS = extraHeaders;
  return true;
}

function splitPath(value: string | undefined): string[] {
  return (value ?? '').split(path.delimiter).filter(Boolean).map(path.normalize);
}

function setEnvironmentValue(
  environment: ProcessEnvironment,
  key: string,
  value: string | undefined,
): void {
  if (value === undefined) delete environment[key];
  else environment[key] = value;
}
