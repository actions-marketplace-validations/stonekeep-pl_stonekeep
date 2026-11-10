import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from '../config.js';
import { readDataMap } from '../datamap.js';
import { StonekeepError } from '../errors.js';
import { loadConnectorConfig, type LoadedConnectorConfig } from './config.js';
import type { PiiContext } from './pii.js';
import { PostgresConnector } from './postgres.js';
import type { EngineLogger } from './types.js';

export interface EngineContext {
  connector: LoadedConnectorConfig;
  pii: PiiContext;
  /** False when the datamap file does not exist (rules-only classification). */
  datamapFound: boolean;
}

/**
 * Load the connector YAML plus the Stage 1 scan config (`stonekeep.config.json`
 * next to it, optional) and the committed datamap (optional but recommended).
 */
export function loadEngineContext(connectorPath: string): EngineContext {
  const connector = loadConnectorConfig(connectorPath);
  const root = connector.file !== undefined ? dirname(connector.file) : process.cwd();
  const scan = loadConfig(root);
  const datamapFound = existsSync(connector.datamapPath);
  return {
    connector,
    datamapFound,
    pii: {
      datamap: datamapFound ? readDataMap(connector.datamapPath) : undefined,
      ruleSet: scan.ruleSet,
      minConfidence: scan.minConfidence,
      overrides: scan.overrides,
    },
  };
}

/** Read a required env var. Error messages name the variable, never its value. */
export function requireEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  purpose: string,
): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new StonekeepError('CONFIG', `Environment variable ${name} (${purpose}) is not set`);
  }
  return value;
}

export function createPostgresConnector(
  ctx: EngineContext,
  env: Readonly<Record<string, string | undefined>>,
  logger?: EngineLogger,
): PostgresConnector {
  const { config } = ctx.connector;
  return new PostgresConnector({
    config,
    url: requireEnv(env, config.connection.urlEnv, 'database URL'),
    pii: ctx.pii,
    ...(logger ? { logger } : {}),
  });
}
