// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ANONYMOUS_ID_HEADER,
  ConsentBanner,
  ConsentProvider,
  useConsent,
  type PurposeDefinition,
} from '../src/index.js';

const ENDPOINT = 'https://app.example.test/api/consent';
const PURPOSES: PurposeDefinition[] = [
  { id: 'necessary', label: 'Necessary', required: true },
  { id: 'analytics', label: 'Analytics', description: 'Anonymous usage statistics' },
  { id: 'marketing', label: 'Marketing' },
];

/** Generic backend: state per visitor, every POST recorded. */
const backend = {
  state: {} as Record<string, { granted: boolean; since: string }>,
  policyVersion: undefined as string | undefined,
  posts: [] as { body: Record<string, unknown>; headers: Headers; url: string }[],
  gets: [] as { url: string; headers: Headers }[],
  failPosts: false,
  latency: 0,
};

const server = setupServer(
  http.get(ENDPOINT, ({ request }) => {
    backend.gets.push({ url: request.url, headers: request.headers });
    return HttpResponse.json({
      purposes: backend.state,
      ...(backend.policyVersion ? { policyVersion: backend.policyVersion } : {}),
    });
  }),
  http.post(ENDPOINT, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    backend.posts.push({ body, headers: request.headers, url: request.url });
    if (backend.latency) await delay(backend.latency);
    if (backend.failPosts) return HttpResponse.json({ error: 'unavailable' }, { status: 503 });
    backend.state[String(body.purpose)] = {
      granted: body.action === 'granted',
      since: '2026-05-01T00:00:00Z',
    };
    return HttpResponse.json({ purposes: backend.state });
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  localStorage.clear();
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  backend.state = {};
  backend.policyVersion = undefined;
  backend.posts = [];
  backend.gets = [];
  backend.failPosts = false;
  backend.latency = 0;
});

const wrapper =
  (extra: Partial<React.ComponentProps<typeof ConsentProvider>> = {}) =>
  ({ children }: { children: ReactNode }) => (
    <ConsentProvider endpoint={ENDPOINT} purposes={PURPOSES} policyVersion="2026-05" {...extra}>
      {children}
    </ConsentProvider>
  );

describe('useConsent', () => {
  it('loads the current decisions from the endpoint', async () => {
    backend.state = { analytics: { granted: true, since: '2026-01-01T00:00:00Z' } };
    const { result } = renderHook(() => useConsent(), { wrapper: wrapper() });
    expect(result.current.status).toBe('loading');
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.consents).toEqual({
      necessary: true,
      analytics: true,
      marketing: undefined,
    });
    expect(result.current.isGranted('analytics')).toBe(true);
    expect(result.current.isGranted('marketing')).toBe(false);
    expect(result.current.needsDecision).toBe(true);
  });

  it('grant() records the decision with policy version and source, optimistically', async () => {
    backend.latency = 80;
    const { result } = renderHook(() => useConsent(), { wrapper: wrapper() });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    let done: Promise<void> | undefined;
    act(() => {
      done = result.current.grant('marketing');
    });
    // Visible before the server answered.
    expect(result.current.isGranted('marketing')).toBe(true);
    expect(result.current.pending).toBe(true);
    await act(async () => {
      await done;
    });
    expect(result.current.pending).toBe(false);
    expect(backend.posts.map((p) => p.body)).toEqual([
      { purpose: 'marketing', action: 'granted', source: 'banner', policyVersion: '2026-05' },
    ]);
  });

  it('rolls back and exposes the error when saving fails', async () => {
    backend.failPosts = true;
    const { result } = renderHook(() => useConsent(), { wrapper: wrapper() });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    await act(async () => {
      await expect(result.current.grant('analytics')).rejects.toThrow(/HTTP 503/);
    });
    expect(result.current.consents.analytics).toBeUndefined();
    expect(result.current.error?.message).toMatch(/HTTP 503/);
  });

  it('withdraw(), acceptAll() and rejectAll() only send changed, optional purposes', async () => {
    backend.state = { analytics: { granted: true, since: 'x' } };
    const { result } = renderHook(() => useConsent(), { wrapper: wrapper() });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    await act(() => result.current.acceptAll());
    expect(backend.posts.map((p) => p.body.purpose)).toEqual(['marketing']); // analytics unchanged, necessary never sent
    await act(() => result.current.rejectAll());
    expect(backend.posts.slice(1).map((p) => [p.body.purpose, p.body.action])).toEqual([
      ['analytics', 'withdrawn'],
      ['marketing', 'withdrawn'],
    ]);
    await act(() => result.current.withdraw('analytics'));
    expect(backend.posts).toHaveLength(3); // already withdrawn: no request
  });

  it('asks again when the stored decisions belong to an older policy version', async () => {
    backend.state = {
      analytics: { granted: true, since: 'x' },
      marketing: { granted: false, since: 'x' },
    };
    backend.policyVersion = '2025-01';
    const { result } = renderHook(() => useConsent(), { wrapper: wrapper() });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.needsDecision).toBe(true);
    expect(result.current.consents.analytics).toBeUndefined();
  });

  it('never puts a subject in the URL; anonymous visitors get a random id header', async () => {
    const { result } = renderHook(() => useConsent(), { wrapper: wrapper({ anonymousId: true }) });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    await act(() => result.current.grant('analytics'));
    const ids = [...backend.gets, ...backend.posts].map((r) => r.headers.get(ANONYMOUS_ID_HEADER));
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(ids).size).toBe(1); // stable across requests
    expect([...backend.gets, ...backend.posts].every((r) => r.url === ENDPOINT)).toBe(true);
    expect(backend.posts[0]?.body).not.toHaveProperty('subject');
  });

  it('reports load failures', async () => {
    server.use(http.get(ENDPOINT, () => HttpResponse.json({}, { status: 500 })));
    const { result } = renderHook(() => useConsent(), { wrapper: wrapper() });
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.needsDecision).toBe(false);
  });

  it('throws outside a provider', () => {
    expect(() => renderHook(() => useConsent())).toThrow(/inside <ConsentProvider>/);
  });
});

describe('<ConsentBanner>', () => {
  const renderBanner = () =>
    render(
      <ConsentProvider endpoint={ENDPOINT} purposes={PURPOSES} policyVersion="2026-05">
        <ConsentBanner privacyPolicyUrl="/privacy" />
      </ConsentProvider>,
    );

  it('shows an accessible dialog with equally prominent accept and reject buttons', async () => {
    renderBanner();
    const dialog = await screen.findByRole('dialog', { name: 'Your privacy choices' });
    expect(within(dialog).getByRole('button', { name: 'Accept all' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Reject all' })).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'Privacy policy' }).getAttribute('href')).toBe(
      '/privacy',
    );
  });

  it('Accept all records every optional purpose and hides the banner', async () => {
    const user = userEvent.setup();
    renderBanner();
    await user.click(await screen.findByRole('button', { name: 'Accept all' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(backend.posts.map((p) => [p.body.purpose, p.body.action])).toEqual([
      ['analytics', 'granted'],
      ['marketing', 'granted'],
    ]);
  });

  it('Customize lets the visitor choose per purpose; necessary stays locked on', async () => {
    const user = userEvent.setup();
    renderBanner();
    await user.click(await screen.findByRole('button', { name: 'Customize' }));
    const necessary = screen.getByRole('checkbox', { name: /Necessary/ });
    expect((necessary as HTMLInputElement).checked).toBe(true);
    expect((necessary as HTMLInputElement).disabled).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: /Analytics/ }));
    await user.click(screen.getByRole('button', { name: 'Save choices' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(backend.state).toEqual({
      analytics: expect.objectContaining({ granted: true }) as unknown,
      marketing: expect.objectContaining({ granted: false }) as unknown,
    });
  });

  it('stays open with an error message when saving fails', async () => {
    backend.failPosts = true;
    const user = userEvent.setup();
    renderBanner();
    await user.click(await screen.findByRole('button', { name: 'Reject all' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be saved/);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('does not render once every optional purpose is decided', async () => {
    backend.state = {
      analytics: { granted: false, since: 'x' },
      marketing: { granted: true, since: 'x' },
    };
    renderBanner();
    await waitFor(() => {
      expect(backend.gets).toHaveLength(1);
    });
    await act(async () => {
      await delay(10);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
