import { useEffect, useMemo, useState } from 'react';
import { normalizePublicHeroMediaUrls } from '@/lib/publicHeroMedia';
import { cn } from '@/lib/utils';

const HERO_SLIDE_INTERVAL_MS = 6_000;
const HERO_CROSSFADE_DURATION_MS = 1_200;

interface PublicHeroMediaProps {
  urls?: readonly string[] | null;
  fallbackUrl?: string | null;
  type: 'image' | 'video';
  className?: string;
  resetKey?: string | null;
}

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function getReducedMotionPreference() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function useReducedMotion() {
  const [reducedMotion, setReducedMotion] = useState(getReducedMotionPreference);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => setReducedMotion(mediaQuery.matches);
    updatePreference();
    mediaQuery.addEventListener?.('change', updatePreference);

    return () => mediaQuery.removeEventListener?.('change', updatePreference);
  }, []);

  return reducedMotion;
}

export default function PublicHeroMedia({
  urls,
  fallbackUrl,
  type,
  className = '',
  resetKey,
}: PublicHeroMediaProps) {
  const normalizedUrls = useMemo(
    () => normalizePublicHeroMediaUrls(urls, fallbackUrl),
    [fallbackUrl, urls],
  );
  const mediaIdentity = `${resetKey ?? ''}|${type}|${normalizedUrls.join('|')}`;
  const reducedMotion = useReducedMotion();
  const [activeIndex, setActiveIndex] = useState(0);
  const [loadedIndexes, setLoadedIndexes] = useState<Set<number>>(() => new Set([0]));
  const [pageHidden, setPageHidden] = useState(
    () => typeof document !== 'undefined' && document.hidden,
  );

  useEffect(() => {
    setActiveIndex(0);
    setLoadedIndexes(new Set([0]));
  }, [mediaIdentity]);

  useEffect(() => {
    if (type !== 'image' || normalizedUrls.length < 2 || reducedMotion) return;

    let active = true;
    let idleHandle: number | undefined;
    let timeoutHandle: number | undefined;
    const images: HTMLImageElement[] = [];

    const preloadRemainingImages = () => {
      normalizedUrls.slice(1).forEach((url, offset) => {
        const image = new Image();
        const index = offset + 1;
        image.onload = () => {
          if (!active) return;
          setLoadedIndexes((current) => {
            if (current.has(index)) return current;
            const next = new Set(current);
            next.add(index);
            return next;
          });
        };
        image.src = url;
        images.push(image);
      });
    };

    const schedulePreload = () => {
      const idleWindow = window as IdleWindow;
      if (idleWindow.requestIdleCallback) {
        idleHandle = idleWindow.requestIdleCallback(preloadRemainingImages, { timeout: 2_000 });
      } else {
        timeoutHandle = window.setTimeout(preloadRemainingImages, 0);
      }
    };

    if (document.readyState === 'complete') {
      schedulePreload();
    } else {
      window.addEventListener('load', schedulePreload, { once: true });
    }

    return () => {
      active = false;
      window.removeEventListener('load', schedulePreload);
      if (idleHandle !== undefined) (window as IdleWindow).cancelIdleCallback?.(idleHandle);
      if (timeoutHandle !== undefined) window.clearTimeout(timeoutHandle);
      images.forEach((image) => {
        image.onload = null;
      });
    };
  }, [mediaIdentity, normalizedUrls, reducedMotion, type]);

  useEffect(() => {
    const updateVisibility = () => setPageHidden(document.hidden);
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  useEffect(() => {
    if (type !== 'image' || reducedMotion || pageHidden || normalizedUrls.length < 2) return;

    const timer = window.setInterval(() => {
      setActiveIndex((current) => {
        for (let distance = 1; distance < normalizedUrls.length; distance += 1) {
          const candidate = (current + distance) % normalizedUrls.length;
          if (loadedIndexes.has(candidate)) return candidate;
        }
        return current;
      });
    }, HERO_SLIDE_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [loadedIndexes, normalizedUrls.length, pageHidden, reducedMotion, type]);

  if (normalizedUrls.length === 0) return null;

  const containerClassName = cn('relative overflow-hidden', className);

  if (type === 'video') {
    return (
      <div className={containerClassName} aria-hidden="true">
        <video
          key={normalizedUrls[0]}
          src={normalizedUrls[0]}
          className="absolute inset-0 h-full w-full object-cover"
          autoPlay
          loop
          muted
          playsInline
          preload="metadata"
          aria-hidden="true"
          tabIndex={-1}
        />
      </div>
    );
  }

  const visibleUrls = reducedMotion ? normalizedUrls.slice(0, 1) : normalizedUrls;

  return (
    <div className={containerClassName} aria-hidden="true">
      {visibleUrls.map((url, index) => {
        if (index > 0 && !loadedIndexes.has(index)) return null;

        return (
          <img
            key={url}
            src={url}
            alt=""
            aria-hidden="true"
            width={1600}
            height={900}
            loading={index === 0 ? 'eager' : 'lazy'}
            decoding="async"
            {...(index === 0 ? { fetchpriority: 'high' } : {})}
            className="pointer-events-none absolute inset-0 h-full w-full object-cover"
            style={{
              opacity: index === activeIndex ? 1 : 0,
              transition: `opacity ${HERO_CROSSFADE_DURATION_MS}ms ease-in-out`,
            }}
          />
        );
      })}
    </div>
  );
}
