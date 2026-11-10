import { writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { StonekeepError } from '@stonekeep/core';
import type { Io } from './index.js';

export interface AiFlags {
  connector?: string | undefined;
  datamap?: string | undefined;
  model?: string | undefined;
  out?: string | undefined;
  offline: boolean;
}

/** `stonekeep setup` and `stonekeep skill`. */
export async function runAiCommand(
  command: 'setup' | 'skill',
  flags: AiFlags,
  io: Io,
): Promise<number> {
  const ai = await import('@stonekeep/ai');
  if (command === 'skill') {
    const file = resolve(io.cwd, flags.out ?? 'SKILL.md');
    writeFileSync(file, ai.renderSkillMd(), 'utf8');
    io.stdout(`Wrote ${relative(io.cwd, file) || file}\n`);
    return 0;
  }
  const connectorPath = resolve(io.cwd, flags.connector ?? 'stonekeep.connector.yaml');
  const datamapPath = resolve(io.cwd, flags.datamap ?? 'stonekeep-datamap.json');
  const provider = flags.offline
    ? ai.heuristicProvider
    : ai.createAnthropicProvider({ ...(flags.model ? { model: flags.model } : {}) });
  try {
    const result = await ai.runSetup({
      root: io.cwd,
      datamapPath,
      connectorPath,
      provider,
      io: {
        stdout: io.stdout,
        stderr: io.stderr,
        color: io.color === true,
        ...(io.ask ? { ask: io.ask } : {}),
      },
    });
    return result.saved || !result.changed ? 0 : 1;
  } catch (error) {
    if (error instanceof ai.PrivacyGuardError) {
      io.stderr(
        `error: ${error.message}\nNothing was sent. Rename or exclude the offending identifiers and retry.\n`,
      );
      return 2;
    }
    // SDK errors (auth, network) carry no payload data; surface them without bodies.
    if (
      error instanceof Error &&
      error.name.endsWith('Error') &&
      !(error instanceof StonekeepError)
    ) {
      io.stderr(
        `error: the AI provider request failed (${error.name}). Check ANTHROPIC_API_KEY or run \`ant auth login\`, or use --offline.\n`,
      );
      return 2;
    }
    throw error;
  }
}
