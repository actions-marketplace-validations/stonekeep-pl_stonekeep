// Shared by serve.mjs (preview) and build.mjs (publish): reads config.js and fills the HTML templates.
//
// Template syntax, kept deliberately tiny:
//   {{a.b}}                         the config value, HTML-escaped ('' when missing)
//   <!--if:a.b--> ... <!--/if:a.b-->  kept only when the config value is non-empty
//   <!--jsonld-->                   replaced with the page's JSON-LD (Organization, software, FAQ)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

export function loadConfig(root) {
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(join(root, 'config.js'), 'utf8'), sandbox, {
    filename: 'config.js',
  });
  return sandbox.window.STONEKEEP_SITE ?? {};
}

const get = (cfg, path) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), cfg);
const present = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const text = (html) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();

function jsonLd(html, cfg) {
  const url = cfg.siteUrl ? `${cfg.siteUrl}/` : undefined;
  const org = {
    '@type': 'Organization',
    '@id': url ? `${url}#org` : undefined,
    name: cfg.company?.name || 'Stonekeep',
    brand: 'Stonekeep',
    url,
    logo: url ? `${url}icon-512.png` : undefined,
    email: cfg.contactEmail || undefined,
    taxID: cfg.company?.nip || undefined,
    sameAs: [cfg.links?.github, cfg.founder?.linkedin].filter(present),
  };
  const app = {
    '@type': 'SoftwareApplication',
    name: 'Stonekeep',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Windows, macOS, Linux (Node.js 20+)',
    inLanguage: 'pl',
    description:
      'Narzędzie RODO dla małych zespołów i programistów: skanuje kod w poszukiwaniu danych osobowych, obsługuje wnioski osób, pomaga zgłosić wyciek do UODO w 72 godziny i przygotowuje dokumenty po polsku.',
    license: 'https://www.apache.org/licenses/LICENSE-2.0',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'PLN' },
    url,
    publisher: url ? { '@id': `${url}#org` } : undefined,
  };
  const faq = [
    ...html.matchAll(
      /<details class="faq-item"[^>]*>\s*<summary>([\s\S]*?)<\/summary>\s*<div class="faq-a">([\s\S]*?)<\/div>\s*<\/details>/g,
    ),
  ].map(([, q, a]) => ({
    '@type': 'Question',
    name: text(q),
    acceptedAnswer: { '@type': 'Answer', text: text(a) },
  }));
  const graph = [org, app];
  if (faq.length) graph.push({ '@type': 'FAQPage', mainEntity: faq });
  const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, (_, v) =>
    Array.isArray(v) && v.length === 0 ? undefined : v,
  );
  return `<script type="application/ld+json">${json.replace(/</g, '\\u003c')}</script>`;
}

export function render(html, cfg) {
  // innermost first, so nested blocks with different keys work
  let prev;
  do {
    prev = html;
    html = html.replace(/<!--if:([\w.]+)-->([\s\S]*?)<!--\/if:\1-->/g, (_, key, body) =>
      present(get(cfg, key)) ? body : '',
    );
  } while (html !== prev);
  if (html.includes('<!--jsonld-->')) html = html.replace('<!--jsonld-->', jsonLd(html, cfg));
  return html.replace(/\{\{([\w.]+)\}\}/g, (_, key) => {
    const v = get(cfg, key);
    return present(v) ? esc(v) : '';
  });
}

const isHttps = (v) => /^https:\/\/[^\s"'<>]+$/.test(v);

// Errors block a real build; warnings are printed. `draft` turns errors into warnings.
export function validate(cfg) {
  const errors = [];
  const warnings = [];
  if (!present(cfg.siteUrl))
    errors.push('siteUrl is empty (canonical, Open Graph, sitemap need it)');
  else if (!isHttps(cfg.siteUrl) || cfg.siteUrl.endsWith('/'))
    errors.push('siteUrl must look like https://example.pl (https, no trailing slash)');
  if (!present(cfg.contactEmail))
    errors.push('contactEmail is empty (footer, privacy policy, form fallback)');
  if (!present(cfg.company?.name))
    errors.push('company.name is empty (data controller in the privacy policy)');
  if (!present(cfg.company?.address))
    errors.push('company.address is empty (data controller in the privacy policy)');
  if (!present(cfg.demoEndpoint))
    warnings.push('demoEndpoint is empty: demo requests fall back to an e-mail link');
  else if (!isHttps(cfg.demoEndpoint)) errors.push('demoEndpoint must be an https URL');
  if (!present(cfg.analytics?.src))
    warnings.push('analytics.src is empty: no visits or conversions are measured');
  if (!present(cfg.links?.github))
    warnings.push('links.github is empty: the free-start section has no repository link');
  if (!present(cfg.founder?.name))
    warnings.push('founder.name is empty: the "Kto za tym stoi" section is hidden');
  if (present(cfg.demoEndpoint) && !present(cfg.privacy?.forms))
    warnings.push('privacy.forms is empty: name the form backend in the privacy policy');
  if (!present(cfg.privacy?.hosting))
    warnings.push('privacy.hosting is empty: name the hosting provider in the privacy policy');
  for (const key of [
    'links.github',
    'links.npm',
    'links.docs',
    'founder.linkedin',
    'founder.github',
    'analytics.src',
  ]) {
    const v = get(cfg, key);
    if (present(v) && !isHttps(v)) errors.push(`${key} must be an https URL`);
  }
  return { errors, warnings };
}
