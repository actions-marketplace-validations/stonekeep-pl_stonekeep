# Stonekeep promo site

Static site (HTML, CSS, JS) in Polish. No dependencies; Node 20+ only.

| Command                                     | What it does                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `node packages/site/serve.mjs`              | Preview on port 4173 (or `PORT=...`), templates filled from `config.js` on every request   |
| `node packages/site/build.mjs`              | Publishable build in `packages/site/dist` (stops while a required field is empty)          |
| `node packages/site/build.mjs --draft`      | Preview build: allows empty fields, blocks indexing (`noindex`, `Disallow: /`)             |
| `node packages/site/deploy.mjs [--dry-run]` | Build, upload `dist/` to S3 and invalidate CloudFront for stonekeep.pl (needs the AWS CLI) |
| `node packages/site/brand/make-images.mjs`  | Re-renders `og.png` and the PNG icons (needs Edge or Chrome, and Pillow)                   |

## Before publishing

Fill in [`config.js`](config.js):

- **Required:** `siteUrl`, `contactEmail`, `company.name`, `company.address`. They feed canonical, Open
  Graph, the sitemap, the footer, the consent text and the privacy policy.
- `demoEndpoint`: URL that receives the demo form as JSON (Formspree, Basin or your own server). While
  it is empty, a submitted form tells the visitor nothing was sent and offers an e-mail link instead.
- `analytics`: cookie-free Plausible or Umami. Events: `CTA` (with `where`), `Copy command`,
  `Form step`, `Demo request`, `Demo request failed`. Form contents never go to analytics.
- `links`, `founder`, `privacy`: optional; empty ones hide their links or sections.

Have a lawyer or DPO check [`polityka-prywatnosci.html`](polityka-prywatnosci.html) before going live.

Then upload `dist/` to any static host (Cloudflare Pages, Netlify, GitHub Pages, nginx) with
compression on (brotli or gzip), and submit `sitemap.xml` in Google Search Console and Bing Webmaster Tools.

## Demo form backend

[`form/template.yaml`](form/template.yaml) is a CloudFormation stack: a Lambda function URL that accepts
the form only from `https://stonekeep.pl`, checks and trims the fields, and e-mails them through Amazon SES
to one verified address (Reply-To is the visitor). Nothing is stored, the body is never logged, logs are kept
14 days. Test the code with `node packages/site/form/test.mjs`. Deploy or update:

```bash
aws cloudformation deploy --region eu-north-1 --stack-name stonekeep-demo-form --template-file packages/site/form/template.yaml --capabilities CAPABILITY_IAM --parameter-overrides ToEmail=kontakt@stonekeep.pl
```

SES e-mails a verification link to `ToEmail` on the first deploy; the form only works after it is clicked.
The account is in the SES sandbox (200 messages a day), which is enough because it only mails itself.

## Templates

Pages use a tiny syntax, implemented in [`render.mjs`](render.mjs): `{{a.b}}` inserts an escaped config
value, `<!--if:a.b-->…<!--/if:a.b-->` keeps a block only when the value is set, `<!--jsonld-->` becomes
the JSON-LD (Organization, SoftwareApplication, FAQPage built from the FAQ section).

Fonts are self-hosted in `fonts/` (SIL OFL 1.1, licences included), so no visitor IP goes to Google.
Marketing audit and promotion plan: [PROMOTION-PLAN.md](PROMOTION-PLAN.md).
