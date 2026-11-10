import { StonekeepError } from '@stonekeep/core';
import { z } from 'zod';
import { HttpClient, safeCode } from '../http.js';
import { secretRefSchema, type Secret } from '../secrets.js';
import {
  baseEntrySchema,
  identityColumnSchema,
  type PluginContext,
  type SaasConnector,
  type SaasOutcome,
  type SaasPlugin,
  type SubjectIdentity,
} from '../types.js';

/**
 * Auth0 connector (Management API v2, https://auth0.com/docs/api/management/v2).
 * Erasure = delete the user identity profile(s). Identity profiles cannot be
 * meaningfully anonymized, so both `delete` and `anonymize` modes delete.
 */
export const auth0ConfigSchema = z
  .object({
    type: z.literal('auth0'),
    ...baseEntrySchema,
    /** Tenant or custom domain, e.g. `acme.eu.auth0.com`. */
    domain: z
      .string()
      .regex(
        /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i,
        'must be a hostname such as acme.eu.auth0.com',
      ),
    credentials: z.union([
      /** Machine-to-machine application (client credentials grant). Needs read:users and delete:users. */
      z.object({ clientId: secretRefSchema, clientSecret: secretRefSchema }).strict(),
      /** A pre-issued Management API token. */
      z.object({ token: secretRefSchema }).strict(),
    ]),
    identity: z
      .object({ userId: identityColumnSchema.optional(), email: identityColumnSchema.optional() })
      .strict()
      .refine(
        (i) => i.userId !== undefined || i.email !== undefined,
        'map at least one of userId or email',
      ),
    /** Defaults to https://<domain>/api/v2/ */
    audience: z.string().url().optional(),
  })
  .strict();

export type Auth0Config = z.output<typeof auth0ConfigSchema>;

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

function auth0ErrorCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as { errorCode?: unknown; error?: unknown };
  return safeCode(b.errorCode) ?? safeCode(b.error);
}

type Credentials =
  { kind: 'client'; clientId: Secret; clientSecret: Secret } | { kind: 'token'; token: Secret };

class Auth0Connector implements SaasConnector {
  readonly type = 'auth0';
  readonly name: string;
  readonly identityColumns: Readonly<Record<string, string>>;
  private readonly http: HttpClient;
  private readonly credentials: Credentials;
  private readonly audience: string;
  private cached: { token: string; expiresAt: number } | undefined;

  constructor(config: Auth0Config, credentials: Credentials, ctx: PluginContext) {
    this.name = config.name ?? 'auth0';
    this.credentials = credentials;
    this.audience = config.audience ?? `https://${config.domain}/api/v2/`;
    this.identityColumns = Object.fromEntries(
      Object.entries(config.identity).flatMap(([field, ref]) => (ref ? [[field, ref.column]] : [])),
    );
    this.http = new HttpClient({
      connector: this.name,
      baseUrl: `https://${config.domain}`,
      auth: async () => ({ authorization: `Bearer ${await this.accessToken()}` }),
      onUnauthorized: () => {
        // A cached M2M token may have been revoked: fetch a new one once.
        if (this.credentials.kind !== 'client') return Promise.resolve(false);
        this.cached = undefined;
        return Promise.resolve(true);
      },
      errorCode: auth0ErrorCode,
      ...(ctx.logger ? { logger: ctx.logger } : {}),
      ...(ctx.http?.retry ? { retry: ctx.http.retry } : {}),
      ...(ctx.http?.sleep ? { sleep: ctx.http.sleep } : {}),
      ...(ctx.http?.random ? { random: ctx.http.random } : {}),
      ...(ctx.http?.timeoutMs !== undefined ? { timeoutMs: ctx.http.timeoutMs } : {}),
    });
  }

  private async accessToken(): Promise<string> {
    if (this.credentials.kind === 'token') return this.credentials.token.reveal();
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.token;
    const r = await this.http.request<TokenResponse>({
      method: 'POST',
      path: '/oauth/token',
      noAuth: true,
      idempotent: true,
      json: {
        grant_type: 'client_credentials',
        client_id: this.credentials.clientId.reveal(),
        client_secret: this.credentials.clientSecret.reveal(),
        audience: this.audience,
      },
    });
    if (typeof r.body.access_token !== 'string' || r.body.access_token.length === 0) {
      throw new StonekeepError('CONFIG', `${this.name}: token endpoint returned no access_token`);
    }
    // Refresh a minute early.
    this.cached = {
      token: r.body.access_token,
      expiresAt: Date.now() + Math.max(0, (r.body.expires_in - 60) * 1000),
    };
    return this.cached.token;
  }

  async verifyCredentials(): Promise<void> {
    await this.http.request({
      method: 'GET',
      path: '/api/v2/users',
      query: { per_page: 1, include_totals: 'false' },
    });
  }

  private async userIds(identity: SubjectIdentity): Promise<string[]> {
    if (identity.userId) {
      const r = await this.http.request<{ user_id?: string }>({
        method: 'GET',
        path: '/api/v2/users/{id}',
        params: { id: identity.userId },
        allowStatus: [404],
      });
      return r.status === 404 ? [] : [identity.userId];
    }
    if (identity.email) {
      // Returns every identity (connection) that uses the address.
      const r = await this.http.request<{ user_id: string }[]>({
        method: 'GET',
        path: '/api/v2/users-by-email',
        query: { email: identity.email },
      });
      return r.body.map((u) => u.user_id).filter((id) => typeof id === 'string');
    }
    return [];
  }

  async erase(
    identity: SubjectIdentity,
    _mode: string,
    { dryRun }: { dryRun: boolean },
  ): Promise<SaasOutcome> {
    if (!identity.userId && !identity.email) {
      return {
        status: 'skipped',
        steps: [],
        retained: [],
        note: 'no Auth0 identity available for the subject',
      };
    }
    const ids = await this.userIds(identity);
    if (!dryRun) {
      for (const id of ids) {
        // 204 on success; 404 means it is already gone (idempotent re-runs).
        await this.http.request({
          method: 'DELETE',
          path: '/api/v2/users/{id}',
          params: { id },
          allowStatus: [404],
        });
      }
    }
    return {
      status: 'succeeded',
      steps: [{ action: 'delete', resource: 'user', count: ids.length }],
      retained: [],
      ...(ids.length === 0
        ? { note: 'no matching Auth0 user (already deleted or never existed)' }
        : {}),
    };
  }
}

export const auth0Plugin: SaasPlugin<Auth0Config> = {
  type: 'auth0',
  description: 'Auth0: delete the user identity profile via the Management API',
  configSchema: auth0ConfigSchema,
  async create(config, ctx) {
    const c = config.credentials;
    const credentials: Credentials =
      'token' in c
        ? { kind: 'token', token: await ctx.secrets.resolve(c.token) }
        : {
            kind: 'client',
            clientId: await ctx.secrets.resolve(c.clientId),
            clientSecret: await ctx.secrets.resolve(c.clientSecret),
          };
    if (credentials.kind === 'token' && credentials.token.reveal().split('.').length !== 3) {
      throw new StonekeepError(
        'CONFIG',
        `${credentials.token.ref} is not a JWT (Management API tokens are JWTs)`,
      );
    }
    if (
      credentials.kind === 'client' &&
      !/^[A-Za-z0-9]{16,64}$/.test(credentials.clientId.reveal())
    ) {
      throw new StonekeepError(
        'CONFIG',
        `${credentials.clientId.ref} does not look like an Auth0 client id`,
      );
    }
    return new Auth0Connector(config, credentials, ctx);
  },
};
