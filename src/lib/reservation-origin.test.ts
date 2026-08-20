import { describe, expect, it } from 'vitest';
import {
  classifyReservationOrigin,
  RESERVATION_ORIGIN_CONFIG,
} from '@/lib/reservation-origin';

describe('reservation-origin', () => {
  it('exposes only the four operational entry methods', () => {
    expect(RESERVATION_ORIGIN_CONFIG).toEqual({
      online: {
        label: 'Online',
        color: 'hsl(202, 89%, 48%)',
      },
      affiliate: {
        label: 'Filiados e parceiros',
        color: 'hsl(145, 63%, 42%)',
      },
      manual: {
        label: 'Criada no painel',
        color: 'hsl(0, 0%, 35%)',
      },
      waitlist: {
        label: 'Convertida da fila',
        color: 'hsl(338, 78%, 55%)',
      },
    });
  });

  it('gives converted waitlist reservations the highest precedence', () => {
    expect(classifyReservationOrigin({
      source: 'waitlist',
      origin_affiliate_link_id: 'affiliate-1',
      origin_tracking_session_id: 'session-1',
      attribution_snapshot: { tracking_source: 'public_web', utm_medium: 'paid_social' },
    })).toBe('waitlist');
  });

  it('classifies an affiliate link before public web markers', () => {
    expect(classifyReservationOrigin({
      source: 'reservation',
      origin_tracking_session_id: 'session-1',
      origin_affiliate_link_id: 'affiliate-1',
      attribution_snapshot: { tracking_source: 'public_web', utm_medium: 'cpc' },
    })).toBe('affiliate');
  });

  it('uses the affiliate link itself as sufficient operational evidence', () => {
    expect(classifyReservationOrigin({
      source: 'reservation',
      origin_affiliate_link_id: 'affiliate-1',
    })).toBe('affiliate');
  });

  it.each([
    {
      marker: 'origin tracking session',
      reservation: { origin_tracking_session_id: 'session-1' },
    },
    {
      marker: 'anonymous visitor',
      reservation: { origin_anonymous_id: 'visitor-1' },
    },
    {
      marker: 'public attribution snapshot',
      reservation: { attribution_snapshot: { tracking_source: 'public_web' } },
    },
  ])('classifies public reservations from $marker as online', ({ reservation }) => {
    expect(classifyReservationOrigin({
      source: 'reservation',
      ...reservation,
    })).toBe('online');
  });

  it('does not split online reservations by UTM or Meta click identifiers', () => {
    expect(classifyReservationOrigin({
      source: 'reservation',
      origin_tracking_session_id: 'session-1',
      attribution_snapshot: {
        tracking_source: 'public_web',
        utm_source: 'instagram',
        utm_medium: 'paid_social',
        fbclid: 'fb-click-id',
        fbc: 'fb.1.123.fb-click-id',
      },
      tracking_session: {
        utm_medium: 'cpc',
        fbclid: 'another-click-id',
        fbc: 'fb.1.456.another-click-id',
      },
      session_utm_medium: 'paid',
      session_fbclid: 'session-click-id',
      session_fbc: 'fb.1.789.session-click-id',
      origin_fbc: 'fb.1.999.origin-click-id',
    })).toBe('online');
  });

  it('classifies reservations without public, affiliate or waitlist evidence as manual', () => {
    expect(classifyReservationOrigin({ source: 'reservation' })).toBe('manual');
    expect(classifyReservationOrigin({})).toBe('manual');
  });

  it('does not turn marketing attribution alone into an online entry marker', () => {
    expect(classifyReservationOrigin({
      source: 'reservation',
      attribution_snapshot: {
        utm_source: 'instagram',
        utm_medium: 'paid_social',
        fbclid: 'fb-click-id',
        fbc: 'fb.1.123.fb-click-id',
      },
      tracking_session: {
        utm_medium: 'paid',
        fbclid: 'another-click-id',
        fbc: 'fb.1.456.another-click-id',
      },
    })).toBe('manual');
  });
});
