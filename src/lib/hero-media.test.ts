import { describe, expect, it } from 'vitest';
import {
  HERO_MEDIA_MAX_IMAGES,
  HERO_MEDIA_MAX_IMAGE_SIZE,
  HERO_MEDIA_MAX_VIDEO_SIZE,
  getCompanyHeroMediaStoragePath,
  partitionPendingHeroMediaUploads,
  validateHeroMediaFile,
  validateHeroMediaFiles,
} from './hero-media';

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

describe('getCompanyHeroMediaStoragePath', () => {
  const companyId = 'company-123';
  const bucketUrl = 'https://project.supabase.co/storage/v1/object/public/system-assets/';

  it('extracts a path from this company public system-assets URL', () => {
    expect(getCompanyHeroMediaStoragePath(
      `https://project.supabase.co/storage/v1/object/public/system-assets/company-hero-media/${companyId}/banner%201.jpg`,
      companyId,
      bucketUrl,
    )).toBe(`company-hero-media/${companyId}/banner 1.jpg`);
  });

  it('rejects media that belongs to another company', () => {
    expect(getCompanyHeroMediaStoragePath(
      'https://project.supabase.co/storage/v1/object/public/system-assets/company-hero-media/another-company/banner.jpg',
      companyId,
      bucketUrl,
    )).toBeNull();
  });

  it('rejects URLs from another bucket or prefix', () => {
    expect(getCompanyHeroMediaStoragePath(
      `https://project.supabase.co/storage/v1/object/public/other-bucket/company-hero-media/${companyId}/banner.jpg`,
      companyId,
      bucketUrl,
    )).toBeNull();
    expect(getCompanyHeroMediaStoragePath(
      `https://project.supabase.co/storage/v1/object/public/system-assets/company-logos/${companyId}/logo.jpg`,
      companyId,
      bucketUrl,
    )).toBeNull();
  });

  it('rejects a matching path hosted outside the configured Supabase origin', () => {
    expect(getCompanyHeroMediaStoragePath(
      `https://example.com/storage/v1/object/public/system-assets/company-hero-media/${companyId}/banner.jpg`,
      companyId,
      bucketUrl,
    )).toBeNull();
  });

  it('rejects invalid URLs and traversal attempts', () => {
    expect(getCompanyHeroMediaStoragePath('not-a-url', companyId, bucketUrl)).toBeNull();
    expect(getCompanyHeroMediaStoragePath(
      `https://project.supabase.co/storage/v1/object/public/system-assets/company-hero-media/${companyId}/..%2Fsecret.jpg`,
      companyId,
      bucketUrl,
    )).toBeNull();
  });
});

describe('validateHeroMediaFiles', () => {
  it('accepts up to four images', () => {
    const files = Array.from(
      { length: HERO_MEDIA_MAX_IMAGES },
      () => makeFile('image/jpeg', HERO_MEDIA_MAX_IMAGE_SIZE),
    );

    expect(validateHeroMediaFiles(files)).toEqual({ valid: true, type: 'image' });
  });

  it('rejects more than four images', () => {
    const files = Array.from(
      { length: HERO_MEDIA_MAX_IMAGES + 1 },
      () => makeFile('image/jpeg', 1024),
    );

    expect(validateHeroMediaFiles(files)).toEqual({
      valid: false,
      error: `Selecione no máximo ${HERO_MEDIA_MAX_IMAGES} imagens.`,
    });
  });

  it('accepts one video', () => {
    expect(validateHeroMediaFiles([makeFile('video/mp4', 1024)]))
      .toEqual({ valid: true, type: 'video' });
  });

  it('rejects multiple videos', () => {
    const files = [makeFile('video/mp4', 1024), makeFile('video/webm', 1024)];

    expect(validateHeroMediaFiles(files)).toEqual({
      valid: false,
      error: 'Selecione somente um vídeo por vez.',
    });
  });

  it('rejects mixed images and videos', () => {
    const files = [makeFile('image/png', 1024), makeFile('video/mp4', 1024)];

    expect(validateHeroMediaFiles(files)).toEqual({
      valid: false,
      error: 'Escolha apenas imagens ou apenas um vídeo. Não é possível misturar os formatos.',
    });
  });

  it('rejects an empty selection', () => {
    expect(validateHeroMediaFiles([])).toEqual({
      valid: false,
      error: 'Selecione ao menos uma imagem ou um vídeo',
    });
  });

  it('propagates an invalid individual file', () => {
    const result = validateHeroMediaFiles([
      makeFile('image/png', 1024),
      makeFile('application/pdf', 1024),
    ]);

    expect(result.valid).toBe(false);
  });
});

describe('partitionPendingHeroMediaUploads', () => {
  const uploads = [
    { companyId: 'company-a', path: 'a/cover.jpg', url: 'https://cdn.test/cover.jpg' },
    { companyId: 'company-a', path: 'a/removed.jpg', url: 'https://cdn.test/removed.jpg' },
    { companyId: 'company-b', path: 'b/banner.jpg', url: 'https://cdn.test/banner.jpg' },
  ];

  it('preserves only pending files that were persisted for the target company', () => {
    expect(partitionPendingHeroMediaUploads(
      uploads,
      'company-a',
      ['https://cdn.test/cover.jpg'],
    )).toEqual({
      persisted: [uploads[0]],
      orphaned: [uploads[1]],
    });
  });

  it('does not include uploads from another company in either cleanup group', () => {
    expect(partitionPendingHeroMediaUploads(uploads, 'company-a', [])).toEqual({
      persisted: [],
      orphaned: [uploads[0], uploads[1]],
    });
  });
});
