import type { ConsentLedger } from '@stonekeep/core/consent';
import type { SaasOutcome } from './types.js';

/** A step that runs after the database erasure succeeded (e.g. proof-of-erasure logging). */
export interface PostErasureStep {
  readonly name: string;
  readonly type: string;
  run(subject: string, options: { dryRun: boolean }): Promise<SaasOutcome>;
}

/**
 * Erasure hook for the consent ledger: records an `erased` event and redacts
 * the subject's earlier consent entries, so the ledger keeps only the hashed
 * id and the proof that erasure happened.
 */
export function consentLedgerStep(ledger: ConsentLedger): PostErasureStep {
  return {
    name: 'consent-ledger',
    type: 'ledger',
    run(subject, { dryRun }) {
      if (dryRun) {
        return Promise.resolve({
          status: 'succeeded',
          steps: [
            { action: 'record', resource: 'erasure_event', count: 1 },
            { action: 'redact', resource: 'consent_entry', count: ledger.liveEntryCount(subject) },
          ],
          retained: [
            {
              resource: 'subject_hmac',
              count: 1,
              reason: 'Hashed id and erasure event are kept as proof of erasure',
            },
          ],
        });
      }
      const r = ledger.recordErasure(subject);
      return Promise.resolve({
        status: 'succeeded',
        steps: [
          { action: 'record', resource: 'erasure_event', count: r.alreadyErased ? 0 : 1 },
          { action: 'redact', resource: 'consent_entry', count: r.redacted },
        ],
        retained: [
          {
            resource: 'subject_hmac',
            count: 1,
            reason: 'Hashed id and erasure event are kept as proof of erasure',
          },
        ],
        ...(r.alreadyErased ? { note: 'erasure already recorded' } : {}),
      });
    },
  };
}
