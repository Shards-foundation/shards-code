import type { MavisBuildEnv, MavisRegion } from '@mavis/config';
import {
  resolveMCodeOAuthEndpointConfig,
  type MCodeOAuthEndpointEnvironment,
} from '@mavis/oauth-core';

import { createMcodeSharedAuthSession } from '../runtime/auth-session.js';
import { McodeAuthApplication, type McodeAuthApplicationOptions } from './application.js';
import { resolveMcodeAuthEnvironment } from './environment.js';
import { writeTuiRegionPreference } from './region-preference.js';

export interface CreateDefaultMcodeAuthApplicationOptions {
  dataDir: string;
  region?: MavisRegion;
  buildEnv?: MavisBuildEnv;
  oauthEndpointEnvironment?: MCodeOAuthEndpointEnvironment;
  createSharedSession?: typeof createMcodeSharedAuthSession;
  writeRegionPreference?: McodeAuthApplicationOptions['writeRegionPreference'];
  sharedAuthCore?: McodeAuthApplicationOptions['sharedAuthCore'];
}

export function createDefaultMcodeAuthApplication(
  options: CreateDefaultMcodeAuthApplicationOptions,
): McodeAuthApplication {
  const environment = resolveMcodeAuthEnvironment({
    runtimeRegion: options.region,
    runtimeBuildEnv: options.buildEnv,
  });
  const region = options.region ?? environment.region;
  const buildEnv = options.buildEnv ?? environment.buildEnv;
  const applicationOptions = {
    dataDir: options.dataDir,
    region,
    buildEnv,
    writeRegionPreference: options.writeRegionPreference ?? writeTuiRegionPreference,
  } satisfies Omit<McodeAuthApplicationOptions, 'sharedAuthCore'>;
  const createSharedAuthCore = (requestedRegion: MavisRegion) =>
    (options.createSharedSession ?? createMcodeSharedAuthSession)({
      dataDir: options.dataDir,
      region: requestedRegion,
      buildEnv,
      oauthEndpoints: resolveMCodeOAuthEndpointConfig(
        options.oauthEndpointEnvironment ?? process.env,
        { buildEnv, region: requestedRegion },
      ),
    });
  const sharedAuthCore = options.sharedAuthCore ?? createSharedAuthCore(region);
  return new McodeAuthApplication({
    ...applicationOptions,
    sharedAuthCore,
    resolveSharedAuthCore: createSharedAuthCore,
  });
}
