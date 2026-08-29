import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PublicHeroMedia from './PublicHeroMedia';
import { normalizePublicHeroMediaUrls } from '@/lib/publicHeroMedia';

class AutoLoadingImage {
  onload: null | (() => void) = null;

  set src(_url: string) {
    queueMicrotask(() => this.onload?.());
  }
}

function setReducedMotion(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
}

describe('PublicHeroMedia', () => {
  const originalImage = window.Image;

  beforeEach(() => {
    vi.useFakeTimers();
    setReducedMotion(false);
    Object.defineProperty(window, 'Image', { configurable: true, value: AutoLoadingImage });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Object.defineProperty(window, 'Image', { configurable: true, value: originalImage });
  });

  it('normaliza, remove duplicadas, limita quatro imagens e usa o legado como fallback', () => {
    expect(normalizePublicHeroMediaUrls([' a.jpg ', '', 'a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'], 'old.jpg'))
      .toEqual(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']);
    expect(normalizePublicHeroMediaUrls([], ' old.jpg ')).toEqual(['old.jpg']);
  });

  it('mantem uma imagem unica estatica e priorizada', () => {
    const { container } = render(
      <PublicHeroMedia urls={['cover.jpg']} type="image" resetKey="company-a" />,
    );

    const image = container.querySelector('img');
    expect(image).toHaveAttribute('src', 'cover.jpg');
    expect(image).toHaveAttribute('loading', 'eager');
    expect(image).toHaveAttribute('fetchpriority', 'high');
  });

  it('faz crossfade depois do preload e reinicia ao trocar a lista', async () => {
    const { container, rerender } = render(
      <PublicHeroMedia urls={['one.jpg', 'two.jpg']} type="image" resetKey="company-a" />,
    );

    await act(async () => {
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });
    expect(container.querySelectorAll('img')).toHaveLength(2);

    act(() => vi.advanceTimersByTime(6_000));
    expect(container.querySelector('img[src="two.jpg"]')).toHaveStyle({ opacity: '1' });

    rerender(<PublicHeroMedia urls={['new.jpg', 'next.jpg']} type="image" resetKey="company-b" />);
    expect(container.querySelector('img[src="new.jpg"]')).toHaveStyle({ opacity: '1' });
  });

  it('exibe somente a primeira imagem quando movimento reduzido esta ativo', () => {
    setReducedMotion(true);
    const { container } = render(
      <PublicHeroMedia urls={['one.jpg', 'two.jpg']} type="image" />,
    );

    act(() => vi.advanceTimersByTime(20_000));
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.querySelector('img')).toHaveAttribute('src', 'one.jpg');
  });

  it('pausa a rotacao enquanto a pagina esta oculta', async () => {
    let hidden = false;
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden,
    });
    const { container } = render(
      <PublicHeroMedia urls={['one.jpg', 'two.jpg']} type="image" />,
    );

    await act(async () => {
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });
    hidden = true;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    act(() => vi.advanceTimersByTime(12_000));
    expect(container.querySelector('img[src="one.jpg"]')).toHaveStyle({ opacity: '1' });

    hidden = false;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    act(() => vi.advanceTimersByTime(6_000));
    expect(container.querySelector('img[src="two.jpg"]')).toHaveStyle({ opacity: '1' });
  });

  it('mantem video unico com autoplay silencioso e loop', () => {
    const { container } = render(
      <PublicHeroMedia urls={['hero.mp4', 'ignored.mp4']} type="video" />,
    );

    const videos = container.querySelectorAll('video');
    expect(videos).toHaveLength(1);
    expect(videos[0]).toHaveAttribute('src', 'hero.mp4');
    expect(videos[0]).toHaveProperty('muted', true);
    expect(videos[0]).toHaveAttribute('loop');
  });
});
