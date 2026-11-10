export type StonekeepErrorCode = 'CONFIG' | 'RULES' | 'DATAMAP' | 'IO' | 'DATABASE' | 'SAFETY';

/** An expected, user-facing error (bad config, missing datamap, ...). */
export class StonekeepError extends Error {
  readonly code: StonekeepErrorCode;

  constructor(code: StonekeepErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StonekeepError';
    this.code = code;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
