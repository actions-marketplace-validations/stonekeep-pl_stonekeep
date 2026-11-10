# Consent ledger and React SDK (Stage 4)

## Ledger (`@stonekeep/core/consent`)

The ledger is an append-only SQLite file, accessed through better-sqlite3 in WAL mode with
`synchronous = FULL`. It records consent decisions:

| Column           | Content                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `seq`            | 1, 2, 3, … with no gaps                                                                                         |
| `subject`        | `HMAC-SHA256(ledgerKey, subjectId)`. **The raw id is never stored**; a test greps the SQLite file for it        |
| `purpose`        | A short identifier such as `analytics`. Free text is rejected, so no personal data can be smuggled in           |
| `action`         | `granted`, `withdrawn` or `erased`                                                                              |
| `recorded_at`    | ISO 8601 UTC                                                                                                    |
| `policy_version` | An optional identifier                                                                                          |
| `source`         | An optional identifier, such as `banner`                                                                        |
| `content_hash`   | `H(canonicalJSON(content))`                                                                                     |
| `prev_hash`      | The `hash` of the previous entry. For entry 1 this is 64 zeros (`GENESIS_HASH`)                                 |
| `hash`           | `H(canonicalJSON({seq, prevHash, bodyHash}))`, where `bodyHash = H(canonicalJSON({seq, subject, contentHash}))` |

`H` is SHA-256. Canonical JSON means sorted keys and no whitespace.

### Why tampering is detected

- **Triggers.** `UPDATE` and `DELETE` are rejected by SQLite triggers. The one allowed update is an
  erasure redaction, described below.
- **The hash chain.** Every entry links to the one before it. Any edit, reordering, gap or
  insertion breaks the chain.
- **The signed head.** `consent_head` stores `(seq, hash)` with an **HMAC signature** made with the
  ledger secret. A plain hash chain can be recomputed by anyone with write access to the file, and
  deleting the newest entries leaves the remaining chain valid. Both attacks change the head, and
  the attacker can't re-sign it without the secret.
- **Redaction consistency.** A redacted row must have empty content columns and a later `erased`
  event for the same subject. `bodyHash` binds the subject to the entry even after its content is
  gone, so a redacted entry can't be moved to another person.

`ledger.verify()` checks all of the above. `packages/core/test/consent.property.test.ts` uses
fast-check to generate random ledgers and a model of an attacker with write access to the file who
doesn't have the secret. The attacker:

- changes any column
- swaps contents
- permutes `seq`
- deletes rows, with or without closing the gap and rehashing the chain
- truncates the tail
- appends forged entries, with or without moving the head
- redacts entries illegally
- edits the head

Every attack must be detected. Set `STONEKEEP_FC_SCALE=25` to run about 16,000 cases.

The property tests found two real gaps during development, and both are fixed:

1. Content could be written back into a redacted row.
2. A redacted row could be moved to another subject. That gap is why `bodyHash` exists.

Not covered: if an attacker restores an entire older copy of the database, including its valid
signed head, it's a rollback that can't be detected from inside the file. To guard against that,
anchor the head externally, for example by publishing `verify-ledger` output or keeping exported
evidence.

### Evidence (`stonekeep evidence export <subject>`)

The export is a self-contained JSON segment. It runs from the subject's first entry **up to the
current head**, so a later withdrawal can't be quietly omitted.

- The subject's own entries include their content.
- Every other entry in the range appears as `{seq, prevHash, bodyHash, hash, redacted: true}`. That
  reveals neither the other person's pseudonym nor their content, but the chain still verifies.

`verifyEvidence()` and `stonekeep evidence verify <file>` check the format, the chain links,
disclosed contents, subject ownership, that the segment ends at the head, and the derived status
summary. Checking the head's MAC requires the ledger secret, so `stonekeep evidence verify-ledger`
does that on the full ledger.

### Erasure hook

When `consent:` is set in `stonekeep.connector.yaml`, `stonekeep delete --apply` adds a
`consent-ledger` step. It runs **after** the database erasure has succeeded:

```yaml
consent:
  ledger: stonekeep-consent.db # relative to the config file
  secretEnv: STONEKEEP_LEDGER_SECRET # >= 32 characters
```

The step:

1. Appends an `erased` event for the subject.
2. Redacts the purpose, action, timestamp, policy version and source of the subject's earlier
   entries. Their hashes and the subject HMAC stay, so the chain still verifies and the log keeps
   **only the hashed id and the erasure event** as proof.

The step is idempotent. In a dry run it only counts what it would redact. If the database erasure
failed, the step is reported as `skipped`.

## React SDK (`@stonekeep/react`)

```tsx
import { ConsentBanner, ConsentProvider, useConsent } from '@stonekeep/react';

const purposes = [
  { id: 'necessary', label: 'Necessary', required: true },
  { id: 'analytics', label: 'Analytics', description: 'Anonymous usage statistics' },
  { id: 'marketing', label: 'Marketing' },
];

<ConsentProvider endpoint="/api/consent" purposes={purposes} policyVersion="2026-05">
  <App />
  <ConsentBanner privacyPolicyUrl="/privacy" />
</ConsentProvider>;

function AnalyticsLoader() {
  const { isGranted } = useConsent();
  return isGranted('analytics') ? <Analytics /> : null;
}
```

### What `useConsent()` returns

| Field                         | Meaning                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `status`                      | `'loading'`, `'ready'` or `'error'`                                          |
| `consents`                    | `{ [purpose]: true / false / undefined }`. `undefined` means not decided yet |
| `isGranted(p)`                | Whether purpose `p` is granted                                               |
| `needsDecision`               | Whether the banner should show                                               |
| `pending`                     | Whether a save is in flight                                                  |
| `error`                       | The last error, if any                                                       |
| `grant(p)` / `withdraw(p)`    | Record a decision for one purpose or a list of purposes                      |
| `acceptAll()` / `rejectAll()` | Record a decision for every optional purpose                                 |
| `save(choices)`               | Apply several decisions at once                                              |
| `refresh()`                   | Reload the current state from the backend                                    |

### Behaviour

- **Optimistic updates.** Changes show immediately. If any request fails, they roll back and
  `error` is set.
- **Changed purposes only.** Only purposes whose value actually changed are sent. Required purposes
  are always on and never recorded.
- **Policy versions.** If the stored decisions were made under a different `policyVersion`, the
  visitor is asked again.

### `<ConsentBanner>`

- It's a labelled `role="dialog"`, rendered only while a decision is missing.
- **Accept all** and **Reject all** are equally prominent, so there are no dark patterns.
- **Customize** shows per-purpose checkboxes. Required purposes are locked on.
- A failed save shows an alert and leaves the banner open.
- Text can be changed through props. Style it with `className`, the CSS variables
  `--stonekeep-banner-*`, or `unstyled`.

### Backend protocol

| Request           | Body / response                                                               |
| ----------------- | ----------------------------------------------------------------------------- |
| `GET {endpoint}`  | Response: `{ purposes: { [id]: { granted, since } }, policyVersion? }`        |
| `POST {endpoint}` | Body: `{ purpose, action: 'granted' \| 'withdrawn', policyVersion?, source }` |

**The SDK never sends a subject id**, in the URL or anywhere else. The backend identifies the caller
from its own session cookie or `Authorization` header and records the decision in the ledger
(`ledger.record({ subject: session.userId, … })`). For logged-out visitors, `anonymousId` sends a
random UUID in the `x-stonekeep-consent-id` header. The UUID is kept in `localStorage`.

The Stage 5 server implements this protocol. See `packages/docs/server.md`.
