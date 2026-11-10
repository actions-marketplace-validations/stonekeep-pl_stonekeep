import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { StonekeepError, errorMessage } from '@stonekeep/core';
import type { ConsentLedger, EvidenceSegment } from '@stonekeep/core/consent';
import type { Io } from './index.js';

export interface EvidenceFlags {
  connector?: string | undefined;
  subject?: string | undefined;
  subjectEnv?: string | undefined;
  out?: string | undefined;
  json: boolean;
}

/** Open the consent ledger configured in the connector YAML. */
export async function openConfiguredLedger(
  connectorPath: string,
  env: Io['env'],
): Promise<ConsentLedger> {
  const { loadConnectorConfig, requireEnv } = await import('@stonekeep/core/engine');
  const { ConsentLedger } = await import('@stonekeep/core/consent');
  const loaded = loadConnectorConfig(connectorPath);
  const consent = loaded.config.consent;
  if (!consent || loaded.ledgerPath === undefined) {
    throw new StonekeepError(
      'CONFIG',
      'No consent ledger configured: add a "consent:" section to the connector config',
    );
  }
  return ConsentLedger.open(loaded.ledgerPath, {
    secret: requireEnv(env, consent.secretEnv, 'consent ledger secret'),
  });
}

/** `stonekeep evidence export|verify|verify-ledger`. Exit 1 when verification fails. */
export async function runEvidenceCommand(
  args: readonly string[],
  flags: EvidenceFlags,
  io: Io,
): Promise<number> {
  const [sub, arg, ...extra] = args;
  if (extra.length > 0)
    throw new StonekeepError('CONFIG', `unexpected arguments: ${extra.join(' ')}`);
  const connectorPath = resolve(io.cwd, flags.connector ?? 'stonekeep.connector.yaml');

  switch (sub) {
    case 'export': {
      const fromEnv = flags.subjectEnv !== undefined ? io.env[flags.subjectEnv] : undefined;
      const subject = arg ?? flags.subject ?? fromEnv;
      if (subject === undefined || subject.length === 0) {
        throw new StonekeepError(
          'CONFIG',
          'usage: stonekeep evidence export <subject> (or --subject-env VAR)',
        );
      }
      const ledger = await openConfiguredLedger(connectorPath, io.env);
      let segment: EvidenceSegment;
      try {
        segment = ledger.exportEvidence(subject);
      } finally {
        ledger.close();
      }
      const json = `${JSON.stringify(segment, null, 2)}\n`;
      if (flags.out === undefined) {
        io.stdout(json);
      } else {
        const file = resolve(io.cwd, flags.out);
        writeFileSync(file, json, { mode: 0o600 });
        const disclosed = segment.entries.filter((e) => e.content).length;
        io.stdout(
          `Wrote ${relative(io.cwd, file) || file}: ${disclosed} of the subject's entries, ${segment.entries.length - disclosed} hidden, head seq ${segment.head.seq}\n`,
        );
      }
      return 0;
    }
    case 'verify': {
      if (arg === undefined)
        throw new StonekeepError('CONFIG', 'usage: stonekeep evidence verify <file.json>');
      const { verifyEvidence } = await import('@stonekeep/core/consent');
      let segment: EvidenceSegment;
      try {
        segment = JSON.parse(readFileSync(resolve(io.cwd, arg), 'utf8')) as EvidenceSegment;
      } catch (error) {
        throw new StonekeepError('IO', `Cannot read evidence file: ${errorMessage(error)}`);
      }
      const r = verifyEvidence(segment);
      if (flags.json) io.stdout(`${JSON.stringify(r, null, 2)}\n`);
      else if (r.valid)
        io.stdout(
          `VALID  evidence chain seq ${segment.anchor.seq + 1}..${segment.head.seq} verifies\n`,
        );
      else
        io.stdout(
          `INVALID  evidence does not verify:\n${r.errors.map((e) => `  - ${e}\n`).join('')}`,
        );
      return r.valid ? 0 : 1;
    }
    case 'verify-ledger': {
      const ledger = await openConfiguredLedger(connectorPath, io.env);
      try {
        const r = ledger.verify();
        if (flags.json) io.stdout(`${JSON.stringify(r, null, 2)}\n`);
        else if (r.valid)
          io.stdout(
            `VALID  consent ledger: ${r.entries} entries, signed head at seq ${r.headSeq}\n`,
          );
        else
          io.stdout(
            `TAMPERED  consent ledger failed verification:\n${r.errors.map((e) => `  - ${e}\n`).join('')}`,
          );
        return r.valid ? 0 : 1;
      } finally {
        ledger.close();
      }
    }
    default:
      throw new StonekeepError(
        'CONFIG',
        'usage: stonekeep evidence export <subject> | verify <file> | verify-ledger',
      );
  }
}
