import { describe, expect, it, vi } from "vitest";
import {
  buildAdsJourneyRpcArgs,
  isPaidJourneyTouch,
  recordAdsJourneyActivityBestEffort,
  resolvePrAd,
  type AdsJourneyRpcArgs,
} from "./ads-journey.ts";

describe("public-tracking Ads journey attribution", () => {
  it("accepts only the exact paid UTM medium, ignoring case and whitespace", () => {
    expect(isPaidJourneyTouch({ utm_medium: "paid" })).toBe(true);
    expect(isPaidJourneyTouch({ utm_medium: " PAID " })).toBe(true);

    for (const utmMedium of [
      "ads",
      "cpc",
      "ppc",
      "paid_social",
      "paid-search",
      "organic",
      "",
    ]) {
      expect(isPaidJourneyTouch({ utm_medium: utmMedium })).toBe(false);
    }
  });

  it("accepts a non-empty custom pr_ad marker", () => {
    expect(isPaidJourneyTouch({ pr_ad: "campaign-42" })).toBe(true);
    expect(isPaidJourneyTouch({ pr_ad: "  campaign-42  " })).toBe(true);
    expect(isPaidJourneyTouch({ pr_ad: "   " })).toBe(false);
  });

  it("bounds the public custom marker before persistence", () => {
    expect(resolvePrAd({ pr_ad: "x".repeat(700) })).toHaveLength(512);
  });

  it("recovers pr_ad from public page URLs when the explicit field is absent", () => {
    expect(resolvePrAd({
      page_url: "https://example.com/reservar?utm_source=instagram&pr_ad=jp-01",
    })).toBe("jp-01");

    expect(resolvePrAd({
      path: "/reservar?pr_ad=path-marker",
    })).toBe("path-marker");

    expect(resolvePrAd({
      event_source_url: "https://example.com/reservar?pr_ad=source-marker",
      page_url: "https://example.com/reservar?pr_ad=page-marker",
    })).toBe("source-marker");
  });

  it("uses the server receipt time and the exact database RPC argument names", () => {
    const args = buildAdsJourneyRpcArgs(
      {
        utm_source: " instagram ",
        utm_medium: " PAID ",
        utm_campaign: " launch ",
        pr_ad: " creative-a ",
      },
      {
        companyId: "company-id",
        anonymousId: "anonymous-id",
        sessionId: "session-id",
        journeyId: "journey-id",
        reservationId: "reservation-id",
        eventName: "schedule_selected",
        eventId: "event-id",
        receivedAt: "2026-07-27T12:34:56.000Z",
      },
    );

    expect(args).toEqual({
      _company_id: "company-id",
      _anonymous_id: "anonymous-id",
      _activity_at: "2026-07-27T12:34:56.000Z",
      _utm_source: "instagram",
      _utm_medium: "PAID",
      _utm_campaign: "launch",
      _pr_ad: "creative-a",
      _session_id: "session-id",
      _journey_id: "journey-id",
      _reservation_id: "reservation-id",
      _event_name: "schedule_selected",
      _event_id: "event-id",
    });
  });

  it("falls back to UTM medium from the current URL for older callers", () => {
    const args = buildAdsJourneyRpcArgs(
      {
        page_url: "https://example.com/reservar?utm_medium=paid",
      },
      {
        companyId: "company-id",
        anonymousId: "anonymous-id",
        sessionId: "session-id",
        journeyId: null,
        reservationId: null,
        eventName: "session_ping",
        eventId: "event-id",
        receivedAt: "2026-07-27T12:34:56.000Z",
      },
    );

    expect(args._utm_medium).toBe("paid");
    expect(isPaidJourneyTouch({
      page_url: "https://example.com/reservar?utm_medium=paid",
    })).toBe(true);
  });

  it("does not lose an exact paid URL marker when another field says organic", () => {
    const input = {
      utm_medium: "organic",
      event_source_url: "https://example.com/reservar?utm_medium=paid",
    };

    expect(isPaidJourneyTouch(input)).toBe(true);
    expect(buildAdsJourneyRpcArgs(input, {
      companyId: "company-id",
      anonymousId: "anonymous-id",
      sessionId: "session-id",
      journeyId: null,
      reservationId: null,
      eventName: "page_view",
      eventId: "event-id",
      receivedAt: "2026-07-27T12:34:56.000Z",
    })._utm_medium).toBe("paid");
  });

  it("returns false and reports RPC errors so the caller can retry", async () => {
    const warn = vi.fn();
    const args = {
      _company_id: "company-id",
      _anonymous_id: "anonymous-id",
      _activity_at: "2026-07-27T12:34:56.000Z",
      _utm_source: null,
      _utm_medium: "paid",
      _utm_campaign: null,
      _pr_ad: null,
      _session_id: "session-id",
      _journey_id: null,
      _reservation_id: null,
      _event_name: "page_view",
      _event_id: "event-id",
    } satisfies AdsJourneyRpcArgs;

    await expect(recordAdsJourneyActivityBestEffort(
      {
        rpc: async () => {
          throw new Error("RPC unavailable");
        },
      },
      args,
      { warn },
    )).resolves.toBe(false);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[public-tracking] Ads journey attribution failed",
      expect.objectContaining({
        company_id: "company-id",
        event_name: "page_view",
        error_message: "RPC unavailable",
      }),
    );
  });

  it("stops waiting for a stalled attribution RPC", async () => {
    const warn = vi.fn();
    const args = {
      _company_id: "company-id",
      _anonymous_id: "anonymous-id",
      _activity_at: "2026-07-27T12:34:56.000Z",
      _utm_source: null,
      _utm_medium: null,
      _utm_campaign: null,
      _pr_ad: null,
      _session_id: "session-id",
      _journey_id: null,
      _reservation_id: null,
      _event_name: "session_ping",
      _event_id: "event-id",
    } satisfies AdsJourneyRpcArgs;

    await expect(recordAdsJourneyActivityBestEffort(
      {
        rpc: () => new Promise(() => undefined),
      },
      args,
      { warn },
      5,
    )).resolves.toBe(false);

    expect(warn).toHaveBeenCalledWith(
      "[public-tracking] Ads journey attribution failed",
      expect.objectContaining({
        error_message: "RPC timed out after 5ms",
      }),
    );
  });
});
