# @stonekeep/connectors

SaaS connectors for Stonekeep deletions and exports: Stripe, Auth0, PayU, Przelewy24 and Mailchimp,
with secret references (never secrets in config), retries on HTTP 429 and an orchestrator that runs
the database and every connector in parallel and returns one report.

Used by [`@stonekeep/cli`](https://www.npmjs.com/package/@stonekeep/cli) (`stonekeep delete`) and by
the Stonekeep console (commercial).

> Stonekeep helps you track and manage personal data. Its classification is heuristic and needs human
> review. It does **not** guarantee compliance with GDPR/RODO or any other law, and it is not legal advice.

Part of [Stonekeep](https://www.npmjs.com/package/@stonekeep/cli), RODO tooling for small teams in Poland. Licence: Apache-2.0.
