import { auth0Plugin } from './plugins/auth0.js';
import { mailchimpPlugin } from './plugins/mailchimp.js';
import { payuPlugin } from './plugins/payu.js';
import { przelewy24Plugin } from './plugins/przelewy24.js';
import { stripePlugin } from './plugins/stripe.js';
import { ConnectorRegistry } from './registry.js';
import { defaultSecretResolver } from './secrets.js';
import type { PluginContext, SaasConnector } from './types.js';

export * from './types.js';
export * from './secrets.js';
export {
  DEFAULT_RETRY,
  HttpClient,
  HttpError,
  backoffMs,
  retryAfterMs,
  safeCode,
  type HttpClientOptions,
  type HttpEvent,
  type HttpLogger,
  type HttpRequest,
  type HttpResponse,
  type RetryPolicy,
} from './http.js';
export { ConnectorRegistry } from './registry.js';
export { consentLedgerStep, type PostErasureStep } from './ledger-step.js';
export { stripePlugin, stripeConfigSchema, type StripeConfig } from './plugins/stripe.js';
export { payuPlugin, payuConfigSchema, type PayuConfig } from './plugins/payu.js';
export {
  przelewy24Plugin,
  przelewy24ConfigSchema,
  type Przelewy24Config,
} from './plugins/przelewy24.js';
export {
  mailchimpPlugin,
  mailchimpConfigSchema,
  type MailchimpConfig,
} from './plugins/mailchimp.js';
export { auth0Plugin, auth0ConfigSchema, type Auth0Config } from './plugins/auth0.js';
export {
  describeError,
  runDeletion,
  type ConnectorError,
  type ConnectorReport,
  type ConnectorStatus,
  type DatabaseConnector,
  type DeletionOptions,
  type DeletionReport,
  type OrchestratorEvent,
} from './orchestrator.js';

/** A registry with the built-in plugins (stripe, auth0, payu, przelewy24, mailchimp). */
export function createDefaultRegistry(): ConnectorRegistry {
  return new ConnectorRegistry()
    .register(stripePlugin)
    .register(auth0Plugin)
    .register(payuPlugin)
    .register(przelewy24Plugin)
    .register(mailchimpPlugin);
}

/** Instantiate the `saas:` entries of a connector config with env/file secrets. */
export function createSaasConnectors(
  entries: readonly unknown[],
  env: Readonly<Record<string, string | undefined>>,
  options: Partial<PluginContext> & { registry?: ConnectorRegistry } = {},
): Promise<SaasConnector[]> {
  const { registry = createDefaultRegistry(), ...ctx } = options;
  return registry.createAll(entries, {
    secrets: ctx.secrets ?? defaultSecretResolver(env),
    ...ctx,
  });
}
