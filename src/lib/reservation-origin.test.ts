import { describe, expect, it } from 'vitest';
import { classifyReservationOrigin } from '@/lib/reservation-origin';

describe('reservation-origin', () => {
  it('classifies waitlist reservations before any tracking rule', () => {
    expect(classifyReservationOrigin({ source: 'waitlist' })).toBe('waitlist');
  });

  it('classifies reservations without public tracking as manual', () => {
    expect(classifyReservationOrigin({ source: 'reservation' })).toBe('manual');
  });

  it('classifies affiliate reservations before paid traffic', () => {
    expect(classifyReservationOrigin({
      source: 'reservation',
      origin_tracking_session_id: 'session-1',
      origin_affiliate_link_id: 'affiliate-1',
      attribution_snapshot: { tracking_source: 'public_web', utm_medium: 'cpc' },
    })).toBe('affiliate');
  });

  it('classifies paid public reservations as ads', () => {
    expect(classifyReservationOrigin({
      source: 'reservation',
      origin_tracking_session_id: 'session-1',
      attribution_snapshot: { tracking_source: 'public_web', utm_medium: 'paid_social' },
    })).toBe('ads');
  });

  it('falls back to the linked tracking session utm_medium when the reservation snapshot has no paid marker', () => {
    expect(classifyReservationOrigin({
      source: 'reservation',
      origin_tracking_session_id: 'session-1',
      attribution_snapshot: { tracking_source: 'public_web' },
      tracking_session: { utm_medium: 'paid' },
    })).toBe('ads');
  });

  it('classifies public non-paid reservations as direct organic', () => {
    expect(classifyReservationOrigin({
      source: 'reservation',
      origin_anonymous_id: 'visitor-1',
      attribution_snapshot: { tracking_source: 'public_web', utm_medium: 'organic' },
    })).toBe('direct_organic');
  });
});
