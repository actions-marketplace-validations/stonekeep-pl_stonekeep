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
  type SubjectIdentity,
} from '../types.js';

/**
 * PayU (Poland) connector, https://developers.payu.com/europe/.
 *
 * Erasure = delete the customer's stored card tokens (`DELETE /api/v2_1/tokens/{token}`).
 * Both calls need a `trusted_merchant` OAuth token issued for the customer's e-mail and
 * `ext_customer_id`, so both identities must be mapped. Orders and payments are NOT touched:
 * PayU and the merchant must keep them as accounting records. BLIK tokens cannot be deleted
 * through this API (PayU limitation) and are reported as retained.
 */
export const payuConfigSchema = z
  .object({
    type: z.literal('payu'),
    ...baseEntrySchema,
    /** OAuth client id of the POS (numeric). */
    clientId: secretRefSchema,
    /** OAuth client secret (the "second key (MD5)" is NOT the client secret). */
    clientSecret: secretRefSchema,
    identity: z
      .object({
        email: identityColumnSchema,
        /** The `extCustomerId` you sent to PayU when the customer paid. */
        extCustomerId: identityColumnSchema,
      })
      .strict(),
    /** Sandbox is the default: production must be chosen explicitly. */
    environment: z.enum(['sandbox', 'production']).default('sandbox'),
    apiBase: z.string().url().optional(),
  })
  .strict();

export type PayuConfig = z.output<typeof payuConfigSchema>;

const HOSTS = { production: 'https://secure.payu.com', sandbox: 'https://secure.snd.payu.com' };
const RETENTION_REASON =
  'Orders and payments are kept as accounting records (tax and anti-money-laundering rules)';

interface PayuToken {
  access_token?: string;
}
interface PayuMethods {
  cardTokens?: { value?: string }[];
  blikTokens?: unknown[];
}

function payuErrorCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as { error?: unknown; status?: { statusCode?: unknown } };
  return safeCode(b.error) ?? safeCode(b.status?.statusCode);
}

class PayuConnector implements SaasConnector {
  readonly type = 'payu';
  readonly name: string;
  readonly identityColumns: Readonly<Record<string, string>>;
  private readonly http: HttpClient;

  constructor(
    config: PayuConfig,
    private readonly clientId: string,
    private readonly clientSecret: string,
    ctx: PluginContext,
  ) {
    this.name = config.name ?? 'payu';
    this.identityColumns = {
      email: config.identity.email.column,
      extCustomerId: config.identity.extCustomerId.column,
    };
    this.http = new HttpClient({
      connector: this.name,
      baseUrl: config.apiBase ?? HOSTS[config.environment],
      errorCode: payuErrorCode,
      ...(ctx.logger ? { logger: ctx.logger } : {}),
      ...(ctx.http?.retry ? { retry: ctx.http.retry } : {}),
      ...(ctx.http?.sleep ? { sleep: ctx.http.sleep } : {}),
      ...(ctx.http?.random ? { random: ctx.http.random } : {}),
      ...(ctx.http?.timeoutMs !== undefined ? { timeoutMs: ctx.http.timeoutMs } : {}),
    });
  }

  /** Client-credentials token: proves the POS credentials without touching any customer. */
  async verifyCredentials(): Promise<void> {
    const r = await this.http.request<PayuToken>({
      method: 'POST',
      path: '/pl/standard/user/oauth/authorize',
      form: {
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      },
      idempotent: true,
      noAuth: true,
    });
    if (!r.body.access_token) throw new Error('payu: no access token in the response');
  }

  private async customerToken(identity: SubjectIdentity): Promise<string> {
    const r = await this.http.request<PayuToken>({
      method: 'POST',
      path: '/pl/standard/user/oauth/authorize',
      form: {
        grant_type: 'trusted_merchant',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        email: identity.email ?? '',
        ext_customer_id: identity.extCustomerId ?? '',
      },
      idempotent: true,
      noAuth: true,
    });
    if (!r.body.access_token) throw new Error('payu: no access token in the response');
    return r.body.access_token;
  }

  async erase(
    identity: SubjectIdentity,
    _mode: string,
    { dryRun }: { dryRun: boolean },
  ): Promise<SaasOutcome> {
    if (!identity.email || !identity.extCustomerId) {
      return {
        status: 'skipped',
        steps: [],
        retained: [],
        note: 'PayU needs both the e-mail and the extCustomerId of the subject',
      };
    }
    const bearer = { authorization: `Bearer ${await this.customerToken(identity)}` };
    const methods = await this.http.request<PayuMethods>({
      method: 'GET',
      path: '/api/v2_1/paymethods',
      headers: { ...bearer, 'cache-control': 'no-cache' },
      allowStatus: [404],
    });
    // A 404 answers without a body: treat it as "no stored methods".
    const payMethods = (methods.body as PayuMethods | undefined) ?? {};
    const tokens = (payMethods.cardTokens ?? []).flatMap((t) => (t.value ? [t.value] : []));
    if (!dryRun) {
      for (const token of tokens) {
        await this.http.request({
          method: 'DELETE',
          path: '/api/v2_1/tokens/{token}',
          params: { token },
          headers: { ...bearer, 'cache-control': 'no-cache' },
          allowStatus: [404],
        });
      }
    }
    const blik = payMethods.blikTokens?.length ?? 0;
    return {
      status: 'succeeded',
      steps: [{ action: 'delete', resource: 'card_token', count: tokens.length }],
      retained: [
        { resource: 'order', count: 0, reason: RETENTION_REASON },
        ...(blik > 0
          ? [
              {
                resource: 'blik_token',
                count: blik,
                reason: 'PayU does not allow deleting BLIK tokens through the API',
              },
            ]
          : []),
      ],
      note: 'order count is not available through the PayU API',
    };
  }
}

export const payuPlugin: SaasPlugin<PayuConfig> = {
  type: 'payu',
  description: 'PayU (PL): delete stored card tokens, retain orders and payments',
  configSchema: payuConfigSchema,
  async create(config, ctx) {
    const id = await ctx.secrets.resolve(config.clientId);
    const secret = await ctx.secrets.resolve(config.clientSecret);
    return new PayuConnector(config, id.reveal(), secret.reveal(), ctx);
  },
};
