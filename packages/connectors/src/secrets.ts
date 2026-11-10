import { readFile } from 'node:fs/promises';
import { inspect } from 'node:util';
import { StonekeepError } from '@stonekeep/core';
import { z } from 'zod';

const REDACTED = '[redacted]';

/**
 * A resolved credential. The value is only available through `reveal()`;
 * every implicit conversion (string interpolation, JSON, util.inspect,
 * console.log) prints a redacted placeholder that names the reference only.
 */
export class Secret {
  readonly #value: string;
  /** The reference it was resolved from, e.g. `env:STRIPE_API_KEY`. Safe to show. */
  readonly ref: string;

  constructor(value: string, ref: string) {
    this.#value = value;
    this.ref = ref;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return `${REDACTED} (${this.ref})`;
  }

  toJSON(): string {
    return this.toString();
  }

  [inspect.custom](): string {
    return `Secret(${this.toString()})`;
  }
}

/**
 * Credentials in config are always *references*, never literal values:
 * `env:NAME`, `file:/run/secrets/name`, or `<scheme>:<id>` for a registered
 * secret-manager provider (e.g. `vault:kv/stonekeep/stripe`).
 */
export const secretRefSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]*:\S+$/,
    'must be a secret reference such as "env:STRIPE_API_KEY" or "file:/run/secrets/stripe"; literal secrets are not allowed in config',
  );

export interface SecretProvider {
  /** Return the secret for `id` (the part after `scheme:`), or undefined if absent. */
  get(id: string): Promise<string | undefined>;
}

export class EnvSecretProvider implements SecretProvider {
  private readonly env: Readonly<Record<string, string | undefined>>;

  constructor(env: Readonly<Record<string, string | undefined>>) {
    this.env = env;
  }

  get(id: string): Promise<string | undefined> {
    return Promise.resolve(this.env[id]);
  }
}

/** Mounted secrets (Docker/Kubernetes secrets, CSI secret-store drivers). */
export class FileSecretProvider implements SecretProvider {
  async get(id: string): Promise<string | undefined> {
    try {
      return (await readFile(id, 'utf8')).trim();
    } catch {
      return undefined;
    }
  }
}

export class SecretResolver {
  private readonly providers = new Map<string, SecretProvider>();

  register(scheme: string, provider: SecretProvider): this {
    this.providers.set(scheme, provider);
    return this;
  }

  async resolve(ref: string): Promise<Secret> {
    const parsed = secretRefSchema.safeParse(ref);
    if (!parsed.success) {
      // Do not echo the value: it might be a pasted secret.
      throw new StonekeepError(
        'CONFIG',
        'Invalid secret reference (expected "scheme:id", e.g. env:NAME)',
      );
    }
    const colon = ref.indexOf(':');
    const scheme = ref.slice(0, colon);
    const id = ref.slice(colon + 1);
    const provider = this.providers.get(scheme);
    if (!provider) {
      throw new StonekeepError(
        'CONFIG',
        `No secret provider registered for "${scheme}:" (secret ${ref})`,
      );
    }
    const value = await provider.get(id);
    if (value === undefined || value.length === 0) {
      throw new StonekeepError('CONFIG', `Secret ${ref} is not set`);
    }
    return new Secret(value, ref);
  }
}

/** `env:` and `file:` providers. Register more (vault, aws-sm, gcp-sm, ...) as needed. */
export function defaultSecretResolver(
  env: Readonly<Record<string, string | undefined>>,
): SecretResolver {
  return new SecretResolver()
    .register('env', new EnvSecretProvider(env))
    .register('file', new FileSecretProvider());
}
