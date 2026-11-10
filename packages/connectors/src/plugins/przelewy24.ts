import { z } from 'zod';
import { HttpClient, safeCode } from '../http.js';
import { secretRefSchema } from '../secrets.js';
import {
  baseEntrySchema,
  identityColumnSchema,
  type PluginContext,
  type SaasConnector,
  type SaasOutcome,
  type SaasPlugin,
} from '../types.js';

/**
 * Przelewy24 (Poland) connector, https://developers.przelewy24.pl/.
 *
 * Przelewy24 exposes no customer object and no documented endpoint to erase a person:
 * it keeps transactions as accounting records. So this connector does not pretend to erase.
 * It verifies the API credentials (`GET /api/v1/testAccess`) and reports the subject as
 * "handled manually": the console lists Przelewy24 as a processor that still holds
 * transaction records, and the DPO must send the request to Przelewy24 (their data
 * protection contact) if the subject also asked for erasure there.
 */
export const przelewy24ConfigSchema = z
  .object({
    type: z.literal('przelewy24'),
    ...baseEntrySchema,
    /** Shop (POS) id, usually equal to the merchant id. */
    posId: z.string().regex(/^\d{3,12}$/, 'posId is a number'),
    /** Reports/API key from the Przelewy24 panel ("Klucz do raportów"). */
    apiKey: secretRefSchema,
    /** The column that holds the subject's e-mail, to count transactions later. */
    identity: z.object({ email: identityColumnSchema.optional() }).strict().default({}),
    environment: z.enum(['sandbox', 'production']).default('sandbox'),
    apiBase: z.string().url().optional(),
  })
  .strict();

export type Przelewy24Config = z.output<typeof przelewy24ConfigSchema>;

const HOSTS = {
  production: 'https://secure.przelewy24.pl',
  sandbox: 'https://sandbox.przelewy24.pl',
};

function p24ErrorCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as { code?: unknown; error?: unknown };
  return safeCode(b.code) ?? safeCode(b.error);
}

class Przelewy24Connector implements SaasConnector {
  readonly type = 'przelewy24';
  readonly name: string;
  readonly identityColumns: Readonly<Record<string, string>>;
  private readonly http: HttpClient;

  constructor(config: Przelewy24Config, apiKey: string, ctx: PluginContext) {
    this.name = config.name ?? 'przelewy24';
    this.identityColumns = config.identity.email ? { email: config.identity.email.column } : {};
    const basic = Buffer.from(`${config.posId}:${apiKey}`).toString('base64');
    this.http = new HttpClient({
      connector: this.name,
      baseUrl: config.apiBase ?? HOSTS[config.environment],
      auth: () => Promise.resolve({ authorization: `Basic ${basic}` }),
      errorCode: p24ErrorCode,
      ...(ctx.logger ? { logger: ctx.logger } : {}),
      ...(ctx.http?.retry ? { retry: ctx.http.retry } : {}),
      ...(ctx.http?.sleep ? { sleep: ctx.http.sleep } : {}),
      ...(ctx.http?.random ? { random: ctx.http.random } : {}),
      ...(ctx.http?.timeoutMs !== undefined ? { timeoutMs: ctx.http.timeoutMs } : {}),
    });
  }

  async verifyCredentials(): Promise<void> {
    await this.http.request({ method: 'GET', path: '/api/v1/testAccess' });
  }

  erase(): Promise<SaasOutcome> {
    return Promise.resolve({
      status: 'skipped',
      steps: [],
      retained: [
        {
          resource: 'transaction',
          count: 0,
          reason: 'Przelewy24 keeps transactions as accounting records and offers no erase API',
        },
      ],
      note: 'manual step: if the person also asks Przelewy24 to erase data, send the request to Przelewy24',
    });
  }
}

export const przelewy24Plugin: SaasPlugin<Przelewy24Config> = {
  type: 'przelewy24',
  description:
    'Przelewy24 (PL): verifies access and flags the manual step (no erase API exists); transactions are retained',
  configSchema: przelewy24ConfigSchema,
  async create(config, ctx) {
    const key = await ctx.secrets.resolve(config.apiKey);
    return new Przelewy24Connector(config, key.reveal(), ctx);
  },
};
