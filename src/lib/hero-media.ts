export type HeroMediaType = 'image' | 'video';

export interface PendingHeroMediaUploadRecord {
  companyId: string;
  path: string;
  url: string;
}

export const HERO_MEDIA_MAX_IMAGES = 4;
export const HERO_MEDIA_MAX_IMAGE_SIZE = 5 * 1024 * 1024;
export const HERO_MEDIA_MAX_VIDEO_SIZE = 15 * 1024 * 1024;

export type HeroMediaValidationResult =
  | { valid: true; type: HeroMediaType }
  | { valid: false; error: string };

export function validateHeroMediaFile(file: File): HeroMediaValidationResult {
  if (file.type.startsWith('image/')) {
    if (file.size > HERO_MEDIA_MAX_IMAGE_SIZE) {
      return { valid: false, error: 'A imagem de fundo deve ter no máximo 5MB' };
    }

    return { valid: true, type: 'image' };
  }

  if (file.type.startsWith('video/')) {
    if (file.size > HERO_MEDIA_MAX_VIDEO_SIZE) {
      return { valid: false, error: 'O vídeo de fundo deve ter no máximo 15MB' };
    }

    return { valid: true, type: 'video' };
  }

  return { valid: false, error: 'Selecione uma imagem ou um vídeo válido' };
}

export function validateHeroMediaFiles(files: readonly File[]): HeroMediaValidationResult {
  if (files.length === 0) {
    return { valid: false, error: 'Selecione ao menos uma imagem ou um vídeo' };
  }

  const validations = files.map(validateHeroMediaFile);
  const invalid = validations.find((validation) => !validation.valid);

  if (invalid && !invalid.valid) {
    return invalid;
  }

  const types = validations.map((validation) => validation.valid ? validation.type : null);
  const hasImages = types.includes('image');
  const hasVideos = types.includes('video');

  if (hasImages && hasVideos) {
    return {
      valid: false,
      error: 'Escolha apenas imagens ou apenas um vídeo. Não é possível misturar os formatos.',
    };
  }

  if (hasVideos && files.length > 1) {
    return { valid: false, error: 'Selecione somente um vídeo por vez.' };
  }

  if (hasImages && files.length > HERO_MEDIA_MAX_IMAGES) {
    return {
      valid: false,
      error: `Selecione no máximo ${HERO_MEDIA_MAX_IMAGES} imagens.`,
    };
  }

  return { valid: true, type: hasVideos ? 'video' : 'image' };
}

export function getCompanyHeroMediaStoragePath(
  url: string,
  companyId: string,
  systemAssetsPublicUrl: string,
): string | null {
  if (!url || !companyId || !systemAssetsPublicUrl) return null;

  try {
    const sourceUrl = new URL(url);
    const bucketUrl = new URL(systemAssetsPublicUrl);
    const publicObjectPrefix = bucketUrl.pathname.endsWith('/')
      ? bucketUrl.pathname
      : `${bucketUrl.pathname}/`;

    if (sourceUrl.origin !== bucketUrl.origin || !sourceUrl.pathname.startsWith(publicObjectPrefix)) {
      return null;
    }

    const encodedStoragePath = sourceUrl.pathname.slice(publicObjectPrefix.length);
    const storagePath = decodeURIComponent(encodedStoragePath);
    const expectedPrefix = `company-hero-media/${companyId}/`;
    const relativePath = storagePath.slice(expectedPrefix.length);

    if (
      !storagePath.startsWith(expectedPrefix)
      || !relativePath
      || storagePath.includes('\\')
      || storagePath.split('/').includes('..')
    ) {
      return null;
    }

    return storagePath;
  } catch {
    return null;
  }
}

export function partitionPendingHeroMediaUploads(
  uploads: readonly PendingHeroMediaUploadRecord[],
  companyId: string,
  persistedUrls: readonly string[],
) {
  const persistedUrlSet = new Set(persistedUrls);
  const persisted: PendingHeroMediaUploadRecord[] = [];
  const orphaned: PendingHeroMediaUploadRecord[] = [];

  for (const upload of uploads) {
    if (upload.companyId !== companyId) continue;
    (persistedUrlSet.has(upload.url) ? persisted : orphaned).push(upload);
  }

  return { persisted, orphaned };
}
