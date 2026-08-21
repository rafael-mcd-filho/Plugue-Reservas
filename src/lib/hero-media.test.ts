import { describe, expect, it } from 'vitest';
import { HERO_MEDIA_MAX_IMAGE_SIZE, HERO_MEDIA_MAX_VIDEO_SIZE, validateHeroMediaFile } from './hero-media';

function makeFile(type: string, size: number): File {
  return { type, size } as File;
}

describe('validateHeroMediaFile', () => {
  it('accepts an image within the size limit', () => {
    const file = makeFile('image/png', HERO_MEDIA_MAX_IMAGE_SIZE);
    expect(validateHeroMediaFile(file)).toEqual({ valid: true, type: 'image' });
  });

  it('rejects an image over the size limit', () => {
    const file = makeFile('image/jpeg', HERO_MEDIA_MAX_IMAGE_SIZE + 1);
    const result = validateHeroMediaFile(file);
    expect(result.valid).toBe(false);
  });

  it('accepts a video within the size limit', () => {
    const file = makeFile('video/mp4', HERO_MEDIA_MAX_VIDEO_SIZE);
    expect(validateHeroMediaFile(file)).toEqual({ valid: true, type: 'video' });
  });

  it('rejects a video over the size limit', () => {
    const file = makeFile('video/mp4', HERO_MEDIA_MAX_VIDEO_SIZE + 1);
    const result = validateHeroMediaFile(file);
    expect(result.valid).toBe(false);
  });

  it('rejects unsupported file types', () => {
    const file = makeFile('application/pdf', 1024);
    const result = validateHeroMediaFile(file);
    expect(result.valid).toBe(false);
  });
});
