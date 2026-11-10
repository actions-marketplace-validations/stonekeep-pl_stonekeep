import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { StonekeepError } from '@stonekeep/core';
import { assertSafeToSend } from './guard.js';
import { ProposalSchema, type Proposal } from './proposal.js';

export interface PromptPayload {
  system: string;
  user: string;
}

/** Something that turns a prompt about schema metadata into a proposal. */
export interface ProposalProvider {
  readonly name: string;
  propose(prompt: PromptPayload): Promise<Proposal>;
}

/**
 * Wraps a provider so the privacy guard runs on the exact payload
 * immediately before any network request. Providers that talk to an LLM are
 * only ever handed out wrapped in this.
 */
export class GuardedProvider implements ProposalProvider {
  readonly name: string;
  private readonly inner: ProposalProvider;

  constructor(inner: ProposalProvider) {
    this.inner = inner;
    this.name = inner.name;
  }

  async propose(prompt: PromptPayload): Promise<Proposal> {
    assertSafeToSend(prompt); // rejects before the inner provider can open a connection
    return this.inner.propose(prompt);
  }
}

export const DEFAULT_MODEL = 'claude-opus-5-5';

export interface AnthropicProviderOptions {
  model?: string;
  apiKey?: string;
  /** Inject fetch (tests). Default: global fetch. */
  fetch?: typeof fetch;
  client?: Anthropic;
}

/** Claude via the official SDK with structured outputs (validated against ProposalSchema). */
class AnthropicProposalProvider implements ProposalProvider {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.name = `anthropic:${this.model}`;
    this.client =
      options.client ??
      new Anthropic({
        ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      });
  }

  async propose(prompt: PromptPayload): Promise<Proposal> {
    const response = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: 16000,
      // Server-side fallback if a safety classifier declines the request.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high', format: betaZodOutputFormat(ProposalSchema) },
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
    });
    if (response.stop_reason === 'refusal') {
      throw new StonekeepError(
        'CONFIG',
        'The model declined to produce a proposal; configure Stonekeep manually or try again',
      );
    }
    if (response.stop_reason === 'max_tokens') {
      throw new StonekeepError(
        'CONFIG',
        'The proposal was cut off (max_tokens); the schema may be too large for one request',
      );
    }
    if (response.parsed_output === null) {
      throw new StonekeepError('CONFIG', 'The model response did not match the proposal schema');
    }
    return response.parsed_output;
  }
}

/** The only way to obtain the Anthropic provider: always behind the privacy guard. */
export function createAnthropicProvider(options: AnthropicProviderOptions = {}): ProposalProvider {
  return new GuardedProvider(new AnthropicProposalProvider(options));
}
