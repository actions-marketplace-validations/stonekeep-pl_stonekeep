// Runs the Lambda code embedded in template.yaml against a fake SES client.
//   node packages/site/form/test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const tpl = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'template.yaml'), 'utf8');
// The AWS CLI on Windows reads the template in the local code page, which garbled Polish letters once.
assert.ok(/^[\x00-\x7f]*$/.test(tpl), 'template.yaml must stay ASCII: write Polish letters as \\u escapes');
const lines = tpl.split(/\r?\n/);
const start = lines.findIndex((l) => l.trim() === 'ZipFile: |') + 1;
const code = [];
for (let i = start; i < lines.length && (lines[i].startsWith('          ') || lines[i].trim() === ''); i++)
  code.push(lines[i].slice(10));

const sent = [];
const fakeSes = {
  SESv2Client: class {
    async send(cmd) {
      sent.push(cmd.input);
    }
  },
  SendEmailCommand: class {
    constructor(input) {
      this.input = input;
    }
  },
};
const mod = { exports: {} };
vm.runInNewContext(code.join('\n'), {
  require: () => fakeSes,
  module: mod,
  exports: mod.exports,
  Buffer,
  console: { log() {} },
  process: { env: { TO_EMAIL: 'owner@example.pl', ALLOWED_ORIGIN: 'https://stonekeep.pl' } },
});
const handler = mod.exports.handler;
const call = (body, { origin = 'https://stonekeep.pl', method = 'POST' } = {}) =>
  handler({ requestContext: { http: { method } }, headers: { origin }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const ok = { name: 'Jan Kowalski', email: 'jan@example.pl', company: 'Sklep', size: '2–5 osób', message: 'Zakres: Wycieki', source: 'https://stonekeep.pl/' };

let r = await call(ok);
assert.equal(r.statusCode, 200);
assert.equal(sent.length, 1);
assert.equal(JSON.stringify(sent[0].Destination.ToAddresses), '["owner@example.pl"]');
assert.equal(JSON.stringify(sent[0].ReplyToAddresses), '["jan@example.pl"]');
assert.equal(sent[0].Content.Simple.Subject.Data, 'Demo Stonekeep: Jan Kowalski (Sklep)');
assert.match(sent[0].Content.Simple.Body.Text.Data, /Zespół: 2–5 osób\n\nZakres: Wycieki/);

assert.equal((await call(ok, { origin: 'https://evil.example' })).statusCode, 403);
assert.equal((await call(ok, { method: 'GET' })).statusCode, 405);
assert.equal((await call('{nope')).statusCode, 400);
assert.equal((await call({ ...ok, email: 'not-an-email' })).statusCode, 400);
assert.equal((await call({ ...ok, name: '   ' })).statusCode, 400);
assert.equal((await call('x'.repeat(9000))).statusCode, 413);
r = await call({ ...ok, website: 'spam.example' });
assert.equal(r.statusCode, 200, 'honeypot looks like success to the bot');
assert.equal(sent.length, 1, 'honeypot sends nothing');
await call({ ...ok, name: 'A\u0000B'.padEnd(500, 'x') });
assert.equal(sent.at(-1).Content.Simple.Body.Text.Data.split('\n')[0].length, 'Imię i nazwisko: '.length + 120);
assert.ok(!sent.at(-1).Content.Simple.Body.Text.Data.includes('\u0000'));
console.log('form lambda: all checks passed');
