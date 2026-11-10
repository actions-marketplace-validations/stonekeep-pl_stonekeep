# @stonekeep/core

The library behind the Stonekeep CLI: schema scanner, rule-based PII classifier, data map and check,
the Postgres data engine (export, delete, anonymise, mask) and a tamper-evident consent ledger.

```js
import { scan, check } from '@stonekeep/core';
import { loadEngineContext, buildExportZip, runMask } from '@stonekeep/core/engine';
```

Rules are JSON (`rules/default-rules.json`) and recognise English and Polish field names such as
`pesel`, `nip`, `imie` and `nazwisko`. Most people want [`@stonekeep/cli`](https://www.npmjs.com/package/@stonekeep/cli) instead.

> Stonekeep helps you track and manage personal data. Its classification is heuristic and needs human
> review. It does **not** guarantee compliance with GDPR/RODO or any other law, and it is not legal advice.

Part of [Stonekeep](https://www.npmjs.com/package/@stonekeep/cli), RODO tooling for small teams in Poland. Licence: Apache-2.0.
