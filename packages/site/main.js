(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const small = matchMedia('(max-width: 860px)').matches;
  const TAU = Math.PI * 2;

  document.documentElement.classList.add('js');

  /* ---------- cookie-free analytics (Plausible or Umami, see config.js) ---------- */
  // Never pass form contents here: only event names and coarse, non-personal properties.
  function track(name, props) {
    try {
      if (typeof window.plausible === 'function') window.plausible(name, props ? { props } : undefined);
      else if (window.umami && typeof window.umami.track === 'function') window.umami.track(name, props);
    } catch {
      /* analytics must never break the page */
    }
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-cta]');
    if (a) track('CTA', { where: a.dataset.cta });
  });

  /* ---------- guilloché engine ---------- */
  // Stacked wavy rings whose phases drift: the moiré that engine-turned dials are known for.
  function rosette(ctx, size, o) {
    const c = size / 2;
    const { rings, rMin, rMax, petals, amp, drift, phase, steps, stroke, width, lighter } = o;
    ctx.save();
    ctx.translate(c, c);
    ctx.globalCompositeOperation = lighter ? 'lighter' : 'source-over';
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    for (let k = 0; k < rings; k++) {
      const f = k / (rings - 1);
      const base = (rMin + (rMax - rMin) * f) * c;
      const a = amp * c * (0.35 + 0.65 * Math.sin(f * Math.PI));
      const ph = phase + k * drift;
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * TAU;
        const r = base + a * Math.sin(petals * t + ph);
        const x = Math.cos(t) * r;
        const y = Math.sin(t) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------- hero rosette (animated) ---------- */
  // Each layer's phase drift is a pure rotation (phase / petals), so both layers are drawn once and
  // counter-rotated on the GPU every frame instead of redrawing ~40k segments per frame.
  const hero = $('#hero');
  const rosetteCanvas = $('#rosette');
  const rosetteB = document.createElement('canvas');
  rosetteB.id = 'rosette2';
  rosetteB.setAttribute('aria-hidden', 'true');
  rosetteCanvas.after(rosetteB);
  let heroVisible = true;
  let px = 0.5;
  const heroOpts = (t) => ({
    rings: small ? 46 : 78,
    rMin: 0.1,
    rMax: 0.92,
    petals: 14,
    amp: 0.075,
    drift: 0.19,
    phase: t * 0.00018,
    steps: small ? 200 : 300,
    stroke: 'rgba(160,178,255,0.2)',
    width: 0.7 * Math.min(window.devicePixelRatio || 1, 2),
    lighter: true,
  });
  // size from layout (offsetWidth), not getBoundingClientRect, which grows while the canvas is rotated
  function sizeHeroCanvas(cv) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = Math.max(2, Math.round(cv.offsetWidth * dpr));
    if (cv.width !== size) {
      cv.width = size;
      cv.height = size;
    }
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    return { ctx, size };
  }
  function drawHero() {
    const a = sizeHeroCanvas(rosetteCanvas);
    rosette(a.ctx, a.size, heroOpts(0));
    // second, counter-rotating layer: gives the interference its depth
    const b = sizeHeroCanvas(rosetteB);
    rosette(b.ctx, b.size, {
      ...heroOpts(900),
      petals: 9,
      amp: 0.05,
      rMin: 0.25,
      rMax: 0.75,
      rings: small ? 30 : 52,
      stroke: 'rgba(230,234,255,0.14)',
    });
  }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => (heroVisible = e.isIntersecting), { threshold: 0 }).observe(
      hero,
    );
  }
  addEventListener('pointermove', (e) => (px = e.clientX / innerWidth), { passive: true });
  let spin = 0;
  let prevT = 0;
  const DEG = 180 / Math.PI;
  const RATE_A = (-0.00018 / 14) * DEG; // deg per ms, the old phase drift of layer A (14 petals)
  const RATE_B = ((0.8 * 0.00018) / 9) * DEG; // layer B (9 petals) drifts the other way
  function heroLoop(t) {
    requestAnimationFrame(heroLoop);
    if (!heroVisible) return;
    // frame-rate independent easing towards the pointer
    const dt = Math.min(64, prevT ? t - prevT : 16);
    prevT = t;
    spin += ((px - 0.5) * 10 - spin) * (1 - Math.pow(0.96, dt / 16.7));
    rosetteCanvas.style.transform = `translate(-50%,-50%) rotate(${(spin + t * RATE_A).toFixed(3)}deg)`;
    rosetteB.style.transform = `translate(-50%,-50%) rotate(${(spin + t * RATE_B).toFixed(3)}deg)`;
  }
  drawHero();
  // always running, also with reduced motion: a slow rotation (under 1 degree a second) with no
  // flashing or parallax jump, like the tourbillon. It pauses only while the hero is off screen.
  requestAnimationFrame(heroLoop);

  /* ---------- stakes: digits spin like a departure board, then settle on the real value ---------- */
  // The real numbers are in the HTML (no JS, crawlers, screen readers after the spin). While spinning
  // the number keeps the width of its widest digits, then eases to its own width so the label never jumps.
  (function stakesSpin() {
    const nums = $$('.stake .num');
    const section = $('#stawka');
    if (!nums.length || !section) return;
    const DUR = 1500;
    const rnd = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
    function spin(el, delay) {
      const final = el.dataset.n || el.textContent;
      const n = final.length;
      const natural = el.getBoundingClientRect().width;
      let widest = natural;
      for (let d = 0; d < 10; d++) {
        el.textContent = String(d).repeat(n);
        widest = Math.max(widest, el.getBoundingClientRect().width);
      }
      el.textContent = rnd(n);
      el.style.width = `${widest}px`;
      el.classList.add('spinning');
      const start = performance.now() + delay;
      const tick = () => {
        const p = (performance.now() - start) / DUR;
        if (p >= 1) {
          el.textContent = final;
          el.style.width = `${natural}px`;
          el.classList.remove('spinning');
          el.addEventListener('transitionend', () => (el.style.width = ''), { once: true });
          return;
        }
        if (p >= 0) {
          // digit i locks once p passes its threshold, left to right
          let s = '';
          for (let i = 0; i < n; i++) s += p > 0.55 + (0.45 * (i + 1)) / (n + 1) ? final[i] : rnd(1);
          el.textContent = s;
        }
        // frames slow down towards the end, like a reel losing speed
        setTimeout(tick, 40 + 140 * Math.max(0, p) ** 2);
      };
      tick();
    }
    const go = () =>
      (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(() =>
        nums.forEach((el, i) => spin(el, i * 180)),
      );
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(
        ([e]) => {
          if (!e.isIntersecting) return;
          io.disconnect();
          go();
        },
        { threshold: 0.3 },
      );
      io.observe(section);
    }
  })();

  // headline entrance
  const markLoaded = () => hero.classList.add('loaded');
  if (document.fonts && document.fonts.ready)
    document.fonts.ready.then(() => requestAnimationFrame(markLoaded));
  else markLoaded();
  setTimeout(markLoaded, 1800);

  function progress(track) {
    const r = track.getBoundingClientRect();
    return clamp01(-r.top / Math.max(1, r.height - innerHeight));
  }

  /* ---------- film: how it works ---------- */
  const filmTrack = $('#filmTrack');
  const fTabs = $$('#filmTabs button');
  const fCopy = $$('#filmCopy article');
  const fActs = $$('.win .act');
  const winTitle = $('#winTitle');
  const win = $('.win');
  let live = false;
  const TITLES = [
    'stonekeep scan',
    'wniosek DSR-2026-014',
    'incydent · art. 33 RODO',
    'zgodność · całość',
  ];

  (function buildIncTicks() {
    const g = $('#incTicks');
    const NS3 = 'http://www.w3.org/2000/svg';
    for (let n = 0; n < 72; n++) {
      const a = (n / 72) * TAU - Math.PI / 2;
      const hr = n % 6 === 0;
      const r1 = 90;
      const r2 = hr ? 80 : 84;
      const l = document.createElementNS(NS3, 'line');
      l.setAttribute('x1', (Math.cos(a) * r1).toFixed(2));
      l.setAttribute('y1', (Math.sin(a) * r1).toFixed(2));
      l.setAttribute('x2', (Math.cos(a) * r2).toFixed(2));
      l.setAttribute('y2', (Math.sin(a) * r2).toFixed(2));
      l.setAttribute('class', n === 71 ? 'cur' : hr ? 'hr' : '');
      l.style.setProperty('--i', String(n));
      g.appendChild(l);
    }
  })();
  /* ---------- 4D scene: poll -> countdown -> flip into the 4th dimension -> scan -> map -> documents -> all six planes (one canvas) ---------- */
  const sxRoot = $('#sx');
  const sxCv = $('#sxCv');
  const sxCtx = sxCv.getContext('2d');
  const sxPoll = $$('#sxPoll li');
  let sxW = 0;
  let sxH = 0;
  let sxDpr = 1;
  let sxTok = 0;
  let sxStarList = null;
  let sxSky = null;
  let S = null;
  const cl = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const sstep = (a, b, x) => {
    const t = cl((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  };
  const lerp = (a, b, t) => a + (b - a) * t;
  function sxResize() {
    const w = sxRoot.clientWidth;
    const h = sxRoot.clientHeight;
    if (!w) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5); // thin glowing lines need no more
    if (w !== sxW || h !== sxH || dpr !== sxDpr) {
      sxW = w;
      sxH = h;
      sxDpr = dpr;
      sxCv.width = Math.round(w * dpr);
      sxCv.height = Math.round(h * dpr);
    }
    return true;
  }
  function sxInit() {
    if (sxStarList) return;
    let seed = 11;
    const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    sxStarList = Array.from({ length: 200 }, () => ({
      x: rnd(),
      y: rnd(),
      r: rnd() < 0.07 ? 1.5 : 0.5 + rnd() * 0.8,
      a: 0.25 + rnd() * 0.6,
      l: 0.2 + rnd() * 0.8,
    }));
    for (const s of sxStarList) s.fill = `rgba(215,225,255,${(s.a * 0.8).toFixed(2)})`;
  }
  function sxState() {
    return {
      t0: performance.now(),
      q: 0,
      flags: {},
      fc: 0,
      bump: 0,
      ang: [0.4, 0.2, 0, 0.1, 0, 0],
      un: [0, 0, 0, 0, 0, 0],
      ext: [0, 0, 0, 0],
      rings: [],
      docs: null,
      pings: null,
      flash: 0,
    };
  }
  // the tesseract: 16 vertices (+-1)^4, 32 edges between vertices that differ in one coordinate
  const TV = Array.from({ length: 16 }, (_, i) => [
    i & 1 ? 1 : -1,
    i & 2 ? 1 : -1,
    i & 4 ? 1 : -1,
    i & 8 ? 1 : -1,
  ]);
  const TE = [];
  for (let a = 0; a < 16; a++)
    for (let b = a + 1; b < 16; b++) if ([1, 2, 4, 8].includes(a ^ b)) TE.push([a, b]);
  // six areas of the briefing = six rotation planes of 4D space
  const PLANES = [
    [0, 1],
    [0, 2],
    [0, 3],
    [1, 2],
    [1, 3],
    [2, 3],
  ];
  const PSPEED = [0.42, 0.31, 0.55, 0.26, 0.47, 0.36];
  function tessProject(angs, R, cx, cy, ext) {
    return TV.map((v) => {
      const p = v.map((x, j) => x * ext[j]);
      for (let i = 0; i < 6; i++) {
        const [a, b] = PLANES[i];
        const s = Math.sin(angs[i]);
        const c2 = Math.cos(angs[i]);
        const pa = p[a];
        p[a] = pa * c2 - p[b] * s;
        p[b] = pa * s + p[b] * c2;
      }
      const f4 = 2.7 / (2.7 - p[3]);
      const x = p[0] * f4;
      const y = p[1] * f4;
      const z = p[2] * f4;
      const f3 = 4.6 / (4.6 - z);
      return { x: cx + x * f3 * R * 0.3, y: cy + y * f3 * R * 0.3, w: p[3], z, f: f3 * f4 };
    });
  }
  function sxStep(now, dt) {
    const T = now - S.t0;
    // --- DOM timeline (each step once) ---
    const q = [
      [0, null],
      [3600, () => (sxRoot.classList.add('lift'), (S.flash = 1), (S.bump = 1))],
    ];
    sxPoll.forEach((li, i) => {
      if (T > 500 + i * 560 && !li.classList.contains('go')) {
        li.classList.add('go');
        S.rings.push({ t: 0, a: 0.5 });
      }
    });
    while (S.q < q.length && T >= q[S.q][0]) {
      if (q[S.q][1]) q[S.q][1]();
      S.q++;
    }
    const W = sxW;
    const H = sxH;
    const mob = W < 600;
    const k = cl((T - 3600) / 9500);
    const e = 1 - Math.pow(1 - k, 2.2);
    const cx0 = W * (mob ? 0.5 : 0.74);
    const cy0 = H * (mob ? 0.64 : 0.5);
    const R =
      Math.min(H * (mob ? 0.3 : 0.5), W * (mob ? 0.4 : 0.25)) * (0.82 + 0.18 * sstep(0, 1, e));
    const ev = (name, cond, fn) => {
      if (cond && !S.flags[name]) {
        S.flags[name] = 1;
        fn();
      }
    };
    ev('maxq', k >= 0.2, () => (S.bump = 0.8));
    ev('meco', k >= 0.5, () => S.rings.push({ t: 0, a: 0.9 }));
    ev('sep', k >= 0.55, () => {
      sxRoot.classList.add('sep');
      S.bump = 1.4;
      S.rings.push({ t: 0, a: 1 });
    });
    ev('fair', k >= 0.65, () => {
      S.docs = Array.from({ length: 6 }, (_, i) => ({ a: (i / 6) * TAU, born: 0 }));
    });
    ev('orbit', k >= 0.995, () => {
      sxRoot.classList.add('orbit');
    });
    ev('sat', T >= 14000, () => {
      S.pings = { t: 0 };
    });
    // --- 4D state: every GO unlocks one rotation plane ---
    const goN = sxPoll.filter((li) => li.classList.contains('go')).length;
    for (let j = 0; j < 4; j++) {
      const was = S.ext[j];
      S.ext[j] += ((goN > j ? 1 : 0) - was) * Math.min(1, dt * 2.2);
      if (was < 0.5 && S.ext[j] >= 0.5) {
        S.rings.push({ t: 0, a: 0.8 });
        S.bump = 0.5;
      }
    }
    const flipT = cl((T - 3600) / 2400);
    for (let i = 0; i < 6; i++) {
      S.un[i] += ((i < goN ? 1 : 0) - S.un[i]) * Math.min(1, dt * 3);
      S.ang[i] += dt * PSPEED[i] * S.un[i] * (1 + 1.4 * sstep(0, 1, k));
    }
    // inside-out flip: the inner cube swaps places with the outer one
    const flip = Math.PI * sstep(0, 1, flipT);
    const angs = S.ang.slice();
    angs[2] += flip;
    // --- render ---
    const c = sxCtx;
    c.setTransform(sxDpr, 0, 0, sxDpr, 0, 0);
    // events give the figure a soft pulse (eased), not a random camera shake
    S.bump = Math.max(0, S.bump - dt * 1.6);
    const pulse = 1 + 0.035 * sstep(0, 1, Math.min(1, S.bump));
    // the sky only changes with the canvas size: draw it once into a cached layer
    const skyKey = `${W}x${H}x${sxDpr}`;
    if (!sxSky || sxSky.key !== skyKey) {
      const cv = document.createElement('canvas');
      cv.width = sxCv.width;
      cv.height = sxCv.height;
      const g = cv.getContext('2d');
      g.setTransform(sxDpr, 0, 0, sxDpr, 0, 0);
      const sky = g.createRadialGradient(cx0, cy0, 0, cx0, cy0, Math.max(W, H) * 0.8);
      sky.addColorStop(0, '#0a1230');
      sky.addColorStop(1, '#01020a');
      g.fillStyle = sky;
      g.fillRect(0, 0, W, H);
      sxSky = { key: skyKey, cv };
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(sxSky.cv, 0, 0);
    c.setTransform(sxDpr, 0, 0, sxDpr, 0, 0);
    c.save();
    // stars drifting slowly, a little faster once we're "inside"
    const sy = T * 0.004 * (1 + 4 * sstep(0, 0.3, k));
    for (const s of sxStarList) {
      const y = (((s.y * H + sy * s.l) % H) + H) % H;
      c.fillStyle = s.fill;
      c.fillRect(s.x * W, y, s.r, s.r);
    }
    // floor grid in perspective: the 3D world the tesseract lives in
    const gy = cy0 + R * 0.62;
    c.strokeStyle = 'rgba(120,150,255,0.12)';
    c.lineWidth = 1;
    c.beginPath();
    for (let n = -9; n <= 9; n++) {
      c.moveTo(cx0 + n * R * 0.12, gy);
      c.lineTo(cx0 + n * R * 0.55, gy + R * 0.9);
    }
    for (let n = 1; n < 7; n++) {
      const yy = gy + Math.pow(n / 7, 1.7) * R * 0.9;
      c.moveTo(cx0 - R * 1.3, yy);
      c.lineTo(cx0 + R * 1.3, yy);
    }
    c.stroke();
    // glow behind the figure
    const gl = c.createRadialGradient(cx0, cy0, 0, cx0, cy0, R * 0.9);
    const ga = 0.1 + 0.2 * (goN / 6) + 0.25 * S.flash;
    gl.addColorStop(0, `rgba(90,130,255,${ga.toFixed(3)})`);
    gl.addColorStop(1, 'rgba(90,130,255,0)');
    c.fillStyle = gl;
    c.fillRect(cx0 - R, cy0 - R, R * 2, R * 2);
    S.flash = Math.max(0, S.flash - dt * 1.2);
    // shockwave rings
    for (let i = S.rings.length - 1; i >= 0; i--) {
      const r = S.rings[i];
      r.t += dt;
      if (r.t > 1.6) {
        S.rings.splice(i, 1);
        continue;
      }
      const ph = r.t / 1.6;
      c.strokeStyle = `rgba(142,164,255,${((1 - ph) * r.a).toFixed(3)})`;
      c.lineWidth = 1.5;
      c.beginPath();
      c.ellipse(cx0, cy0, R * (0.3 + ph * 0.9), R * (0.3 + ph * 0.9) * 0.9, 0, 0, TAU);
      c.stroke();
    }
    // the tesseract, with two fading ghosts for motion blur
    const green = sstep(0.5, 1, k);
    const lit = Math.round(16 * cl(k / 0.24));
    const mapped = k >= 0.5;
    c.globalCompositeOperation = 'lighter';
    for (let gI = 2; gI >= 0; gI--) {
      const ga2 = gI === 0 ? 1 : 0.22 / gI;
      const ap = angs.map((a, i) => a - gI * 0.07 * (0.2 + S.un[i]) * PSPEED[i] * 6);
      const P = tessProject(ap, R * pulse, cx0, cy0, S.ext);
      for (const [a, b] of TE) {
        const A = P[a];
        const B = P[b];
        const wm = (A.w + B.w) / 2;
        const depth = 0.35 + 0.65 * ((wm + 1) / 2);
        const rr = Math.round(lerp(120, 63, green));
        const gg = Math.round(lerp(150, 224, green));
        const bb = Math.round(lerp(255, 162, green));
        const base = mapped ? 0.9 : 0.5;
        c.strokeStyle = `rgba(${rr},${gg},${bb},${(ga2 * depth * base * (0.35 + 0.65 * (goN / 6))).toFixed(3)})`;
        c.lineWidth = (1 + depth * 1.5) * (gI === 0 ? 1 : 1.6);
        c.beginPath();
        c.moveTo(A.x, A.y);
        c.lineTo(B.x, B.y);
        c.stroke();
      }
      if (gI === 0) {
        P.forEach((p, i) => {
          const on = i < lit || mapped;
          const rad = (1.6 + p.f * 1.4) * (on ? 1.7 : 1);
          c.fillStyle = on ? 'rgba(235,242,255,0.95)' : 'rgba(150,170,230,0.5)';
          c.beginPath();
          c.arc(p.x, p.y, rad, 0, TAU);
          c.fill();
        });
      }
    }
    c.globalCompositeOperation = 'source-over';
    // documents orbit the figure once generated
    if (S.docs) {
      const t = (now - S.t0) / 1000;
      S.docs.forEach((d) => {
        d.born += dt;
        const ap = d.a + t * 0.6;
        const rad = R * (0.95 + 0.9 * Math.exp(-d.born * 2.2));
        const x = cx0 + Math.cos(ap) * rad * 0.9;
        const y = cy0 + Math.sin(ap) * rad * 0.3;
        const back = Math.sin(ap) < 0;
        c.save();
        c.translate(x, y);
        c.globalAlpha = back ? 0.45 : 1;
        c.fillStyle = '#e8ecf8';
        c.fillRect(-4, -5.5, 8, 11);
        c.fillStyle = '#3a6bff';
        c.fillRect(-2.5, -3, 5, 1);
        c.fillRect(-2.5, -0.5, 5, 1);
        c.restore();
      });
    }
    // deadline pings from the centre
    if (S.pings) {
      S.pings.t += dt;
      for (const off of [0, 0.7, 1.4]) {
        const ph = ((S.pings.t + off) % 2.1) / 2.1;
        c.strokeStyle = `rgba(63,224,162,${((1 - ph) * 0.8).toFixed(3)})`;
        c.lineWidth = 1.4;
        c.beginPath();
        c.arc(cx0, cy0, 8 + ph * R * 0.9, 0, TAU);
        c.stroke();
      }
    }
    c.restore();
    if (T > 19700) {
      runSx();
    }
  }
  function sxLoop(tok) {
    let prev = performance.now();
    const frame = (now) => {
      if (tok !== sxTok || !live || fIdx !== 3) return;
      requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      sxStep(now, dt);
    };
    requestAnimationFrame(frame);
  }
  function runSx() {
    sxInit();
    sxTok++;
    S = sxState();
    sxRoot.className = 'sx';
    sxPoll.forEach((li) => {
      li.classList.remove('go');
    });
    if (sxResize()) sxLoop(sxTok);
  }
  addEventListener('resize', () => sxResize());

  let fIdx = -1;
  let fPinned = -1;
  let fPinAt = 0;
  let timers = [];
  const clearTimers = () => {
    timers.forEach(clearInterval);
    timers = [];
  };
  function startAct(i) {
    clearTimers();
    if (i === 0) {
      const n = $('#foundN');
      n.textContent = '0';
      const t0 = performance.now();
      timers.push(
        setInterval(() => {
          const k = Math.min(5, Math.floor(((performance.now() - t0) / 1000 - 0.7) / 0.35) + 1);
          n.textContent = String(Math.max(0, Math.min(5, k)));
        }, 120),
      );
    }
    if (i === 2) {
      const el = $('#clock');
      let s = 71 * 3600 + 42 * 60;
      const fmt = (v) =>
        `${Math.floor(v / 3600)}:${String(Math.floor((v % 3600) / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
      el.textContent = fmt(s);
      timers.push(setInterval(() => (el.textContent = fmt(--s)), 1000));
    }
    if (i === 3) runSx();
  }
  function setFilm(i) {
    if (i === fIdx) return;
    fIdx = i;
    fTabs.forEach((b, k) => b.classList.toggle('on', k === i));
    fCopy.forEach((a, k) => a.classList.toggle('on', k === i));
    fActs.forEach((a, k) => a.classList.toggle('on', k === i));
    winTitle.textContent = TITLES[i];
    $$('#mcPhases li').forEach((l, k) => {
      l.classList.toggle('on', k === i);
      l.classList.toggle('done', k < i);
    });
    if (live) startAct(i);
  }
  // the scene plays only while the window is really on screen, and replays when you come back
  function setLive(on) {
    if (on === live) return;
    live = on;
    win.classList.toggle('live', on);
    if (on) startAct(Math.max(0, fIdx));
    else clearTimers();
  }
  function onFilm() {
    const r = filmTrack.getBoundingClientRect();
    setLive(r.top < innerHeight * 0.35 && r.bottom > innerHeight * 0.65);
    const p = progress(filmTrack);
    if (fPinned >= 0 && Math.abs(p - fPinAt) > 0.06) fPinned = -1; // scrolling takes over again
    setFilm(fPinned >= 0 ? fPinned : Math.min(3, Math.floor(p * 4)));
  }
  fTabs.forEach((b, k) =>
    b.addEventListener('click', () => {
      fPinned = k;
      fPinAt = progress(filmTrack);
      setFilm(k);
    }),
  );

  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      onFilm();
    });
  }
  addEventListener('scroll', onScroll, { passive: true });
  let rz;
  addEventListener('resize', () => {
    clearTimeout(rz);
    rz = setTimeout(() => {
      drawHero(performance.now());
      onScroll();
    }, 150);
  });
  onFilm();

  /* ---------- reveal + manifest ---------- */
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        }),
      { threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
    );
    $$('.reveal').forEach((el) => io.observe(el));
  } else {
    $$('.reveal').forEach((el) => el.classList.add('in'));
  }

  /* ---------- funkcje: the seven tools are wired together ---------- */
  // Arcs left of the numerals join functions that feed each other; pulses run along them, and hovering
  // a function lights its links and the functions on the other end.
  (function compLinks() {
    const list = $('#compList');
    if (!list) return;
    const items = $$(':scope > li', list);
    // [from, to, what flows], indexes into the list (I = 0)
    const LINKS = [
      [1, 0, 'rejestr'],
      [2, 0, 'terminy'],
      [3, 0, 'termin 72 h'],
      [6, 0, 'zgody'],
      [1, 4, 'dane do dokumentów'],
      [1, 3, 'mapa danych'],
      [3, 4, 'zgłoszenie'],
      [2, 5, 'usunięcie'],
      [2, 6, 'cofnięcie zgody'],
    ];
    const names = items.map((li) => $('h3', li)?.textContent.trim() ?? '');
    // "Łączy się z" line under each description
    items.forEach((li, i) => {
      const rel = LINKS.filter(([a, b]) => a === i || b === i).map(([a, b]) => (a === i ? b : a));
      li.dataset.rel = rel.join(',');
      const p = document.createElement('p');
      p.className = 'comp-rel';
      p.innerHTML = `<span>Łączy się z</span> ${rel.map((k) => `<b>${names[k]}</b>`).join(' · ')}`;
      $('p', li)?.after(p);
    });

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'comp-wires');
    svg.setAttribute('aria-hidden', 'true');
    list.prepend(svg);
    const wires = LINKS.map(([a, b]) => {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'wire');
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('pathLength', '1');
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('r', '2.2');
      dot.setAttribute('class', 'pulse');
      g.append(path, dot);
      svg.append(g);
      return { a: Math.min(a, b), b: Math.max(a, b), g, path, dot, len: 0 };
    });
    const nodes = items.map(() => {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('r', '3.4');
      c.setAttribute('class', 'node');
      svg.append(c);
      return c;
    });

    let layoutOk = false;
    function layout() {
      const rn0 = $('.rn', items[0]);
      if (!rn0 || getComputedStyle(svg).display === 'none') return (layoutOk = false);
      svg.setAttribute('width', String(list.offsetWidth));
      svg.setAttribute('height', String(list.offsetHeight));
      // offsetTop ignores the reveal transforms, so positions are final even mid-animation
      const ys = items.map((li) => {
        const rn = $('.rn', li);
        return li.offsetTop + rn.offsetTop + rn.offsetHeight * 0.55;
      });
      // nodes sit just left of the numerals, inside the column's left padding
      const x = items[0].offsetLeft + rn0.offsetLeft + parseFloat(getComputedStyle(rn0).paddingLeft) - 14;
      nodes.forEach((c, i) => {
        c.setAttribute('cx', String(x));
        c.setAttribute('cy', ys[i].toFixed(1));
      });
      wires.forEach((w) => {
        const span = w.b - w.a;
        const bulge = Math.min(x - 6, 12 + span * 12);
        const y1 = ys[w.a];
        const y2 = ys[w.b];
        w.path.setAttribute('d', `M${x} ${y1} C${x - bulge} ${y1}, ${x - bulge} ${y2}, ${x} ${y2}`);
        w.len = w.path.getTotalLength();
      });
      layoutOk = true;
    }

    // draw a wire once both of its ends have been revealed
    function syncDrawn() {
      wires.forEach((w) =>
        w.g.classList.toggle('drawn', items[w.a].classList.contains('in') && items[w.b].classList.contains('in')),
      );
      nodes.forEach((c, i) => c.classList.toggle('on', items[i].classList.contains('in')));
    }
    const mo = new MutationObserver(syncDrawn);
    items.forEach((li) => mo.observe(li, { attributes: true, attributeFilter: ['class'] }));

    // hover: light this function's wires and the functions it talks to
    items.forEach((li, i) => {
      li.addEventListener('mouseenter', () => {
        list.classList.add('focus');
        const rel = li.dataset.rel.split(',').map(Number);
        items.forEach((o, k) => o.classList.toggle('rel', k === i || rel.includes(k)));
        wires.forEach((w) => w.g.classList.toggle('hot', w.a === i || w.b === i));
        nodes.forEach((c, k) => c.classList.toggle('hot', k === i || rel.includes(k)));
      });
      li.addEventListener('mouseleave', () => {
        list.classList.remove('focus');
        items.forEach((o) => o.classList.remove('rel'));
        wires.forEach((w) => w.g.classList.remove('hot'));
        nodes.forEach((c) => c.classList.remove('hot'));
      });
    });

    // pulses travel along drawn wires while the section is on screen
    let visible = false;
    if ('IntersectionObserver' in window)
      new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(list);
    function frame(ms) {
      requestAnimationFrame(frame);
      if (!visible || !layoutOk) return;
      wires.forEach((w, k) => {
        if (!w.g.classList.contains('drawn') || !w.len) return;
        const period = 2600 + (w.b - w.a) * 700;
        const t = ((ms + k * 830) % period) / period;
        const forward = LINKS[k][0] === w.a; // pulse runs from the feeding function to the fed one
        const pt = w.path.getPointAtLength((forward ? t : 1 - t) * w.len);
        w.dot.setAttribute('cx', pt.x.toFixed(1));
        w.dot.setAttribute('cy', pt.y.toFixed(1));
        w.dot.style.opacity = String(Math.sin(t * Math.PI).toFixed(3));
      });
    }

    const relayout = () => {
      layout();
      syncDrawn();
    };
    (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(relayout);
    relayout();
    let rt;
    addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(relayout, 150);
    });
    requestAnimationFrame(frame);
  })();

  // manifest: pinned stage, lines light up in turn with the scroll progress through the track
  (function manifestScroll() {
    const track = $('#manifestTrack');
    const lines = $$('#manifest span');
    const sub = $('#manifestSub');
    if (!track || !lines.length) return;
    const AT = [0.08, 0.3, 0.52]; // progress at which each line lights; the sub-line follows at 0.7

    // split each line into words so they light in a cascade; <em> stays one word (keeps its gradient)
    lines.forEach((line) => {
      let k = 0;
      [...line.childNodes].forEach((node) => {
        if (node.nodeType === 3) {
          const frag = document.createDocumentFragment();
          node.textContent.split(/(\s+)/).forEach((part) => {
            if (!part) return;
            if (/^\s+$/.test(part)) return frag.append(part);
            const w = document.createElement('i');
            w.className = 'w';
            w.style.setProperty('--i', k++);
            w.textContent = part;
            frag.append(w);
          });
          node.replaceWith(frag);
        } else {
          const w = document.createElement('i');
          w.className = 'w';
          w.style.setProperty('--i', k++);
          node.replaceWith(w);
          w.append(node);
        }
      });
    });

    // background dial: guilloche drawn once, ticks marking where each line lights, a hand that sweeps
    const dial = $('#mfDial');
    const hand = $('#mfHand');
    const trail = $('#mfTrail');
    const ticks = $('#mfTicks');
    if (ticks) {
      const NS = 'http://www.w3.org/2000/svg';
      for (let i = 0; i < 60; i++) {
        const a = (i / 60) * TAU - Math.PI / 2;
        const major = i % 5 === 0;
        const l = document.createElementNS(NS, 'line');
        const r1 = major ? 80 : 84;
        l.setAttribute('x1', (Math.cos(a) * r1).toFixed(2));
        l.setAttribute('y1', (Math.sin(a) * r1).toFixed(2));
        l.setAttribute('x2', (Math.cos(a) * 94).toFixed(2));
        l.setAttribute('y2', (Math.sin(a) * 94).toFixed(2));
        if (major) l.setAttribute('class', 'mj');
        ticks.append(l);
      }
      // one marker per line (and the sub-line), at the angle where it lights up
      [...AT, 0.7].forEach((p, i) => {
        const a = p * TAU - Math.PI / 2;
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('cx', (Math.cos(a) * 88).toFixed(2));
        c.setAttribute('cy', (Math.sin(a) * 88).toFixed(2));
        c.setAttribute('r', '3.2');
        c.setAttribute('class', 'mk');
        c.dataset.i = String(i);
        ticks.append(c);
      });
    }
    const marks = ticks ? $$('.mk', ticks) : [];
    function drawDial() {
      if (!dial) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const size = Math.max(2, Math.round(dial.offsetWidth * dpr));
      dial.width = size;
      dial.height = size;
      const ctx = dial.getContext('2d');
      rosette(ctx, size, {
        rings: small ? 34 : 56,
        rMin: 0.12,
        rMax: 0.78,
        petals: 12,
        amp: 0.06,
        drift: 0.22,
        phase: 0.4,
        steps: small ? 180 : 260,
        stroke: 'rgba(142,164,255,0.16)',
        width: 0.6 * dpr,
        lighter: true,
      });
    }
    drawDial();
    let rz;
    addEventListener('resize', () => {
      clearTimeout(rz);
      rz = setTimeout(drawDial, 200);
    });

    let queued = false;
    function update() {
      queued = false;
      const r = track.getBoundingClientRect();
      const p = clamp01(-r.top / Math.max(1, r.height - innerHeight));
      lines.forEach((el, i) => el.classList.toggle('lit', p >= AT[i]));
      if (sub) sub.classList.toggle('in', p >= 0.7);
      if (hand) hand.style.rotate = `${(p * 360).toFixed(2)}deg`;
      if (trail) trail.style.strokeDashoffset = (1 - p).toFixed(4);
      if (dial) dial.style.rotate = `${(p * 48 - 12).toFixed(2)}deg`;
      marks.forEach((m) => m.classList.toggle('on', p >= [...AT, 0.7][+m.dataset.i]));
    }
    const onScroll = () => {
      if (!queued) {
        queued = true;
        requestAnimationFrame(update);
      }
    };
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onScroll);
    update();
  })();

  /* ---------- cursor ring ---------- */
  const cursor = $('#cursor');
  if (cursor && matchMedia('(hover: hover) and (pointer: fine)').matches && !reduce) {
    let cx = 0;
    let cy = 0;
    let tx = 0;
    let ty = 0;
    addEventListener(
      'pointermove',
      (e) => {
        tx = e.clientX;
        ty = e.clientY;
        cursor.classList.add('on');
        cursor.classList.toggle(
          'big',
          !!e.target.closest('a, button, label, input, select, textarea, .comp-list li'),
        );
      },
      { passive: true },
    );
    document.addEventListener('mouseleave', () => cursor.classList.remove('on'));
    const follow = () => {
      cx += (tx - cx) * 0.2;
      cy += (ty - cy) * 0.2;
      cursor.style.transform = `translate(${cx.toFixed(1)}px, ${cy.toFixed(1)}px)`;
      requestAnimationFrame(follow);
    };
    follow();
  }

  /* ---------- copy command (demo block + free-start steps) ---------- */
  const copyPairs = [[$('#copyBtn'), $('#cmdText')]];
  $$('[data-copy]').forEach((btn) => copyPairs.push([btn, btn.parentElement.querySelector('[data-copy-src]')]));
  copyPairs.forEach(([copyBtn, src]) => {
    if (!copyBtn || !src) return;
    copyBtn.addEventListener('click', async () => {
      const text = src.textContent ?? '';
      track('Copy command', { command: text.replace('npx @stonekeep/cli ', '') });
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = 'Skopiowano';
      } catch {
        const range = document.createRange();
        range.selectNodeContents(src);
        const sel = getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        copyBtn.textContent = 'Zaznaczono';
      }
      setTimeout(() => (copyBtn.textContent = 'Kopiuj'), 1800);
    });
  });

  /* ---------- tourbillon: six GPU layers, three axes ---------- */
  (function tourbillon() {
    const wrap = $('#tbWrap');
    const tilt = $('#tbTilt');
    const track = $('#tbTrack');
    const glintI = $('.tb-glint i');
    const pt = (cx, cy, a, r) =>
      (cx + Math.cos(a) * r).toFixed(2) + ' ' + (cy + Math.sin(a) * r).toFixed(2);
    const wheel = (cx, cy, rIn, rOut, n, skew = 0.42) => {
      let p = '';
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * TAU;
        const s = TAU / n;
        p +=
          (i ? 'L' : 'M') +
          pt(cx, cy, a0, rIn) +
          'L' +
          pt(cx, cy, a0 + s * 0.3, rOut) +
          'L' +
          pt(cx, cy, a0 + s * (skew + 0.3), rOut) +
          'L' +
          pt(cx, cy, a0 + s * 0.9, rIn);
      }
      return p + 'Z';
    };
    const svg = (vb, inner, cls = '') =>
      `<svg viewBox="${vb}" class="${cls}" aria-hidden="true">${inner}</svg>`;
    const circle = (x, y, r, cls) => `<circle cx="${x}" cy="${y}" r="${r}" class="${cls}"/>`;
    const around = (n, r, fn) => Array.from({ length: n }, (_, i) => fn((i / n) * TAU, i)).join('');

    // shared gradients (one hidden svg)
    const defs = document.createElement('div');
    defs.innerHTML = svg(
      '0 0 1 1',
      `<defs><radialGradient id="tbGlow" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#365cff" stop-opacity="0.38"/><stop offset="100%" stop-color="#365cff" stop-opacity="0"/></radialGradient>
       <linearGradient id="tbSteelG" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#f4f2ec"/><stop offset="35%" stop-color="#8d97b5"/><stop offset="60%" stop-color="#2a3150"/><stop offset="100%" stop-color="#d9dcea"/></linearGradient></defs>`,
    );
    defs.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    wrap.appendChild(defs);

    const dial = document.createElement('canvas');
    dial.className = 'tb-plane';
    dial.style.setProperty('--z', '-92');
    tilt.appendChild(dial);

    const mk = (z, html) => {
      const d = document.createElement('div');
      d.className = 'tb-plane';
      d.style.setProperty('--z', String(z));
      d.innerHTML = html;
      tilt.appendChild(d);
      return d;
    };
    const VB = '-100 -100 200 200';
    const ticks = around(120, 93, (a, i) => {
      const r2 = i % 10 === 0 ? 89.5 : 91.4;
      return `<line x1="${(Math.cos(a) * 93).toFixed(2)}" y1="${(Math.sin(a) * 93).toFixed(2)}" x2="${(Math.cos(a) * r2).toFixed(2)}" y2="${(Math.sin(a) * r2).toFixed(2)}" class="tb-line thin"/>`;
    });
    // plane order matches the rows: 0 plate, 1 ring, 2 outer cage, 3 inner cage, 4 balance, 5 bridge
    const p0 = mk(
      -80,
      svg(
        VB,
        `<circle r="100" fill="url(#tbGlow)"/>${circle(0, 0, 96, 'tb-line')}${circle(0, 0, 93, 'tb-line thin')}${ticks}${circle(0, -87, 3.2, 'tb-jewel')}${circle(0, 87, 3.2, 'tb-jewel')}<path class="tb-bridge" d="M-94 0 L-87 -5 L-80 -5 L-80 5 L-87 5 Z M94 0 L87 -5 L80 -5 L80 5 L87 5 Z"/>`,
      ),
    );
    const p1 = mk(
      -55,
      svg(
        VB,
        `<path d="${wheel(0, 0, 83.5, 88.5, 96, 0.3)}" class="tb-tooth"/>${circle(0, 0, 82, 'tb-line thin')}`,
      ),
    );
    const screws = around(24, 78.2, (a) =>
      circle((Math.cos(a) * 78.2).toFixed(2), (Math.sin(a) * 78.2).toFixed(2), 0.9, 'tb-steel'),
    );
    const p2 = mk(
      -30,
      svg(
        VB,
        `${circle(0, 0, 80, 'tb-line steel')}${circle(0, 0, 76.5, 'tb-line thin')}<g class="tb-arms"><path d="M0 -56 L0 -76" transform="rotate(60)"/><path d="M0 -56 L0 -76" transform="rotate(180)"/><path d="M0 -56 L0 -76" transform="rotate(300)"/></g>${screws}`,
      ),
    );
    // satellite gears: small layers inside the outer cage
    const sats = [0, 120, 240].map((deg) => {
      const a = ((deg - 90) * Math.PI) / 180;
      const el = document.createElement('div');
      el.className = 'tb-sub';
      el.style.cssText = `left:${(50 + Math.cos(a) * 33.25).toFixed(2)}%;top:${(50 + Math.sin(a) * 33.25).toFixed(2)}%;width:8%;height:8%;margin:-4% 0 0 -4%`;
      el.innerHTML = svg(
        '-8 -8 16 16',
        `<path d="${wheel(0, 0, 4.6, 6.8, 14)}" class="tb-tooth"/>${circle(0, 0, 3, 'tb-line thin')}<path d="M-3 0 L3 0 M0 -3 L0 3" class="tb-line thin"/>${circle(0, 0, 1, 'tb-steel')}`,
      );
      p2.appendChild(el);
      return { el, phase: deg };
    });
    const p3 = mk(
      0,
      svg(
        VB,
        `${circle(0, 0, 56, 'tb-line steel')}${circle(0, 0, 53, 'tb-line thin')}<path d="M0 -9 L0 -53 M7.8 4.5 L45.9 26.5 M-7.8 4.5 L-45.9 26.5" class="tb-line bold"/>`,
      ),
    );
    const esc = document.createElement('div');
    esc.className = 'tb-sub';
    esc.style.cssText = 'left:50%;top:73%;width:11%;height:11%;margin:-5.5% 0 0 -5.5%';
    esc.innerHTML = svg(
      '-11 -11 22 22',
      `<path d="${wheel(0, 0, 7.2, 10.4, 15)}" class="tb-tooth"/>${circle(0, 0, 5.6, 'tb-line thin')}${circle(0, 0, 1.6, 'tb-steel')}`,
    );
    p3.appendChild(esc);
    const fork = document.createElement('div');
    fork.className = 'tb-sub';
    fork.style.cssText = 'left:45%;top:64%;width:10%;height:9%;transform-origin:50% 55.56%';
    fork.innerHTML = svg(
      '-10 28 20 18',
      `<path d="M-8 44 L-3.4 39.4 L0 37.6 L3.4 39.4 L8 44 M0 37.6 L0 31.5" class="tb-line"/>${circle(-7, 43.6, 1.5, 'tb-steel')}${circle(7, 43.6, 1.5, 'tb-steel')}${circle(0, 38, 1.2, 'tb-jewel')}`,
    );
    p3.appendChild(fork);
    let spring = '';
    for (let i = 0; i <= 200; i++) {
      const a = (i / 200) * TAU * 6;
      const r = 4 + (i / 200) * 21;
      spring += (i ? 'L' : 'M') + (Math.cos(a) * r).toFixed(2) + ' ' + (Math.sin(a) * r).toFixed(2);
    }
    const bscrews = around(16, 28.8, (a) =>
      circle((Math.cos(a) * 28.8).toFixed(2), (Math.sin(a) * 28.8).toFixed(2), 1, 'tb-steel'),
    );
    const p4 = mk(
      38,
      svg(
        VB,
        `${circle(0, 0, 30, 'tb-fill')}${circle(0, 0, 30, 'tb-line steel')}${circle(0, 0, 27.5, 'tb-line thin')}<path d="M-27.5 0 L27.5 0 M0 -27.5 L0 27.5" class="tb-line"/><path d="${spring}" class="tb-line thin"/>${bscrews}${circle(0, 0, 3.2, 'tb-steel')}`,
      ),
    );
    const p5 = mk(
      78,
      svg(
        VB,
        `<path class="tb-bridge top" d="M-70 -46 L-60 -52 L-8 -9 A9 9 0 0 1 7 -3 L-52 -34 Z"/>${circle(-62, -47, 2.6, 'tb-jewel')}${circle(-34, -30, 1.3, 'tb-steel')}${circle(0, 0, 6.4, 'tb-line thin')}${circle(0, 0, 2.6, 'tb-steel')}`,
      ),
    );
    const planes = [p0, p1, p2, p3, p4, p5];
    planes.push(dial);

    // guilloche plate, drawn once
    function drawDial() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const size = Math.round(wrap.offsetWidth * 0.94 * dpr);
      if (!size) return;
      dial.width = size;
      dial.height = size;
      rosette(dial.getContext('2d'), size, {
        rings: 80,
        rMin: 0.04,
        rMax: 0.9,
        petals: 22,
        amp: 0.03,
        drift: 0.16,
        phase: 0,
        steps: 360,
        stroke: 'rgba(160,178,255,0.12)',
        width: 0.6 * dpr,
        lighter: true,
      });
    }
    drawDial();
    addEventListener('resize', () => setTimeout(drawDial, 200));

    const F = 1.35; // balance Hz (readable; real watches run ~4 Hz)
    let ptx = null;
    let pty = null;
    let rx = 0;
    let ry = 0;
    wrap.addEventListener('pointermove', (e) => {
      const r = wrap.getBoundingClientRect();
      ptx = ((e.clientX - r.left) / r.width - 0.5) * 2;
      pty = ((e.clientY - r.top) / r.height - 0.5) * 2;
    });
    wrap.addEventListener('pointerleave', () => (ptx = pty = null));
    const easeOut = (x) => 1 - Math.pow(1 - x, 3);
    let prS = null; // scroll progress, eased so wheel steps do not jerk the movement
    let lastMs = 0;
    let lastScale = '';

    function frame(ms) {
      requestAnimationFrame(frame);
      const rect = track.getBoundingClientRect(); // read first, before any writes
      if (rect.bottom < -200 || rect.top > innerHeight + 200) {
        prS = null; // re-enter without sliding in from an old position
        return; // off screen: do nothing
      }
      const t = ms / 1000; // always running, also with reduced motion: the movement is the point of this section
      const dt = Math.min(64, lastMs ? ms - lastMs : 16);
      lastMs = ms;
      const ease = (k) => 1 - Math.pow(1 - k, dt / 16.7); // per-frame factor, frame-rate independent
      const prRaw = clamp01(-rect.top / Math.max(1, rect.height - innerHeight));
      prS = prS === null ? prRaw : prS + (prRaw - prS) * ease(0.09);
      const pr = prS;
      const scale = `translate(-50%, -50%) scale(${(0.8 + 0.24 * pr).toFixed(4)})`;
      if (scale !== lastScale) {
        // set the transform itself: a custom property here would restyle the whole movement
        wrap.style.transform = scale;
        lastScale = scale;
      }
      const a1 = (t * 360) / 48 + pr * 160;
      const a2 = -(t * 360) / 15;
      p2.style.rotate = `${(a1 % 360).toFixed(2)}deg`;
      p3.style.rotate = `${((a1 + a2) % 360).toFixed(2)}deg`;
      p1.style.rotate = `${((-a1 * 0.5) % 360).toFixed(2)}deg`;
      for (const s of sats) s.el.style.rotate = `${((-a1 * 3.4 + s.phase) % 360).toFixed(2)}deg`;
      const ph = TAU * F * t;
      p4.style.rotate = `${((258 + 10 * Math.sin(t * 0.7)) * Math.sin(ph)).toFixed(2)}deg`;
      fork.style.rotate = `${(9 * Math.tanh(5 * Math.cos(ph))).toFixed(2)}deg`;
      const k = t * F * 2;
      const n = Math.floor(k);
      const fr = k - n;
      const snap =
        fr < 0.24 ? easeOut(fr / 0.24) * 1.04 - Math.sin((fr / 0.24) * Math.PI) * 0.04 : 1;
      esc.style.rotate = `${(((n + snap) * 24) % 360).toFixed(2)}deg`;
      const tx = ptx === null ? Math.sin(t * 0.31 + 1) * 0.7 : ptx;
      const ty = ptx === null ? Math.sin(t * 0.23) * 0.7 : pty;
      ry += (tx * 18 - ry) * ease(0.06);
      rx += (-ty * 18 - rx) * ease(0.06);
      tilt.style.transform = `perspective(1700px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
      glintI.style.transform = `translate(${(-ry * 1.6).toFixed(1)}%, ${(rx * 1.6).toFixed(1)}%)`;
    }
    requestAnimationFrame(frame);
  })();

  /* ---------- nav: solid bar, themed by the section under it ---------- */
  const navEl = $('#nav');
  const lightSections = [];
  function navState() {
    navEl.classList.toggle('solid', scrollY > 40);
    const y = 36;
    navEl.classList.toggle(
      'on-light',
      lightSections.some((s) => {
        const r = s.getBoundingClientRect();
        return r.top <= y && r.bottom >= y;
      }),
    );
  }
  addEventListener('scroll', navState, { passive: true });
  navState();

  /* ---------- demo: card + wizard ---------- */
  const form = $('#demoForm');
  const msg = $('#formMsg');
  const submit = $('#demoSubmit');
  const cfg = window.STONEKEEP_SITE || {};
  // the footer e-mail link is filled in by the template (render.mjs) from config.js

  // card art + live binding
  const card = $('#card');
  const cardArt = $('#cardArt');
  function drawCard() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = Math.round(cardArt.offsetWidth * dpr);
    if (!size) return;
    cardArt.width = size;
    cardArt.height = size;
    rosette(cardArt.getContext('2d'), size, {
      rings: 64,
      rMin: 0.12,
      rMax: 0.62,
      petals: 16,
      amp: 0.045,
      drift: 0.17,
      phase: 0,
      steps: 300,
      stroke: 'rgba(160,178,255,0.17)',
      width: 0.6 * dpr,
      lighter: true,
    });
  }
  drawCard();
  addEventListener('resize', () => setTimeout(drawCard, 200));

  const serial = String(1000 + Math.floor(Math.random() * 8999));
  $('#cSerial').textContent = `N° ${serial}`;

  const cName = $('#cName');
  const cCompany = $('#cCompany');
  const cSize = $('#cSize');
  const cScope = $('#cScope');
  const setTxt = (el, value, ph) => {
    el.textContent = value || ph;
    el.classList.toggle('is-ph', !value);
  };
  const scopeBoxes = $$('#scopeChips input');
  const scopeValues = () => scopeBoxes.filter((b) => b.checked).map((b) => b.value);
  function syncCard() {
    setTxt(cName, $('#f-name').value.trim(), 'Twoje imię');
    setTxt(cCompany, $('#f-company').value.trim(), 'Twoja firma lub projekt');
    cSize.textContent = $('#f-size').value;
    const s = scopeValues();
    cScope.innerHTML = s.length
      ? s.map((v) => `<span>${v}</span>`).join('')
      : '<span class="ph">Pełny przegląd</span>';
  }
  ['#f-name', '#f-company'].forEach((s) => $(s).addEventListener('input', syncCard));
  scopeBoxes.forEach((b) => b.addEventListener('change', syncCard));
  syncCard();

  // flip: tap the card or use the button
  const flipBtn = $('#flipBtn');
  const setFlip = (on) => {
    card.classList.toggle('flipped', on);
    flipBtn.setAttribute('aria-pressed', String(on));
    flipBtn.textContent = on ? 'Pokaż przód' : 'Odwróć kartę';
    if (!on) closeEgg();
  };
  flipBtn.addEventListener('click', () => setFlip(!card.classList.contains('flipped')));
  card.addEventListener('click', () => setFlip(!card.classList.contains('flipped')));

  // easter egg: the security code on the back of the card is 072, the 72 hours of art. 33
  const cvv = $('#cvv');
  const eggMsg = $('#eggMsg');
  const EGG = [
    '<b>Znalazłeś ukryty sekret.</b> 072 to 72 godziny na zgłoszenie wycieku do UODO (art. 33 RODO). U nas to kod bezpieczeństwa karty.',
    'Dobrze, już wiemy, że lubisz klikać. Jak lubisz porządek w danych, zamów demo.',
    'Karta to tylko wizytówka. Jak zobaczysz kod strony, zobaczysz, że ten sekret jest w nim od początku.',
  ];
  let eggN = 0;
  function closeEgg() {
    cvv.classList.remove('open');
    eggMsg.hidden = true;
  }
  function eggBurst() {
    const r = cvv.getBoundingClientRect();
    for (let n = 0; n < 24; n++) {
      const t = document.createElement('i');
      t.className = 'egg-tick';
      t.style.left = `${r.left + r.width / 2}px`;
      t.style.top = `${r.top + r.height / 2}px`;
      const a = (n / 24) * Math.PI * 2;
      const d = 50 + Math.random() * 90;
      t.style.setProperty('--dx', `${Math.cos(a) * d}px`);
      t.style.setProperty('--dy', `${Math.sin(a) * d}px`);
      t.style.setProperty('--r', `${(Math.random() - 0.5) * 540}deg`);
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 1500);
    }
  }
  cvv.addEventListener('click', (e) => {
    e.stopPropagation(); // do not flip the card back
    cvv.classList.add('open');
    eggMsg.innerHTML = EGG[Math.min(eggN, EGG.length - 1)];
    eggMsg.hidden = false;
    if (eggN === 0 && !reduce) eggBurst();
    eggN++;
  });

  // 3D tilt, parallax of the layers, iridescent sheen
  const stage = $('#cardStage');
  if (matchMedia('(hover: hover) and (pointer: fine)').matches && !reduce) {
    stage.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      const x = Math.max(-0.6, Math.min(0.6, (e.clientX - r.left) / r.width - 0.5));
      const y = Math.max(-0.6, Math.min(0.6, (e.clientY - r.top) / r.height - 0.5));
      card.style.transform = `rotateY(${(x * 18).toFixed(2)}deg) rotateX(${(-y * 18).toFixed(2)}deg)`;
      card.style.setProperty('--px', (x * 2).toFixed(2));
      card.style.setProperty('--py', (y * 2).toFixed(2));
      card.style.setProperty('--sx', `${(100 - (x + 0.5) * 140).toFixed(0)}%`);
      card.style.setProperty('--ix', `${((x + 0.5) * 100).toFixed(0)}%`);
      card.style.setProperty('--iy', `${((y + 0.5) * 100).toFixed(0)}%`);
      card.style.setProperty('--io', '0.65');
    });
    stage.addEventListener('pointerleave', () => {
      card.style.transform = '';
      card.style.setProperty('--px', '0');
      card.style.setProperty('--py', '0');
      card.style.setProperty('--sx', '120%');
      card.style.setProperty('--io', '0');
    });
  }

  // payment scene: the card is tapped on a Stonekeep terminal, which approves it.
  // Purely visual: nothing is charged, the demo is free.
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const pos = $('#pos');
  const leds = $$('#pos .pos-leds i');
  let paying = false;

  // theatre: the whole scene is shown full screen, scaled to the viewport height
  const narrItems = $$('#narr li');
  const theaterCta = $('#theaterCta');
  const theaterX = $('#theaterX');
  const scene = $('#scene');
  let placeholder = null;
  const inTheater = () => stage.classList.contains('theater');
  function fitTheater() {
    // card above the terminal: the whole scene must fit the window
    const top = innerWidth <= 900 ? 64 : 20;
    // pos.scrollHeight is its full height even while it is still sliding open
    const natural = top + card.offsetHeight + pos.scrollHeight + (innerWidth <= 900 ? 96 : 40);
    scene.style.setProperty('--fit', Math.min(1, (innerHeight - 16) / natural).toFixed(3));
  }
  function enterTheater() {
    if (inTheater()) return;
    placeholder = document.createElement('div');
    placeholder.style.height = `${stage.offsetHeight}px`;
    stage.before(placeholder);
    stage.classList.add('theater');
    document.body.classList.add('theater-on');
    theaterCta.hidden = true;
    narrStep(-1);
    fitTheater();
  }
  function exitTheater() {
    if (!inTheater()) return;
    stage.classList.remove('theater');
    document.body.classList.remove('theater-on');
    scene.style.removeProperty('--fit');
    if (placeholder) placeholder.remove();
    placeholder = null;
    setTimeout(() => trail.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
  }
  function narrStep(i) {
    narrItems.forEach((li, k) => {
      li.classList.toggle('on', k === i);
      li.classList.toggle('done', k < i);
    });
  }
  theaterX.addEventListener('click', exitTheater);
  theaterCta.addEventListener('click', exitTheater);
  addEventListener('keydown', (e) => e.key === 'Escape' && exitTheater());
  addEventListener('resize', () => inTheater() && fitTheater());

  async function paymentScene() {
    if (paying) return;
    paying = true;
    setFlip(false);
    resetTrail();
    pos.className = 'pos';
    leds.forEach((l) => l.classList.remove('on'));
    card.classList.remove('done');
    enterTheater();
    stage.classList.add('paying');
    narrStep(0);
    await wait(1100);
    card.classList.add('tap');
    await wait(900);
    pos.classList.add('reading');
    narrStep(1);
    leds.forEach((l, i) => setTimeout(() => l.classList.add('on'), 250 + i * 300));
    await wait(1450);
    pos.classList.remove('reading');
    pos.classList.add('ok');
    narrStep(2);
    card.classList.add('done');
    trailIn();
    await wait(1100);
    card.classList.remove('tap');
    await wait(900);
    narrItems.forEach((li) => li.classList.add('done'));
    narrItems.forEach((li) => li.classList.remove('on'));
    theaterCta.hidden = false;
    paying = false;
  }

  // story: after the card payment, show where the data went, then erase it the way Stonekeep would
  const trail = $('#trail');
  const trailItems = $$('#trailList li');
  const trailBtn = $('#trailBtn');
  const trailRes = $('#trailRes');
  const invoice = $('#invoice');
  const stampEl = $('#cStamp');
  const STATUS = { in: 'zapisano', wiping: 'usuwanie…', gone: 'usunięto', kept: 'zostaje: prawo' };

  function resetTrail() {
    trailItems.forEach((li) => {
      li.classList.remove('in', 'wiping', 'gone', 'kept');
      li.querySelector('.t-st').textContent = STATUS.in;
    });
    trailBtn.hidden = true;
    trailRes.hidden = true;
    invoice.hidden = true;
    invoice.classList.remove('kept');
    card.classList.remove('wiped');
    stampEl.textContent = 'Zamówiono';
    syncCard();
  }
  function trailIn() {
    const name = $('#f-name').value.trim() || 'Anna Kowalska';
    const email = $('#f-email').value.trim() || 'anna@sklep.pl';
    const company = $('#f-company').value.trim();
    const data = {
      db: `${name} · ${email}${company ? ' · ' + company : ''}`,
      pay: `token karty N° ${serial} · imię i nazwisko`,
      news: `${email} · subskrybent`,
      logs: 'adres IP, przeglądarka, godzina zamówienia',
      inv: `faktura za demo · 0,00 zł · ${company ? 'na firmę ' + company : 'na ' + name}`,
    };
    trailItems.forEach((li) => (li.querySelector('.t-data').textContent = data[li.dataset.k]));
    const now = new Date();
    const pad = (v) => String(v).padStart(2, '0');
    $('#invBuyer').textContent = company || name;
    $('#invMail').textContent = company ? `${name} · ${email}` : email;
    $('#invDate').textContent =
      `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}`;
    $('#invNo').textContent = `FV/${now.getFullYear()}/${pad(now.getMonth() + 1)}/${serial}`;
    $('#invCard').textContent = `N° ${serial}`;
    form.classList.add('sent');
    trail.hidden = false;
    trailItems.forEach((li, i) => setTimeout(() => li.classList.add('in'), 300 + i * 450));
    setTimeout(() => (invoice.hidden = false), 300 + trailItems.length * 450);
    setTimeout(() => (trailBtn.hidden = false), 300 + trailItems.length * 450 + 700);
  }
  trailBtn.addEventListener('click', async () => {
    trailBtn.hidden = true;
    for (const li of trailItems) {
      const st = li.querySelector('.t-st');
      li.classList.add('wiping');
      st.textContent = STATUS.wiping;
      await wait(950);
      li.classList.remove('wiping');
      if (li.dataset.k === 'inv') {
        li.classList.add('kept');
        st.textContent = STATUS.kept;
        invoice.classList.add('kept');
        invoice.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        await wait(900);
      } else {
        li.classList.add('gone');
        st.textContent = STATUS.gone;
      }
      await wait(150);
    }
    // the card forgets its owner too
    cName.textContent = '••••••••';
    cName.classList.add('is-ph');
    cCompany.textContent = 'dane usunięte';
    cCompany.classList.add('is-ph');
    stampEl.textContent = 'Dane usunięte';
    card.classList.add('wiped');
    trailRes.hidden = false;
    setTimeout(() => trailRes.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
  });

  // size options
  const sizeInput = $('#f-size');
  const opts = $$('#sizeOpts .opt');
  opts.forEach((o) =>
    o.addEventListener('click', () => {
      opts.forEach((x) => {
        const on = x === o;
        x.classList.toggle('on', on);
        x.setAttribute('aria-checked', String(on));
      });
      sizeInput.value = o.dataset.v;
      syncCard();
    }),
  );

  // steps
  const panels = $$('.step', form);
  const bars = $$('.bars i', form);
  const stepNo = $('#stepNo');
  const nextBtn = $('#nextBtn');
  const backBtn = $('#backBtn');
  const nav = $('.step-nav', form);
  let step = 0;
  function show(i) {
    step = i;
    panels.forEach((p, k) => p.classList.toggle('on', k === i));
    bars.forEach((b, k) => b.classList.toggle('on', k <= i));
    stepNo.textContent = ROMAN5[i];
    backBtn.hidden = i === 0;
    nav.classList.toggle('last', i === panels.length - 1);
    msg.textContent = '';
    msg.className = 'form-msg';
    const focusEl = panels[i].querySelector(
      'input:not([type=hidden]):not([type=checkbox]), textarea',
    );
    if (focusEl && i !== 3) setTimeout(() => focusEl.focus({ preventScroll: true }), 60);
  }
  const ROMAN5 = ['I', 'II', 'III', 'IV', 'V'];
  const fail = (text) => {
    msg.className = 'form-msg err';
    msg.textContent = text;
  };
  function validate(i) {
    if (i === 0) {
      const ok = !!$('#f-name').value.trim();
      $('#f-name').setAttribute('aria-invalid', String(!ok));
      if (!ok) fail('Podaj imię i nazwisko.');
      return ok;
    }
    if (i === 1) {
      const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test($('#f-email').value.trim());
      $('#f-email').setAttribute('aria-invalid', String(!ok));
      if (!ok) fail('Podaj poprawny adres e-mail.');
      return ok;
    }
    return true;
  }
  const go = (d) => {
    if (d > 0 && !validate(step)) return;
    const n = Math.max(0, Math.min(panels.length - 1, step + d));
    if (n !== step) {
      if (n > step) track('Form step', { step: String(n + 1) });
      show(n);
    }
  };
  nextBtn.addEventListener('click', () => go(1));
  backBtn.addEventListener('click', () => go(-1));
  form.addEventListener('keydown', (e) => {
    if (
      e.key === 'Enter' &&
      step < panels.length - 1 &&
      e.target.tagName !== 'TEXTAREA' &&
      e.target.tagName !== 'BUTTON'
    ) {
      e.preventDefault();
      go(1);
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.className = 'form-msg';
    if (!validate(0)) return show(0);
    if (!validate(1)) return show(1);
    if (!$('#f-consent').checked)
      return fail('Zaznacz zgodę na kontakt, abyśmy mogli się odezwać.');
    const scope = scopeValues();
    const extra = $('#f-msg').value.trim();
    const payload = {
      name: $('#f-name').value.trim(),
      email: $('#f-email').value.trim(),
      company: $('#f-company').value.trim(),
      size: sizeInput.value,
      message: [scope.length ? `Zakres: ${scope.join(', ')}` : '', extra]
        .filter(Boolean)
        .join('\n'),
      source: location.href,
    };
    // honeypot: people never see this field, simple bots fill it in
    if ($('#f-hp')?.value) {
      msg.textContent = 'Dziękujemy. Odezwiemy się w ciągu dwóch dni roboczych.';
      return;
    }
    submit.disabled = true;
    try {
      if (cfg.demoEndpoint) {
        const res = await fetch(cfg.demoEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(String(res.status));
        track('Demo request', { size: payload.size });
        msg.textContent = 'Dziękujemy. Odezwiemy się w ciągu dwóch dni roboczych.';
        paymentScene();
      } else if (cfg.contactEmail) {
        // no form backend yet: hand the answers to the visitor's mail app, nothing is lost
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
        msg.textContent =
          'Otworzyliśmy Twój program pocztowy. Wyślij wiadomość, a odezwiemy się w ciągu dwóch dni roboczych.';
        paymentScene();
      } else {
        // nothing configured: play the scene, but do not pretend the request went anywhere
        msg.textContent =
          'To wersja pokazowa: formularz nie jest jeszcze podłączony, więc nic nie zostało wysłane.';
        paymentScene();
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
    }
  });
})();
