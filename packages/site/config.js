// Site settings. Edit before publishing, then run `node packages/site/build.mjs`.
// The build refuses to run while a required field (marked REQUIRED) is empty.
// This file is also loaded by the page, so put nothing secret here.
window.STONEKEEP_SITE = {
  // REQUIRED. Public address of the site, no trailing slash, e.g. 'https://stonekeep.pl'.
  // Used for canonical, Open Graph, sitemap.xml and robots.txt.
  siteUrl: 'https://stonekeep.pl',

  // Where the demo form is POSTed as JSON ({ name, email, company, size, message, source }).
  // Works with any form backend (Formspree, Basin, your own server, an AWS endpoint).
  // While empty, the form tells the visitor to write to contactEmail instead.
  // Lambda + SES stack "stonekeep-demo-form" in eu-north-1 (packages/site/form), e-mails kontakt@stonekeep.pl.
  demoEndpoint: 'https://kny5qbafq6lgymyb3xakxfi3cm0apzkx.lambda-url.eu-north-1.on.aws/',

  // REQUIRED. Public contact address (footer, privacy policy, form fallback). Mailbox hosted at OVH.
  contactEmail: 'kontakt@stonekeep.pl',

  // REQUIRED (name, address). The data controller shown in the privacy policy and consent text.
  // For a JDG: 'Imię Nazwisko Stonekeep' style business name from CEIDG.
  company: {
    name: 'Sarmat Dzarakhokhov Stonekeep',
    address: 'ul. Akademicka 5, 02-038 Warszawa', // e.g. 'ul. Przykładowa 1, 00-001 Warszawa'
    nip: '', // optional; never put a PESEL here, it is not needed on the site
    regon: '',
    krs: '', // only for a company registered in KRS
  },

  // Who the visitor talks to. The "Kto za tym stoi" section is hidden while name is empty.
  founder: {
    name: 'Sarmat Dzarakhokhov',
    role: 'Założyciel', // e.g. 'Założyciel, programista'
    bio: 'Student cyberbezpieczeństwa na Politechnice Warszawskiej. Buduję Stonekeep, żeby małe zespoły mogły ogarnąć RODO bez działu prawnego.', // one or two sentences, Polish
    photo: '', // path inside packages/site, e.g. 'img/founder.jpg' (square, at least 400 px)
    linkedin: 'https://www.linkedin.com/in/sarmatsec',
    github: '',
  },

  // Links shown in the navigation, the free-start section and the footer. Empty ones are hidden.
  links: {
    github: 'https://github.com/stonekeep-pl/stonekeep',
    npm: 'https://www.npmjs.com/package/@stonekeep/cli',
    docs: 'https://github.com/stonekeep-pl/stonekeep/tree/main/packages/docs',
  },

  // Cookie-free analytics (no consent banner needed). Leave src empty to load nothing.
  // Plausible: src 'https://plausible.io/js/script.js', domain 'stonekeep.pl'.
  // Umami: src 'https://<your-umami>/script.js', websiteId '<uuid>'.
  analytics: {
    src: '',
    domain: '',
    websiteId: '',
  },

  // Processors named in the privacy policy. Fill in what you actually use.
  privacy: {
    hosting: 'Amazon Web Services EMEA SARL (hosting strony, Amazon CloudFront)', // e.g. 'Cloudflare, Inc. (hosting strony)'
    forms: 'Amazon Web Services EMEA SARL (obsługa formularza i wysyłka wiadomości, Amazon SES, region Sztokholm)', // e.g. 'Formspree, Inc. (obsługa formularza)'
    email: 'OVH SAS (poczta e-mail)', // e.g. 'Google Ireland Ltd. (poczta e-mail)'
    retentionMonths: 12, // how long demo requests are kept at most after the last message
    updated: '2026-11-10', // date shown on the policy; change it whenever the policy changes
  },
};
