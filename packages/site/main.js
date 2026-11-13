// Stonekeep promo site. The page is complete without this file: it only adds the mobile menu,
// the copy buttons, the current-section mark in the navigation and the demo form submission.
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const cfg = window.STONEKEEP_SITE || {};

  document.documentElement.classList.add('js');

  /* ---------- cookie-free analytics (Plausible or Umami, see config.js) ---------- */
  // Never pass form contents here: only event names and coarse, non-personal properties.
  function track(name, props) {
    try {
      if (typeof window.plausible === 'function')
        window.plausible(name, props ? { props } : undefined);
      else if (window.umami && typeof window.umami.track === 'function')
        window.umami.track(name, props);
    } catch {
      /* analytics must never break the page */
    }
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-cta]');
    if (a) track('CTA', { where: a.dataset.cta });
  });

  /* ---------- navigation ---------- */
  const nav = $('#nav');
  const toggle = $('#navToggle');
  const links = $('#navLinks');
  const setMenu = (open) => {
    links.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => setMenu(!links.classList.contains('open')));
  links.addEventListener('click', (e) => e.target.closest('a') && setMenu(false));
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && links.classList.contains('open')) {
      setMenu(false);
      toggle.focus();
    }
  });
  const onScroll = () => nav.classList.toggle('scrolled', scrollY > 8);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // mark the section being read
  const sectionLinks = $$('a[href^="#"]', links).filter((a) => !a.classList.contains('btn'));
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          sectionLinks.forEach((a) => {
            const on = a.getAttribute('href') === `#${e.target.id}`;
            a.classList.toggle('on', on);
            if (on) a.setAttribute('aria-current', 'true');
            else a.removeAttribute('aria-current');
          });
        }),
      { rootMargin: '-45% 0px -50% 0px' },
    );
    sectionLinks.forEach((a) => {
      const sec = $(a.getAttribute('href'));
      if (sec) io.observe(sec);
    });
  }

  /* ---------- copy buttons ---------- */
  $$('[data-copy]').forEach((btn) => {
    const src = (btn.closest('.cmd, .gha-code') ?? btn.parentElement).querySelector(
      '[data-copy-src]',
    );
    if (!src) return;
    btn.addEventListener('click', async () => {
      const text = (src.textContent ?? '').trim();
      track('Copy command', { command: text.replace('npx @stonekeep/cli ', '').slice(0, 40) });
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Skopiowano';
      } catch {
        const range = document.createRange();
        range.selectNodeContents(src);
        const sel = getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        btn.textContent = 'Zaznaczono';
      }
      setTimeout(() => (btn.textContent = 'Kopiuj'), 1800);
    });
  });

  /* ---------- demo form ---------- */
  const form = $('#demoForm');
  const msg = $('#formMsg');
  const submit = $('#demoSubmit');
  const done = $('#formDone');
  const name = $('#f-name');
  const email = $('#f-email');
  const consent = $('#f-consent');

  const fail = (text, field) => {
    msg.textContent = text;
    if (field) {
      field.setAttribute('aria-invalid', 'true');
      field.focus();
    }
    return false;
  };
  [name, email].forEach((f) =>
    f.addEventListener('input', () => f.removeAttribute('aria-invalid')),
  );

  function validate() {
    msg.textContent = '';
    if (!name.value.trim()) return fail('Podaj imię i nazwisko.', name);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim()))
      return fail('Podaj poprawny adres e-mail.', email);
    if (!consent.checked)
      return fail('Zaznacz zgodę na kontakt, abyśmy mogli się odezwać.', consent);
    return true;
  }
  function showDone(title, text) {
    $('#formDoneTitle').textContent = title;
    $('#formDoneText').textContent = text;
    form.hidden = true;
    done.hidden = false;
    done.focus();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validate()) return;
    const scope = $$('#scopeChips input:checked').map((b) => b.value);
    const extra = $('#f-msg').value.trim();
    const payload = {
      name: name.value.trim(),
      email: email.value.trim(),
      company: $('#f-company').value.trim(),
      size: $('input[name="size"]:checked', form)?.value ?? '',
      message: [scope.length ? `Zakres: ${scope.join(', ')}` : '', extra]
        .filter(Boolean)
        .join('\n'),
      source: location.href,
    };
    const thanks = 'Odezwiemy się w ciągu dwóch dni roboczych.';
    // honeypot: people never see this field, simple bots fill it in
    if ($('#f-hp')?.value) return showDone('Dziękujemy.', thanks);
    submit.disabled = true;
    submit.textContent = 'Wysyłanie…';
    try {
      if (cfg.demoEndpoint) {
        const res = await fetch(cfg.demoEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(String(res.status));
        track('Demo request', { size: payload.size });
        showDone('Dziękujemy. Zgłoszenie dotarło.', thanks);
      } else if (cfg.contactEmail) {
        // no form backend: hand the answers to the visitor's mail app, nothing is lost
        const body = [
          `Imię i nazwisko: ${payload.name}`,
          `E-mail: ${payload.email}`,
          payload.company && `Firma: ${payload.company}`,
          `Zespół: ${payload.size}`,
          payload.message,
        ]
          .filter(Boolean)
          .join('\n');
        track('Demo request', { size: payload.size, via: 'email' });
        location.href = `mailto:${cfg.contactEmail}?subject=${encodeURIComponent('Demo Stonekeep')}&body=${encodeURIComponent(body)}`;
        showDone(
          'Otworzyliśmy Twój program pocztowy.',
          'Wyślij przygotowaną wiadomość, a odezwiemy się w ciągu dwóch dni roboczych.',
        );
      } else {
        // nothing configured: do not pretend the request went anywhere
        fail('Formularz nie jest jeszcze podłączony, więc nic nie zostało wysłane.');
      }
    } catch {
      track('Demo request failed');
      fail(
        cfg.contactEmail
          ? `Nie udało się wysłać. Spróbuj ponownie albo napisz na ${cfg.contactEmail}.`
          : 'Nie udało się wysłać. Spróbuj ponownie za chwilę.',
      );
    } finally {
      submit.disabled = false;
      submit.textContent = 'Zamów demo';
    }
  });
})();
