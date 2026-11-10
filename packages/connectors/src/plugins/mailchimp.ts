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
  type SubjectIdentity,
} from '../types.js';

/**
 * Mailchimp connector (Marketing API 3.0, https://mailchimp.com/developer/marketing/api/).
 *
 * Erasure = permanently delete the subscriber from every configured audience
 * (`POST /lists/{list}/members/{md5(email)}/actions/delete-permanent`). Mailchimp cannot
 * re-add a permanently deleted address without the person subscribing again.
 */
export const mailchimpConfigSchema = z
  .object({
    type: z.literal('mailchimp'),
    ...baseEntrySchema,
    /** Secret reference for the API key (`<key>-<dc>`, e.g. `abc…-us21`). */
    apiKey: secretRefSchema,
    /** Audience (list) ids to clean. */
    listIds: z.array(z.string().regex(/^[A-Za-z0-9]{6,20}$/)).min(1),
    identity: z.object({ email: identityColumnSchema }).strict(),
  })
  .strict();

export type MailchimpConfig = z.output<typeof mailchimpConfigSchema>;

const KEY_FORMAT = /^[0-9a-f]{20,40}-([a-z]{2}\d{1,2})$/;

function mailchimpErrorCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as { title?: unknown; status?: unknown };
  // Titles are short machine-ish strings ("Resource Not Found"); keep only code-like values.
  return safeCode(typeof b.title === 'string' ? b.title.replace(/\s+/g, '_') : b.status);
}

class MailchimpConnector implements SaasConnector {
  readonly type = 'mailchimp';
  readonly name: string;
  readonly identityColumns: Readonly<Record<string, string>>;
  private readonly http: HttpClient;

  constructor(
    private readonly config: MailchimpConfig,
    apiKey: string,
    dc: string,
    ctx: PluginContext,
  ) {
    this.name = config.name ?? 'mailchimp';
    this.identityColumns = { email: config.identity.email.column };
    const basic = Buffer.from(`stonekeep:${apiKey}`).toString('base64');
    this.http = new HttpClient({
      connector: this.name,
      baseUrl: `https://${dc}.api.mailchimp.com`,
      auth: () => Promise.resolve({ authorization: `Basic ${basic}` }),
      errorCode: mailchimpErrorCode,
      ...(ctx.logger ? { logger: ctx.logger } : {}),
      ...(ctx.http?.retry ? { retry: ctx.http.retry } : {}),
      ...(ctx.http?.sleep ? { sleep: ctx.http.sleep } : {}),
      ...(ctx.http?.random ? { random: ctx.http.random } : {}),
      ...(ctx.http?.timeoutMs !== undefined ? { timeoutMs: ctx.http.timeoutMs } : {}),
    });
  }

  async verifyCredentials(): Promise<void> {
    await this.http.request({ method: 'GET', path: '/3.0/ping' });
  }

  async erase(
    identity: SubjectIdentity,
    _mode: string,
    { dryRun }: { dryRun: boolean },
  ): Promise<SaasOutcome> {
    const email = identity.email?.trim().toLowerCase();
    if (!email) {
      return {
        status: 'skipped',
        steps: [],
        retained: [],
        note: 'no e-mail available for the subject',
      };
    }
    const hash = createHash('md5').update(email).digest('hex');
    let deleted = 0;
    for (const listId of this.config.listIds) {
      const found = await this.http.request({
        method: 'GET',
        path: '/3.0/lists/{list}/members/{hash}',
        params: { list: listId, hash },
        allowStatus: [404],
      });
      if (found.status === 404) continue;
      deleted++;
      if (!dryRun) {
        await this.http.request({
          method: 'POST',
          path: '/3.0/lists/{list}/members/{hash}/actions/delete-permanent',
          params: { list: listId, hash },
          idempotent: true,
          allowStatus: [404],
        });
      }
    }
    return {
      status: 'succeeded',
      steps: [{ action: 'delete', resource: 'subscriber', count: deleted }],
      retained: [],
      ...(deleted === 0 ? { note: 'subscriber not found in the configured audiences' } : {}),
    };
  }
}

export const mailchimpPlugin: SaasPlugin<MailchimpConfig> = {
  type: 'mailchimp',
  description: 'Mailchimp: permanently delete the subscriber from the configured audiences',
  configSchema: mailchimpConfigSchema,
  async create(config, ctx) {
    const key = await ctx.secrets.resolve(config.apiKey);
    const value = key.reveal();
    const match = KEY_FORMAT.exec(value);
    if (!match?.[1]) {
      throw new StonekeepError(
        'CONFIG',
        `${key.ref} is not a Mailchimp API key (expected <key>-<datacenter>, e.g. …-us21)`,
      );
    }
    return new MailchimpConnector(config, value, match[1], ctx);
  },
};
