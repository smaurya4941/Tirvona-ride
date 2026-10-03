import { NotificationType, PUSH_CHANNEL_IDS, PushSound, pushSoundFor } from "./notification-types";

describe("pushSoundFor", () => {
  it("rings loudly for a ride offer, sirens for SOS and chimes for the rest", () => {
    expect(pushSoundFor(NotificationType.RIDE_REQUEST)).toBe(PushSound.RIDE_REQUEST);
    expect(pushSoundFor(NotificationType.SOS_CREATED)).toBe(PushSound.SOS_ALERT);
    expect(pushSoundFor(NotificationType.SOS_UPDATED)).toBe(PushSound.SOS_ALERT);
    for (const type of Object.values(NotificationType).filter(
      (value) =>
        ![NotificationType.RIDE_REQUEST, NotificationType.SOS_CREATED, NotificationType.SOS_UPDATED].includes(value),
    ))
      expect(pushSoundFor(type)).toBe(PushSound.RIDE_UPDATE);
  });

  it("gives every sound its own Android channel", () => {
    const ids = Object.values(PUSH_CHANNEL_IDS);
    expect(new Set(ids).size).toBe(Object.values(PushSound).length);
  });
});
