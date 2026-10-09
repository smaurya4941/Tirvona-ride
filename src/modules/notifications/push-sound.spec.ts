import { UserRole } from "../../common/types/user-role.enum";
import {
  NotificationType,
  PUSH_CHANNEL_IDS,
  PushSound,
  pushSoundFor,
} from "./notification-types";

describe("pushSoundFor", () => {
  it("rings loudly for a ride offer, sirens SOS for the safety team only and chimes for the rest", () => {
    expect(pushSoundFor(NotificationType.RIDE_REQUEST)).toBe(
      PushSound.RIDE_REQUEST,
    );
    for (const type of [
      NotificationType.SOS_CREATED,
      NotificationType.SOS_UPDATED,
    ]) {
      expect(pushSoundFor(type, UserRole.ADMIN)).toBe(PushSound.SOS_ALERT);
      // The person who pressed SOS must not be given away by a siren.
      expect(pushSoundFor(type, UserRole.CUSTOMER)).toBe(PushSound.SILENT);
      expect(pushSoundFor(type, UserRole.DRIVER)).toBe(PushSound.SILENT);
      expect(pushSoundFor(type)).toBe(PushSound.SILENT);
    }
    for (const type of Object.values(NotificationType).filter(
      (value) =>
        ![
          NotificationType.RIDE_REQUEST,
          NotificationType.SOS_CREATED,
          NotificationType.SOS_UPDATED,
        ].includes(value),
    ))
      expect(pushSoundFor(type)).toBe(PushSound.RIDE_UPDATE);
  });

  it("gives every sound its own Android channel", () => {
    const ids = Object.values(PUSH_CHANNEL_IDS);
    expect(new Set(ids).size).toBe(Object.values(PushSound).length);
  });
});
