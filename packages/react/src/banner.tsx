import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import { useConsent } from './context.js';

export interface ConsentBannerProps {
  title?: string;
  description?: ReactNode;
  acceptLabel?: string;
  rejectLabel?: string;
  customizeLabel?: string;
  saveLabel?: string;
  privacyPolicyUrl?: string;
  className?: string;
  /** Drop the built-in inline styles (style it yourself via className / data attributes). */
  unstyled?: boolean;
}

const styles = {
  root: {
    position: 'fixed',
    insetInline: '1rem',
    bottom: '1rem',
    maxWidth: '40rem',
    marginInline: 'auto',
    padding: '1.25rem',
    borderRadius: '0.75rem',
    background: 'var(--stonekeep-banner-bg, #ffffff)',
    color: 'var(--stonekeep-banner-fg, #111827)',
    boxShadow: '0 10px 30px rgba(0,0,0,.15)',
    font: 'inherit',
    zIndex: 2147483000,
  },
  actions: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '1rem' },
  // Accept and reject get equal prominence (no dark patterns).
  button: {
    flex: '1 1 auto',
    padding: '0.6rem 1rem',
    borderRadius: '0.5rem',
    border: '1px solid currentColor',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    font: 'inherit',
  },
  list: { listStyle: 'none', padding: 0, margin: '1rem 0 0', display: 'grid', gap: '0.5rem' },
} satisfies Record<string, CSSProperties>;

/**
 * Accessible consent banner. Renders only while an optional purpose has no
 * decision. "Accept all" and "Reject all" are equally prominent; "Customize"
 * shows per-purpose toggles.
 */
export function ConsentBanner(props: ConsentBannerProps): ReactNode {
  const {
    title = 'Your privacy choices',
    description = 'We use optional cookies and similar technologies only with your consent. You can change your choice at any time.',
    acceptLabel = 'Accept all',
    rejectLabel = 'Reject all',
    customizeLabel = 'Customize',
    saveLabel = 'Save choices',
    privacyPolicyUrl,
    className,
    unstyled = false,
  } = props;
  const consent = useConsent();
  const [customizing, setCustomizing] = useState(false);
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const titleId = useId();
  const descId = useId();

  if (!consent.needsDecision) return null;
  const s = (style: CSSProperties): CSSProperties | undefined => (unstyled ? undefined : style);
  const optional = consent.purposes.filter((p) => !p.required);
  const run = (action: () => Promise<void>) => () => {
    // Errors are surfaced through `consent.error`.
    action().catch(() => undefined);
  };

  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={descId}
      className={className}
      data-stonekeep-banner=""
      style={s(styles.root)}
    >
      <h2 id={titleId} style={s({ margin: 0, fontSize: '1.1rem' })}>
        {title}
      </h2>
      <div id={descId} style={s({ marginTop: '0.5rem' })}>
        {description}
        {privacyPolicyUrl ? (
          <>
            {' '}
            <a href={privacyPolicyUrl}>Privacy policy</a>
          </>
        ) : null}
      </div>

      {customizing ? (
        <ul style={s(styles.list)} aria-label="Consent purposes">
          {consent.purposes.map((p) => {
            const checked = p.required ? true : (draft[p.id] ?? consent.consents[p.id] ?? false);
            return (
              <li key={p.id}>
                <label style={s({ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' })}>
                  <input
                    type="checkbox"
                    name={p.id}
                    checked={checked}
                    disabled={p.required === true}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, [p.id]: e.target.checked }));
                    }}
                  />
                  <span>
                    <strong>{p.label}</strong>
                    {p.required ? ' (always on)' : null}
                    {p.description ? (
                      <span style={s({ display: 'block', opacity: 0.8 })}>{p.description}</span>
                    ) : null}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : null}

      {consent.error ? (
        <p
          role="alert"
          style={s({ color: 'var(--stonekeep-banner-error, #b91c1c)', margin: '0.75rem 0 0' })}
        >
          Your choice could not be saved. Please try again.
        </p>
      ) : null}

      <div style={s(styles.actions)}>
        <button
          type="button"
          style={s(styles.button)}
          disabled={consent.pending}
          onClick={run(() => consent.rejectAll())}
        >
          {rejectLabel}
        </button>
        {customizing ? (
          <button
            type="button"
            style={s(styles.button)}
            disabled={consent.pending}
            onClick={run(() =>
              consent.save(
                Object.fromEntries(
                  optional.map((p) => [p.id, draft[p.id] ?? consent.consents[p.id] ?? false]),
                ),
              ),
            )}
          >
            {saveLabel}
          </button>
        ) : (
          <button
            type="button"
            style={s(styles.button)}
            aria-expanded={false}
            onClick={() => {
              setCustomizing(true);
            }}
          >
            {customizeLabel}
          </button>
        )}
        <button
          type="button"
          style={s(styles.button)}
          disabled={consent.pending}
          onClick={run(() => consent.acceptAll())}
        >
          {acceptLabel}
        </button>
      </div>
    </section>
  );
}
