import { afterEach, describe, expect, it, vi } from 'vitest';
import { isServiceTodayEnabled } from './service-today-enabled';
afterEach(() => vi.unstubAllEnvs());
describe('released Service today area', () => {
  it.each([true, false])('is available in development and production (DEV=%s), regardless of an obsolete pilot value', (development) => {
    vi.stubEnv('DEV', development);
    for (const configured of [undefined, 'false', 'true']) {
      vi.stubEnv('VITE_SERVICE_TODAY_ENABLED', configured);
      expect(isServiceTodayEnabled()).toBe(true);
    }
  });
});
