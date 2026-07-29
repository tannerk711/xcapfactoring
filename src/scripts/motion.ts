// GSAP motion foundation. Loaded lazily after idle from Base.astro; never on
// prefers-reduced-motion (CSS fallback keeps everything visible). One signature
// moment per section, transform/opacity only.
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

let inited = false;

export function init() {
  if (inited) return;
  inited = true;
  gsap.registerPlugin(ScrollTrigger);

  const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
    Array.from(root.querySelectorAll<T>(sel));

  /* ---- entrance reveals ---- */
  for (const el of $$('[data-reveal]')) {
    gsap.from(el, {
      autoAlpha: 0,
      y: 26,
      duration: 0.8,
      ease: 'power3.out',
      scrollTrigger: { trigger: el, start: 'top 88%', once: true },
    });
  }
  for (const group of $$('[data-reveal-group]')) {
    gsap.from(group.children, {
      autoAlpha: 0,
      y: 24,
      duration: 0.7,
      ease: 'power3.out',
      stagger: 0.12,
      scrollTrigger: { trigger: group, start: 'top 86%', once: true },
    });
  }

  /* ---- marker highlight sweep ---- */
  for (const el of $$('[data-marker]')) {
    gsap.fromTo(
      el,
      { backgroundSize: '0% 0.46em' },
      {
        backgroundSize: '100% 0.46em',
        duration: 0.9,
        delay: parseFloat(el.dataset.markerDelay ?? '0'),
        ease: 'power2.inOut',
        scrollTrigger: { trigger: el, start: 'top 90%', once: true },
      },
    );
  }

  /* ---- count-ups (tabular nums) ---- */
  for (const el of $$('[data-countup]')) {
    const to = parseFloat(el.dataset.countup ?? '0');
    const from = parseFloat(el.dataset.from ?? '0');
    const dec = parseInt(el.dataset.decimals ?? '0', 10);
    const prefix = el.dataset.prefix ?? '';
    const suffix = el.dataset.suffix ?? '';
    const fmt = (v: number) =>
      prefix + v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + suffix;
    el.textContent = fmt(from);
    const state = { v: from };
    ScrollTrigger.create({
      trigger: el,
      start: 'top 88%',
      once: true,
      onEnter: () =>
        gsap.to(state, {
          v: to,
          duration: parseFloat(el.dataset.duration ?? '1.8'),
          ease: 'power2.out',
          onUpdate: () => (el.textContent = fmt(state.v)),
        }),
    });
  }

  /* ---- ledger rule draw ---- */
  for (const el of $$('[data-rule-draw]')) {
    gsap.from(el, {
      scaleX: 0,
      duration: 1.1,
      ease: 'power3.inOut',
      scrollTrigger: { trigger: el, start: 'top 94%', once: true },
    });
  }

  /* ---- SVG stroke draws ---- */
  for (const path of $$<SVGPathElement>('[data-draw-path]')) {
    const len = path.getTotalLength();
    gsap.fromTo(
      path,
      { strokeDasharray: len, strokeDashoffset: len },
      {
        strokeDashoffset: 0,
        duration: 0.7,
        ease: 'power2.out',
        scrollTrigger: { trigger: path.closest('svg') ?? path, start: 'top 90%', once: true },
      },
    );
  }

  /* ---- pointer tilt + magnetic (fine pointers only) ---- */
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    for (const el of $$('[data-tilt]')) {
      const max = parseFloat(el.dataset.tilt || '6');
      gsap.set(el, { transformPerspective: 900 });
      const rx = gsap.quickTo(el, 'rotationX', { duration: 0.65, ease: 'power3' });
      const ry = gsap.quickTo(el, 'rotationY', { duration: 0.65, ease: 'power3' });
      const zone = (el.closest('[data-tilt-zone]') as HTMLElement) ?? el;
      zone.addEventListener('pointermove', (e) => {
        const r = el.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        rx(gsap.utils.clamp(-max, max, -py * max * 2));
        ry(gsap.utils.clamp(-max, max, px * max * 2));
      });
      zone.addEventListener('pointerleave', () => {
        rx(0);
        ry(0);
      });
    }
    for (const el of $$('[data-magnetic]')) {
      const tx = gsap.quickTo(el, 'x', { duration: 0.4, ease: 'power3' });
      const ty = gsap.quickTo(el, 'y', { duration: 0.4, ease: 'power3' });
      el.addEventListener('pointermove', (e) => {
        const r = el.getBoundingClientRect();
        tx((e.clientX - (r.left + r.width / 2)) * 0.22);
        ty((e.clientY - (r.top + r.height / 2)) * 0.3);
      });
      el.addEventListener('pointerleave', () => {
        tx(0);
        ty(0);
      });
    }
  }

  /* ---- hero photo: Ken Burns drift + scroll parallax ---- */
  for (const el of $$('[data-kenburns]')) {
    gsap.fromTo(el, { scale: 1 }, { scale: 1.06, duration: 20, ease: 'sine.inOut', repeat: -1, yoyo: true });
  }
  for (const el of $$('[data-parallax]')) {
    const amt = parseFloat(el.dataset.parallax || '0.12') * 100;
    gsap.to(el, {
      yPercent: amt,
      ease: 'none',
      scrollTrigger: {
        trigger: (el.closest('[data-parallax-zone]') as HTMLElement) ?? el,
        start: 'top bottom',
        end: 'bottom top',
        scrub: true,
      },
    });
  }

  /* ---- wedge gauge arc ---- */
  const gauge = document.querySelector<SVGPathElement>('[data-gauge-arc]');
  if (gauge) {
    const len = gauge.getTotalLength();
    const min = parseFloat(gauge.dataset.gaugeMin ?? '15');
    const max = parseFloat(gauge.dataset.gaugeMax ?? '60');
    const from = parseFloat(gauge.dataset.gaugeFrom ?? '24');
    const to = parseFloat(gauge.dataset.gaugeTo ?? '30');
    const frac = (v: number) => (v - min) / (max - min);
    gsap.fromTo(
      gauge,
      { strokeDasharray: len, strokeDashoffset: len * (1 - frac(from)) },
      {
        strokeDashoffset: len * (1 - frac(to)),
        duration: 2,
        ease: 'power2.inOut',
        scrollTrigger: { trigger: gauge.closest('[data-gauge]') ?? gauge, start: 'top 80%', once: true },
      },
    );
  }

  /* ---- proof band light sweep ---- */
  for (const el of $$('[data-band-sweep]')) {
    gsap.fromTo(
      el,
      { xPercent: -140 },
      {
        xPercent: 420,
        duration: 2.2,
        ease: 'power2.inOut',
        scrollTrigger: { trigger: el.parentElement, start: 'top 65%', once: true },
      },
    );
  }

  /* ---- comparison rows: staggered reveal + exit-row stamp thunk ---- */
  for (const row of $$('[data-compare-row]')) {
    gsap.from(row, {
      autoAlpha: 0,
      y: 18,
      duration: 0.6,
      ease: 'power3.out',
      scrollTrigger: { trigger: row, start: 'top 90%', once: true },
    });
  }
  for (const stamp of $$('[data-compare-stamp]')) {
    gsap.from(stamp, {
      autoAlpha: 0,
      scale: 1.7,
      rotation: 6,
      duration: 0.45,
      ease: 'back.out(2.4)',
      scrollTrigger: { trigger: stamp, start: 'top 88%', once: true },
    });
  }

  /* ---- steps progress line ---- */
  const stepLine = document.querySelector('[data-step-line]');
  if (stepLine) {
    gsap.from(stepLine, {
      scaleX: 0,
      transformOrigin: 'left center',
      duration: 1.4,
      ease: 'power2.inOut',
      scrollTrigger: { trigger: stepLine.parentElement, start: 'top 78%', once: true },
    });
  }

  /* ---- THE CENTERPIECE: pinned contract X-ray ---- */
  const xray = document.querySelector<HTMLElement>('[data-xray]');
  if (xray) {
    const sheet = xray.querySelector<HTMLElement>('[data-xray-sheet]');
    const scan = xray.querySelector<HTMLElement>('[data-xray-scan]');
    const clauses = [0, 1, 2, 3].map((i) => $$(`[data-xray-clause="${i}"]`, xray));
    const stamps = [0, 1, 2, 3].map((i) => xray.querySelector<HTMLElement>(`[data-xray-stamp="${i}"]`));
    const counter = xray.querySelector<HTMLElement>('[data-xray-counter]');
    const captions = $$('[data-xray-caption]', xray);
    const total = parseFloat(counter?.dataset.total ?? '0');

    const setActiveCaption = (idx: number) => {
      captions.forEach((c, i) => c.classList.toggle('xray-active', i <= idx));
    };

    const buildTimeline = (pinned: boolean) => {
      const counterState = { v: 0 };
      const fmt = (v: number) => '$' + Math.round(v).toLocaleString('en-US');
      if (counter) counter.textContent = fmt(0);
      stamps.forEach((s) => s && gsap.set(s, { autoAlpha: 0, scale: 1.7, rotation: 9 }));
      clauses.forEach((els) => els.forEach((el) => el.style.setProperty('--hl', '0')));
      setActiveCaption(-1);

      const tl = gsap.timeline({
        scrollTrigger: pinned
          ? {
              trigger: xray,
              start: 'top top',
              end: '+=2200',
              scrub: 0.4,
              pin: true,
              anticipatePin: 1,
            }
          : {
              trigger: xray,
              start: 'top 70%',
              end: 'bottom 55%',
              scrub: 0.6,
            },
      });

      if (scan && sheet) {
        tl.fromTo(scan, { y: 0 }, { y: () => sheet.clientHeight + 120, ease: 'none', duration: 5 }, 0);
      }
      // Dollar share per clause of the illustrative total. The exit window costs time,
      // not annual dollars, so it never moves the counter.
      const share = [0.61, 0.21, 0.18, 0];
      let acc = 0;
      [0, 1, 2, 3].forEach((i) => {
        const at = 0.7 + i * 1.05;
        clauses[i].forEach((el) =>
          tl.to(el, { '--hl': 1, duration: 0.4, ease: 'power2.out' } as gsap.TweenVars, at),
        );
        if (stamps[i]) {
          tl.to(stamps[i], { autoAlpha: 1, scale: 1, rotation: -7, duration: 0.32, ease: 'back.out(2.6)' }, at + 0.18);
        }
        tl.call(setActiveCaption, [i], at + 0.05);
        acc += share[i];
        if (counter && total > 0) {
          tl.to(
            counterState,
            {
              v: total * acc,
              duration: 0.85,
              ease: 'power1.out',
              onUpdate: () => (counter.textContent = fmt(counterState.v)),
            },
            at,
          );
        }
      });
      return tl;
    };

    const mm = gsap.matchMedia();
    mm.add('(min-width: 768px)', () => {
      const tl = buildTimeline(true);
      return () => tl.scrollTrigger?.kill();
    });
    mm.add('(max-width: 767.98px)', () => {
      const tl = buildTimeline(false);
      return () => tl.scrollTrigger?.kill();
    });
  }

  ScrollTrigger.refresh();
}
