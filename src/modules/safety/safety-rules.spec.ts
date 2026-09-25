import { RideStatus } from "../rides/ride-state-machine";
import { normalizePhone } from "./phone";
import { renderShareErrorPage, renderSharedRidePage } from "./share-ride-page";
import { effectiveShareExpiry, publicRideStatus } from "./share-ride-view";
import type { SharedRideView } from "./share-ride-view";
import { SosStatus, canTransitionSos, sosAllowed } from "./sos-lifecycle";

describe("sosAllowed", () => {
  const now = new Date("2026-09-25T10:00:00Z");

  it("covers the active ride for both participants", () => {
    for (const status of [RideStatus.DRIVER_ACCEPTED, RideStatus.DRIVER_ARRIVED, RideStatus.RIDE_STARTED]) {
      expect(sosAllowed("CUSTOMER", { status }, 30, now)).toBe(true);
      expect(sosAllowed("DRIVER", { status }, 30, now)).toBe(true);
    }
  });

  it("a merely offered driver cannot raise SOS; the customer can", () => {
    expect(sosAllowed("CUSTOMER", { status: RideStatus.DRIVER_ASSIGNED }, 30, now)).toBe(true);
    expect(sosAllowed("DRIVER", { status: RideStatus.DRIVER_ASSIGNED }, 30, now)).toBe(false);
  });

  it("not before a driver is involved", () => {
    expect(sosAllowed("CUSTOMER", { status: RideStatus.SEARCHING }, 30, now)).toBe(false);
    expect(sosAllowed("CUSTOMER", { status: RideStatus.NO_DRIVER_AVAILABLE }, 30, now)).toBe(false);
  });

  it("stays available for the grace period after the ride ends", () => {
    const ended = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);
    expect(sosAllowed("CUSTOMER", { status: RideStatus.COMPLETED, completedAt: ended(29) }, 30, now)).toBe(true);
    expect(sosAllowed("DRIVER", { status: RideStatus.CANCELLED, cancelledAt: ended(10) }, 30, now)).toBe(true);
    expect(sosAllowed("CUSTOMER", { status: RideStatus.COMPLETED, completedAt: ended(31) }, 30, now)).toBe(false);
  });
});

describe("SOS lifecycle", () => {
  it("moves forward only, and closed incidents stay closed", () => {
    expect(canTransitionSos(SosStatus.TRIGGERED, SosStatus.ACKNOWLEDGED)).toBe(true);
    expect(canTransitionSos(SosStatus.ACKNOWLEDGED, SosStatus.IN_PROGRESS)).toBe(true);
    expect(canTransitionSos(SosStatus.IN_PROGRESS, SosStatus.RESOLVED)).toBe(true);
    expect(canTransitionSos(SosStatus.TRIGGERED, SosStatus.RESOLVED)).toBe(true);
    expect(canTransitionSos(SosStatus.IN_PROGRESS, SosStatus.ACKNOWLEDGED)).toBe(false);
    expect(canTransitionSos(SosStatus.RESOLVED, SosStatus.IN_PROGRESS)).toBe(false);
    expect(canTransitionSos(SosStatus.CANCELLED, SosStatus.TRIGGERED)).toBe(false);
  });
});

describe("share links", () => {
  it("expire at ride end + grace, never later than their own expiry", () => {
    const expiresAt = new Date("2026-09-25T20:00:00Z");
    expect(effectiveShareExpiry(expiresAt, undefined, 30)).toEqual(expiresAt);
    expect(effectiveShareExpiry(expiresAt, new Date("2026-09-25T10:00:00Z"), 30)).toEqual(
      new Date("2026-09-25T10:30:00Z"),
    );
    expect(effectiveShareExpiry(expiresAt, new Date("2026-09-25T19:50:00Z"), 30)).toEqual(expiresAt);
  });

  it("speak a public status vocabulary, never internal state names", () => {
    expect(publicRideStatus(RideStatus.SEARCHING)).toBe("REQUESTED");
    expect(publicRideStatus(RideStatus.DRIVER_ACCEPTED)).toBe("DRIVER_ARRIVING");
    expect(publicRideStatus(RideStatus.RIDE_STARTED)).toBe("RIDE_IN_PROGRESS");
    expect(publicRideStatus(RideStatus.NO_DRIVER_AVAILABLE)).toBe("CANCELLED");
  });

  it("the page escapes everything and refreshes only while live", () => {
    const view: SharedRideView = {
      status: "RIDE_IN_PROGRESS",
      statusLabel: "Ride in progress",
      statusMessage: "The trip is under way.",
      isLive: true,
      rideType: "AUTO",
      driver: { firstName: "<script>alert(1)</script>" },
      vehicle: { type: "AUTO", registrationNumber: "UP85\"CC" },
      pickup: { address: "Prem Mandir & Co", latitude: 27.57, longitude: 77.67 },
      destination: { address: "Banke Bihari", latitude: 27.58, longitude: 77.7 },
      driverLocation: { latitude: 27.575, longitude: 77.68, updatedAt: new Date() },
      lastUpdatedAt: new Date(),
      expiresAt: new Date(),
    };
    const html = renderSharedRidePage(view, "Asia/Kolkata");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("UP85&quot;CC");
    expect(html).toContain("Prem Mandir &amp; Co");
    expect(html).toContain('http-equiv="refresh"');
    expect(renderSharedRidePage({ ...view, isLive: false }, "Asia/Kolkata")).not.toContain('http-equiv="refresh"');
    expect(renderShareErrorPage(true)).toContain("expired");
  });
});

describe("normalizePhone", () => {
  it.each([
    ["98765 43210", "+919876543210"],
    ["098765-43210", "+919876543210"],
    ["919876543210", "+919876543210"],
    ["+919876543210", "+919876543210"],
    ["00447911123456", "+447911123456"],
    ["12345", "12345"],
  ])("%s → %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });
});
