import { createHash } from 'node:crypto';
import { StonekeepError } from '@stonekeep/core';
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
  type SaasStep,
  type SubjectIdentity,
} from '../types.js';

/**
 * Stripe connector (https://docs.stripe.com/api).
 *
 * Erasure = anonymize the Customer object and detach stored payment
 * methods and tax IDs. The Customer is NOT deleted and invoices are never
 * modified: finalized invoices are immutable accounting records that must be
 * retained for tax purposes (they keep their own snapshot of the billing
 * details, which is the legally required part).
 */
export const stripeConfigSchema = z
  .object({
    type: z.literal('stripe'),
    ...baseEntrySchema,
    /** Secret reference for a secret key (sk_) or restricted key (rk_). */
    apiKey: secretRefSchema,
    identity: z
      .object({
        customerId: identityColumnSchema.optional(),
        email: identityColumnSchema.optional(),
      })
      .strict()
      .refine(
        (i) => i.customerId !== undefined || i.email !== undefined,
        'map at least one of customerId or email',
      ),
    /** Live-mode keys are refused unless explicitly allowed. */
    allowLiveMode: z.boolean().default(false),
    /** Pin the API version (Stripe-Version header). */
    apiVersion: z.string().optional(),
    detachPaymentMethods: z.boolean().default(true),
    deleteTaxIds: z.boolean().default(true),
    apiBase: z.string().url().default('https://api.stripe.com'),
  })
  .strict();

export type StripeConfig = z.output<typeof stripeConfigSchema>;

const KEY_FORMAT = /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/;
const RETENTION_REASON = 'Invoices are retained as accounting records for tax compliance';
const MAX_PAGES = 100;

interface StripeObject {
  id: string;
  deleted?: boolean;
  metadata?: Record<string, string>;
}
interface StripeList<T> {
  data: T[];
  has_more: boolean;
}

function stripeErrorCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('error' in body)) return undefined;
  const err = body.error;
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { code?: unknown; type?: unknown };
  return safeCode(e.code) ?? safeCode(e.type);
}

/** Deterministic idempotency key: retries of the same logical write are de-duplicated by Stripe. */
function idempotencyKey(...parts: string[]): string {
  return `stonekeep-${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 40)}`;
}

class StripeConnector implements SaasConnector {
  readonly type = 'stripe';
  readonly name: string;
  readonly identityColumns: Readonly<Record<string, string>>;
  private readonly http: HttpClient;
  private readonly config: StripeConfig;

  constructor(config: StripeConfig, apiKey: string, ctx: PluginContext) {
    this.config = config;
    this.name = config.name ?? 'stripe';
    this.identityColumns = Object.fromEntries(
      Object.entries(config.identity).flatMap(([field, ref]) => (ref ? [[field, ref.column]] : [])),
    );
    const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` };
    if (config.apiVersion) headers['stripe-version'] = config.apiVersion;
    this.http = new HttpClient({
      connector: this.name,
      baseUrl: config.apiBase,
      auth: () => Promise.resolve(headers),
      errorCode: stripeErrorCode,
      ...(ctx.logger ? { logger: ctx.logger } : {}),
      ...(ctx.http?.retry ? { retry: ctx.http.retry } : {}),
      ...(ctx.http?.sleep ? { sleep: ctx.http.sleep } : {}),
      ...(ctx.http?.random ? { random: ctx.http.random } : {}),
      ...(ctx.http?.timeoutMs !== undefined ? { timeoutMs: ctx.http.timeoutMs } : {}),
    });
  }

  async verifyCredentials(): Promise<void> {
    await this.http.request({ method: 'GET', path: '/v1/customers', query: { limit: 1 } });
  }

  private async listAll<T extends StripeObject>(
    path: string,
    params: Record<string, string>,
    query: Record<string, string>,
  ): Promise<T[]> {
    const out: T[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await this.http.request<StripeList<T>>({
        method: 'GET',
        path,
        params,
        query: { ...query, limit: 100, starting_after: startingAfter },
      });
      out.push(...r.body.data);
      const last = r.body.data.at(-1);
      if (!r.body.has_more || last === undefined) break;
      startingAfter = last.id;
    }
    return out;
  }

  private async findCustomers(identity: SubjectIdentity): Promise<StripeObject[]> {
    if (identity.customerId) {
      const r = await this.http.request<StripeObject>({
        method: 'GET',
        path: '/v1/customers/{id}',
        params: { id: identity.customerId },
        allowStatus: [404],
      });
      return r.status === 404 || r.body.deleted === true ? [] : [r.body];
    }
    if (identity.email) {
      return (
        await this.listAll<StripeObject>('/v1/customers', {}, { email: identity.email })
      ).filter((c) => c.deleted !== true);
    }
    return [];
  }

  async erase(
    identity: SubjectIdentity,
    _mode: string,
    { dryRun }: { dryRun: boolean },
  ): Promise<SaasOutcome> {
    if (!identity.customerId && !identity.email) {
      return {
        status: 'skipped',
        steps: [],
        retained: [],
        note: 'no Stripe identity available for the subject',
      };
    }
    const customers = await this.findCustomers(identity);
    if (customers.length === 0) {
      return {
        status: 'succeeded',
        steps: [],
        retained: [],
        note: 'no matching Stripe customer (already erased or never existed)',
      };
    }

    let paymentMethods = 0;
    let taxIds = 0;
    let invoices = 0;
    for (const customer of customers) {
      // Count retained invoices (read-only; invoices are never modified).
      invoices += (await this.listAll<StripeObject>('/v1/invoices', {}, { customer: customer.id }))
        .length;

      if (this.config.detachPaymentMethods) {
        const pms = await this.listAll<StripeObject>(
          '/v1/customers/{id}/payment_methods',
          { id: customer.id },
          {},
        );
        paymentMethods += pms.length;
        if (!dryRun) {
          for (const pm of pms) {
            await this.http.request({
              method: 'POST',
              path: '/v1/payment_methods/{id}/detach',
              params: { id: pm.id },
              headers: { 'idempotency-key': idempotencyKey(pm.id, 'detach') },
              idempotent: true,
              allowStatus: [404],
            });
          }
        }
      }

      if (this.config.deleteTaxIds) {
        const ids = await this.listAll<StripeObject>(
          '/v1/customers/{id}/tax_ids',
          { id: customer.id },
          {},
        );
        taxIds += ids.length;
        if (!dryRun) {
          for (const t of ids) {
            await this.http.request({
              method: 'DELETE',
              path: '/v1/customers/{customer}/tax_ids/{id}',
              params: { customer: customer.id, id: t.id },
              allowStatus: [404],
            });
          }
        }
      }

      if (!dryRun) {
        // Empty string unsets a field in the Stripe API.
        const form: Record<string, string> = {
          name: '',
          email: '',
          phone: '',
          description: '',
          address: '',
          shipping: '',
          preferred_locales: '',
        };
        for (const key of Object.keys(customer.metadata ?? {})) form[`metadata[${key}]`] = '';
        form['metadata[stonekeep_anonymized]'] = 'true';
        await this.http.request({
          method: 'POST',
          path: '/v1/customers/{id}',
          params: { id: customer.id },
          form,
          headers: {
            'idempotency-key': idempotencyKey(
              customer.id,
              'anonymize',
              Object.keys(form).sort().join(','),
            ),
          },
          idempotent: true,
        });
      }
    }

    const steps: SaasStep[] = [
      { action: 'anonymize', resource: 'customer', count: customers.length },
    ];
    if (this.config.detachPaymentMethods)
      steps.push({ action: 'detach', resource: 'payment_method', count: paymentMethods });
    if (this.config.deleteTaxIds)
      steps.push({ action: 'delete', resource: 'tax_id', count: taxIds });
    return {
      status: 'succeeded',
      steps,
      retained: [{ resource: 'invoice', count: invoices, reason: RETENTION_REASON }],
    };
  }
}

export const stripePlugin: SaasPlugin<StripeConfig> = {
  type: 'stripe',
  description:
    'Stripe: anonymize the customer, detach payment methods and tax IDs, retain invoices',
  configSchema: stripeConfigSchema,
  async create(config, ctx) {
    const key = await ctx.secrets.resolve(config.apiKey);
    const value = key.reveal();
    if (!KEY_FORMAT.test(value)) {
      throw new StonekeepError(
        'CONFIG',
        `${key.ref} is not a Stripe secret or restricted key (expected sk_… or rk_…)`,
      );
    }
    if (value.includes('_live_') && !config.allowLiveMode) {
      throw new StonekeepError(
        'CONFIG',
        `${key.ref} is a live-mode key; set allowLiveMode: true to use it`,
      );
    }
    return new StripeConnector(config, value, ctx);
  },
};
