// HeroSlideshow.tsx — auto-advancing screenshot slideshow for the hero.
//
// Self-contained carousel (no external lib). Cross-fades through 5 admin-UI
// captures inside a faux app-window frame. Auto-advances every 4s, pauses on
// hover/focus, jumps via dot indicators. Respects prefers-reduced-motion.
//
// Hydrate lazily with Astro's client:visible — it's in the hero's right
// column, just at/below the fold, so the first frame is the LCP image (eager).

import { useEffect, useState } from 'react';

interface Slide {
  src: string;
  /** Short title shown in the faux title bar. */
  label: string;
  /** Full alt text for screen readers. */
  alt: string;
  /** Tiny mono caption under the frame. */
  caption: string;
}

// The 5 most striking + representative shots for "real, polished product".
const SLIDES: Slide[] = [
  {
    src: '/screenshots/filebrowser.jpg',
    label: 'Object browser',
    alt: 'DeltaGlider object browser showing a versioned zip with 97.2% storage savings, delta metadata and download/share controls.',
    caption: 'Transparent delta dedup — 97% saved, same S3 API',
  },
  {
    src: '/screenshots/analytics.jpg',
    label: 'Storage analytics',
    alt: 'Live storage analytics dashboard: total storage, space saved via delta compression, and per-bucket compression ratios.',
    caption: 'Live compression analytics across every bucket',
  },
  {
    src: '/screenshots/iam.jpg',
    label: 'Identity & access',
    alt: 'IAM user management with fine-grained ABAC permissions mapped to users, groups and OAuth roles.',
    caption: 'Fine-grained ABAC — users, groups, OAuth roles',
  },
  {
    src: '/screenshots/object-replication.jpg',
    label: 'Replication',
    alt: 'Cross-bucket replication rules between S3, MinIO and Hetzner with pause and resume controls.',
    caption: 'Cross-bucket replication, pause & resume',
  },
  {
    src: '/screenshots/advanced_security.jpg',
    label: 'Encryption',
    alt: 'Advanced security configuration with AES-256-GCM at-rest encryption and customer-held keys.',
    caption: 'AES-256-GCM at rest — you hold the keys',
  },
];

const INTERVAL_MS = 4000;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export default function HeroSlideshow() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  // Track which images have been requested so we never re-flash on revisit.
  const [loaded, setLoaded] = useState<Set<number>>(() => new Set([0]));

  const count = SLIDES.length;
  const go = (i: number) => setActive(((i % count) + count) % count);

  // Ensure the ACTIVE image (and the next, for a seamless cross-fade) are in
  // the render set. Jumping via a dot to a not-yet-loaded slide must still show
  // its image immediately — so we add both `active` and `active+1` here.
  useEffect(() => {
    const next = (active + 1) % count;
    setLoaded((prev) => {
      if (prev.has(active) && prev.has(next)) return prev;
      const copy = new Set(prev);
      copy.add(active);
      copy.add(next);
      return copy;
    });
  }, [active, count]);

  // Auto-advance. Disabled entirely under reduced-motion or while paused.
  useEffect(() => {
    if (reducedMotion || paused) return;
    const id = window.setInterval(() => {
      setActive((a) => (a + 1) % count);
    }, INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [reducedMotion, paused, count]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      go(active + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      go(active - 1);
    }
  };

  return (
    <div
      className={`hero-slideshow${reducedMotion ? ' is-reduced' : ''}`}
      role="group"
      aria-roledescription="carousel"
      aria-label="DeltaGlider admin UI screenshots"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      onKeyDown={onKeyDown}
    >
      {/* Stacked depth plates behind the frame for a layered, premium feel. */}
      <div className="hero-slideshow__stack" aria-hidden="true">
        <span className="hero-slideshow__plate hero-slideshow__plate--2" />
        <span className="hero-slideshow__plate hero-slideshow__plate--1" />
      </div>

      <div className="hero-slideshow__window">
        {/* Faux app chrome */}
        <div className="hero-slideshow__chrome">
          <span className="hero-slideshow__dots" aria-hidden="true">
            <i /><i /><i />
          </span>
          <span className="hero-slideshow__titlebar" aria-live="polite">
            <span className="hero-slideshow__app">DeltaGlider</span>
            <span className="hero-slideshow__sep">/</span>
            <span className="hero-slideshow__label">{SLIDES[active].label}</span>
          </span>
          <span className="hero-slideshow__chrome-spacer" aria-hidden="true" />
        </div>

        {/* Stage */}
        <div className="hero-slideshow__stage">
          {SLIDES.map((slide, i) => {
            const isActive = i === active;
            return (
              <figure
                key={slide.src}
                className={`hero-slideshow__slide${isActive ? ' is-active' : ''}`}
                role="group"
                aria-roledescription="slide"
                aria-label={`${i + 1} of ${count}: ${slide.label}`}
                aria-hidden={!isActive}
              >
                {(loaded.has(i) || i === active || i === 0) && (
                  <img
                    src={slide.src}
                    alt={slide.alt}
                    width={1147}
                    height={1440}
                    loading={i === 0 ? 'eager' : 'lazy'}
                    // @ts-expect-error fetchpriority is valid HTML, not yet in React types
                    fetchpriority={i === 0 ? 'high' : 'auto'}
                    decoding="async"
                    draggable={false}
                  />
                )}
                <figcaption className="hero-slideshow__caption">
                  {slide.caption}
                </figcaption>
              </figure>
            );
          })}
          <span className="hero-slideshow__sheen" aria-hidden="true" />
        </div>
      </div>

      {/* Indicators */}
      <div className="hero-slideshow__indicators" role="tablist" aria-label="Choose a screenshot">
        {SLIDES.map((slide, i) => (
          <button
            key={slide.src}
            type="button"
            role="tab"
            aria-selected={i === active}
            aria-label={slide.label}
            className={`hero-slideshow__dot${i === active ? ' is-active' : ''}`}
            onClick={() => go(i)}
          >
            <span className="hero-slideshow__dot-fill" />
          </button>
        ))}
      </div>
    </div>
  );
}
