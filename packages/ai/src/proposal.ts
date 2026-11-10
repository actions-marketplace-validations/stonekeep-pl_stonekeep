import { MASK_STRATEGIES } from '@stonekeep/core/engine';
import { z } from 'zod/v4';

/**
 * What the assistant must return (enforced with structured outputs). Arrays
 * instead of maps keep the JSON Schema strict-mode friendly.
 */
export const ProposalSchema = z.object({
  subject: z.object({
    table: z.string().describe('Entity that represents the person (data subject), e.g. users'),
    key: z.string().describe('Column that identifies the subject, usually its primary key'),
  }),
  retain: z
    .array(
      z.object({
        table: z.string(),
        reason: z
          .string()
          .describe('Short legal/business reason, e.g. "Invoices must be kept for tax purposes"'),
        anonymize: z
          .array(z.string())
          .describe('Personal-data columns to anonymize in retained rows'),
      }),
    )
    .describe(
      'Tables whose rows must be kept (e.g. accounting records) and detached from the person',
    ),
  foreignKeys: z
    .array(
      z.object({
        table: z.string(),
        column: z.string(),
        references: z.string().describe('"parent_table.column"'),
      }),
    )
    .describe(
      'Only relations the database probably does NOT enforce (soft references such as requester_id)',
    ),
  mask: z
    .array(z.object({ table: z.string(), column: z.string(), strategy: z.enum(MASK_STRATEGIES) }))
    .describe('Staging masking strategy per personal-data column'),
  exclude: z
    .array(z.string())
    .describe('Tables Stonekeep should never touch (e.g. migration bookkeeping)'),
  notes: z.array(z.string()).describe('Short review notes for the human; no personal data'),
});

export type Proposal = z.infer<typeof ProposalSchema>;
