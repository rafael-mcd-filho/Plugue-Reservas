export type HeroMediaType = 'image' | 'video';

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
