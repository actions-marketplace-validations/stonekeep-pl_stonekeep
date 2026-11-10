import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  createConsentClient,
  type ConsentClient,
  type ConsentClientOptions,
  type ConsentState,
} from './client.js';

export interface PurposeDefinition {
  /** Machine id sent to the backend, e.g. `analytics`. */
  id: string;
  label: string;
  description?: string;
  /** Strictly necessary: always on, never asked for, never recorded. */
  required?: boolean;
}

export type ConsentStatus = 'loading' | 'ready' | 'error';

export interface UseConsentResult {
  status: ConsentStatus;
  /** Last request error (loading or saving). Cleared on the next successful save. */
  error: Error | undefined;
  purposes: readonly PurposeDefinition[];
  /** `true` granted, `false` refused/withdrawn, `undefined` not decided yet. */
  consents: Readonly<Record<string, boolean | undefined>>;
  isGranted(purpose: string): boolean;
  /** Some optional purpose has no decision yet (show the banner). */
  needsDecision: boolean;
  /** A save is in flight. */
  pending: boolean;
  grant(purpose: string | readonly string[]): Promise<void>;
  withdraw(purpose: string | readonly string[]): Promise<void>;
  acceptAll(): Promise<void>;
  rejectAll(): Promise<void>;
  /** Apply several decisions at once, e.g. from a preferences form. */
  save(choices: Readonly<Record<string, boolean>>): Promise<void>;
  refresh(): Promise<void>;
}

const ConsentContext = createContext<UseConsentResult | null>(null);

export interface ConsentProviderProps extends ConsentClientOptions {
  purposes: readonly PurposeDefinition[];
  /** Policy version recorded with each decision. A newer version re-asks for consent. */
  policyVersion?: string;
  /** Recorded as `source` with each decision. Default `banner`. */
  source?: string;
  /** Inject a client (tests, custom transports). */
  client?: ConsentClient;
  children?: ReactNode;
}

function toConsents(
  state: ConsentState,
  purposes: readonly PurposeDefinition[],
  policyVersion: string | undefined,
): Record<string, boolean | undefined> {
  const out: Record<string, boolean | undefined> = {};
  const stale =
    policyVersion !== undefined &&
    state.policyVersion !== undefined &&
    state.policyVersion !== policyVersion;
  for (const p of purposes) {
    out[p.id] = p.required ? true : stale ? undefined : state.purposes[p.id]?.granted;
  }
  return out;
}

export function ConsentProvider(props: ConsentProviderProps): ReactNode {
  const {
    purposes,
    policyVersion,
    source = 'banner',
    children,
    client: injected,
    endpoint,
    headers,
    credentials,
    anonymousId,
    storageKey,
    fetch,
  } = props;
  const client = useMemo(
    () =>
      injected ??
      createConsentClient({
        endpoint,
        ...(headers !== undefined ? { headers } : {}),
        ...(credentials !== undefined ? { credentials } : {}),
        ...(anonymousId !== undefined ? { anonymousId } : {}),
        ...(storageKey !== undefined ? { storageKey } : {}),
        ...(fetch !== undefined ? { fetch } : {}),
      }),
    [injected, endpoint, headers, credentials, anonymousId, storageKey, fetch],
  );
  const [status, setStatus] = useState<ConsentStatus>('loading');
  const [error, setError] = useState<Error | undefined>(undefined);
  const [consents, setConsents] = useState<Record<string, boolean | undefined>>(() =>
    toConsents({ purposes: {} }, purposes, undefined),
  );
  const [pending, setPending] = useState(0);
  const latest = useRef(consents);
  latest.current = consents;

  const refresh = useCallback(async () => {
    try {
      const state = await client.load();
      setConsents(toConsents(state, purposes, policyVersion));
      setStatus('ready');
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e : new Error('Failed to load consent'));
      setStatus('error');
    }
  }, [client, purposes, policyVersion]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (choices: Readonly<Record<string, boolean>>) => {
      const known = new Map(purposes.map((p) => [p.id, p]));
      const changes = Object.entries(choices).filter(([id, granted]) => {
        const def = known.get(id);
        return def !== undefined && !def.required && latest.current[id] !== granted;
      });
      if (changes.length === 0) return;
      const previous = latest.current;
      // Optimistic update; rolled back if any request fails.
      setConsents({ ...previous, ...Object.fromEntries(changes) });
      setPending((n) => n + 1);
      try {
        await Promise.all(
          changes.map(([id, granted]) =>
            client.record(id, granted ? 'granted' : 'withdrawn', {
              source,
              ...(policyVersion !== undefined ? { policyVersion } : {}),
            }),
          ),
        );
        setError(undefined);
      } catch (e) {
        setConsents(previous);
        setError(e instanceof Error ? e : new Error('Failed to save consent'));
        throw e;
      } finally {
        setPending((n) => n - 1);
      }
    },
    [client, purposes, policyVersion, source],
  );

  const value = useMemo<UseConsentResult>(() => {
    const list = (p: string | readonly string[]): readonly string[] =>
      typeof p === 'string' ? [p] : p;
    const optional = purposes.filter((p) => !p.required).map((p) => p.id);
    return {
      status,
      error,
      purposes,
      consents,
      isGranted: (purpose) => consents[purpose] === true,
      needsDecision: status === 'ready' && optional.some((id) => consents[id] === undefined),
      pending: pending > 0,
      grant: (p) => save(Object.fromEntries(list(p).map((id) => [id, true]))),
      withdraw: (p) => save(Object.fromEntries(list(p).map((id) => [id, false]))),
      acceptAll: () => save(Object.fromEntries(optional.map((id) => [id, true]))),
      rejectAll: () => save(Object.fromEntries(optional.map((id) => [id, false]))),
      save,
      refresh,
    };
  }, [status, error, purposes, consents, pending, save, refresh]);

  return <ConsentContext.Provider value={value}>{children}</ConsentContext.Provider>;
}

/** Read and change the visitor's consent. Must be used inside `<ConsentProvider>`. */
export function useConsent(): UseConsentResult {
  const ctx = useContext(ConsentContext);
  if (!ctx) throw new Error('useConsent must be used inside <ConsentProvider>');
  return ctx;
}
