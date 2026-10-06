import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, Types } from "mongoose";
import { maskPhone } from "../../common/phone/phone-number";
import { Ride } from "../rides/schemas/ride.schema";
import type { RideDocument } from "../rides/schemas/ride.schema";
import { User } from "../users/schemas/user.schema";
import {
  WhatsAppDeliveryError,
  WhatsAppGateway,
} from "../whatsapp/whatsapp.gateway";
import type { SosAlertMessage } from "../whatsapp/whatsapp.gateway";
import { SosContactAlert, SosEvent } from "./schemas/sos-event.schema";
import type { SosEventDocument, SosLocation } from "./schemas/sos-event.schema";
import { SosLocationSource } from "./sos-lifecycle";
import { ShareRideService } from "./share-ride.service";

/** What the person who raised the alert sees for each emergency contact. */
export interface SosContactStatus {
  name: string;
  /** SENT: WhatsApp accepted the alert. FAILED: every attempt failed. PENDING: not tried yet. */
  status: "SENT" | "FAILED" | "PENDING";
  /** When the contact last received something (alert or location update). */
  lastSentAt?: Date;
}

/** Kept short: an incident that needs more than this has other problems. */
const MAX_RECORDED_MESSAGES = 60;
const MAX_ATTEMPTS = 3;

const FAILURE_TEXT: Record<WhatsAppDeliveryError["reason"], string> = {
  RECIPIENT_UNAVAILABLE: "Number is not on WhatsApp or cannot receive messages",
  RATE_LIMITED: "WhatsApp is limiting messages right now",
  MISCONFIGURED:
    "WhatsApp alert is not set up correctly (template or credentials)",
  UNAVAILABLE: "WhatsApp could not be reached",
};

const fullName = (
  user?: { firstName?: string; lastName?: string } | null,
): string =>
  user ? [user.firstName, user.lastName].filter(Boolean).join(" ") : "";

/** A contact and which message they are due. */
interface Target {
  contact: SosEventDocument["emergencyContacts"][number];
  kind: "ALERT" | "UPDATE";
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tells a user's emergency contacts, on WhatsApp, that they pressed SOS: a map
 * pin with where they are and a button to a live tracking page. WhatsApp only
 * lets a business start a chat with an approved template, so this sends the
 * templates described in docs/safety/sos-whatsapp.md.
 *
 * It never blocks or fails the SOS itself (the safety team is alerted
 * regardless): the SOS request returns at once, messages go out in the
 * background, and every message's outcome is written to the incident so the
 * safety team can see who was reached and call the rest.
 */
@Injectable()
export class SosContactAlertService {
  private readonly logger = new Logger(SosContactAlertService.name);
  private readonly enabled: boolean;
  private readonly updatesEnabled: boolean;
  private readonly updateMinMs: number;
  private readonly updateMax: number;
  private readonly retryDelayMs: number;
  private readonly timeZone: string;
  /** Sends in flight, so tests and shutdown can wait for them. */
  private readonly pending = new Set<Promise<void>>();
  /** One send round per incident at a time (a re-press must not double-message). */
  private readonly rounds = new Map<string, Promise<void>>();

  constructor(
    @InjectModel(SosEvent.name) private readonly sosModel: Model<SosEvent>,
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly whatsapp: WhatsAppGateway,
    private readonly share: ShareRideService,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>("sosContactAlertsEnabled") ?? true;
    this.updatesEnabled =
      Boolean(config.get<string>("whatsappSosUpdateTemplateName")) ||
      this.whatsapp.provider !== "meta";
    this.updateMinMs =
      (config.get<number>("sosContactUpdateMinSeconds") ?? 120) * 1000;
    this.updateMax = config.get<number>("sosContactUpdateMax") ?? 8;
    this.retryDelayMs = config.get<number>("sosContactRetryDelayMs") ?? 1500;
    this.timeZone = config.get<string>("appTimeZone") ?? "Asia/Kolkata";
  }

  /**
   * Starts messaging the contacts in the background. Safe to call on every SOS
   * press: contacts already alerted get a location update (rate limited and
   * capped), contacts not reached yet get the alert again.
   */
  dispatch(sosId: Types.ObjectId, options: { force?: boolean } = {}): void {
    if (!this.enabled) return;
    const key = sosId.toString();
    const previous = this.rounds.get(key) ?? Promise.resolve();
    const round = previous
      .then(() => this.run(sosId, options.force === true))
      .catch((error: unknown) =>
        this.logger.error(
          `SOS contact alerts for ${key} failed: ${error instanceof Error ? error.stack : String(error)}`,
        ),
      )
      .finally(() => {
        this.pending.delete(round);
        if (this.rounds.get(key) === round) this.rounds.delete(key);
      });
    this.rounds.set(key, round);
    this.pending.add(round);
  }

  /** Resolves when every message started so far has finished (graceful shutdown, tests). */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** Per contact: reached, not reached, or not tried — for the person who pressed SOS. */
  static statusFor(
    sos: Pick<SosEventDocument, "emergencyContacts" | "contactAlerts">,
  ): SosContactStatus[] {
    return sos.emergencyContacts.map((contact) => {
      const mine = sos.contactAlerts.filter(
        (entry) => entry.phone === contact.phone,
      );
      const sent = mine.filter((entry) => entry.status === "SENT");
      const last = mine.at(-1);
      return {
        name: contact.name,
        status: sent.length ? "SENT" : last ? "FAILED" : "PENDING",
        lastSentAt: sent.at(-1)?.at,
      };
    });
  }

  // ── One round ─────────────────────────────────────────────────────────

  private async run(sosId: Types.ObjectId, force: boolean): Promise<void> {
    const sos = await this.sosModel
      .findById(sosId)
      .select("+trackingToken")
      .exec();
    if (!sos || !sos.isOpen || sos.emergencyContacts.length === 0) return;

    const now = Date.now();
    const targets = sos.emergencyContacts.flatMap((contact): Target[] => {
      const mine = sos.contactAlerts.filter(
        (entry) => entry.phone === contact.phone,
      );
      const alerted = mine.some(
        (entry) => entry.kind === "ALERT" && entry.status === "SENT",
      );
      const lastAt = mine.at(-1)?.at.getTime();
      // Anything already tried is rate limited, whatever its outcome.
      if (!force && lastAt !== undefined && now - lastAt < this.updateMinMs)
        return [];
      if (!alerted) return [{ contact, kind: "ALERT" }];
      // A resend by the safety team is only for people the alert has not reached.
      if (force) return [];
      const updates = mine.filter(
        (entry) => entry.kind === "UPDATE" && entry.status === "SENT",
      ).length;
      if (!this.updatesEnabled || updates >= this.updateMax) return [];
      return [{ contact, kind: "UPDATE" }];
    });
    if (targets.length === 0) return;

    const ride = await this.rideModel.findById(sos.rideId).exec();
    if (!ride) return;
    const [raiser, link] = await Promise.all([
      this.userModel
        .findById(sos.userId)
        .select("firstName lastName phone")
        .lean()
        .exec(),
      this.trackingLink(sos, ride),
    ]);
    const fix = sos.locationUpdates.at(-1) ?? sos.location;
    const first = raiser?.firstName || "Your contact";

    const entries = await Promise.all(
      targets.map(async ({ contact, kind }): Promise<SosContactAlert> => {
        const message: SosAlertMessage = {
          to: contact.phone,
          kind,
          personName: fullName(raiser) || "A Tirvona rider",
          personPhone: raiser?.phone ?? "",
          rideCode: sos.rideCode,
          vehicle: this.vehicleText(ride),
          reference: sos.sosCode,
          location: {
            latitude: fix.latitude,
            longitude: fix.longitude,
            name:
              fix.source === SosLocationSource.DEVICE
                ? `${first}'s location`
                : `${first}'s last known location`,
            address: this.addressText(fix),
          },
          trackingToken: link.token,
          trackingUrl: link.url,
        };
        return this.send(contact.name, message);
      }),
    );

    const updated = await this.sosModel
      .findOneAndUpdate(
        { _id: sos._id },
        {
          $push: {
            contactAlerts: { $each: entries, $slice: -MAX_RECORDED_MESSAGES },
          },
        },
        { returnDocument: "after" },
      )
      .exec();
    if (!updated) return;
    const reached = updated.contactAlerts.some(
      (entry) => entry.status === "SENT",
    );
    const next = reached ? "SENT" : "FAILED";
    if (updated.contactsNotification !== next)
      await this.sosModel
        .updateOne({ _id: sos._id }, { $set: { contactsNotification: next } })
        .exec();
    this.logger.warn(
      `SOS ${sos.sosCode}: WhatsApp to emergency contacts: ` +
        entries
          .map(
            (entry) =>
              `${maskPhone(entry.phone)} ${entry.kind} ${entry.status}`,
          )
          .join(", "),
    );
  }

  /** One send with a couple of quick retries for transient failures. Never throws. */
  private async send(
    name: string,
    message: SosAlertMessage,
  ): Promise<SosContactAlert> {
    let failure = FAILURE_TEXT.UNAVAILABLE;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.whatsapp.sendSosAlert(message);
        return {
          phone: message.to,
          name,
          kind: message.kind,
          status: "SENT",
          messageId: result.messageId,
          attempts: attempt,
          at: new Date(),
        };
      } catch (error) {
        const reason =
          error instanceof WhatsAppDeliveryError ? error.reason : "UNAVAILABLE";
        failure = FAILURE_TEXT[reason];
        if (!(error instanceof WhatsAppDeliveryError))
          this.logger.error(`Unexpected SOS WhatsApp error: ${String(error)}`);
        // A wrong number or a broken setup will not get better in a second.
        if (
          reason === "RECIPIENT_UNAVAILABLE" ||
          reason === "MISCONFIGURED" ||
          attempt === MAX_ATTEMPTS
        )
          break;
        await sleep(this.retryDelayMs * attempt);
      }
    }
    return {
      phone: message.to,
      name,
      kind: message.kind,
      status: "FAILED",
      failure,
      attempts: MAX_ATTEMPTS,
      at: new Date(),
    };
  }

  /** The incident's live link, created on first use and kept for follow-ups. */
  private async trackingLink(
    sos: SosEventDocument,
    ride: RideDocument,
  ): Promise<{ token: string; url: string }> {
    if (sos.trackingToken)
      return {
        token: sos.trackingToken,
        url: this.share.linkFor(sos.trackingToken),
      };
    const created = await this.share.createForSos(ride, sos._id);
    await this.sosModel
      .updateOne(
        { _id: sos._id, trackingToken: { $exists: false } },
        { $set: { trackingToken: created.token } },
      )
      .exec();
    return { token: created.token, url: created.url };
  }

  private vehicleText(ride: RideDocument): string {
    if (!ride.vehicle) return "";
    const details = [ride.vehicle.color, ride.vehicle.make, ride.vehicle.model]
      .filter(Boolean)
      .join(" ");
    return [ride.vehicle.registrationNumber, details]
      .filter(Boolean)
      .join(" · ");
  }

  private addressText(location: SosLocation): string {
    if (location.address) return location.address;
    const time = new Intl.DateTimeFormat("en-IN", {
      timeZone: this.timeZone,
      hour: "numeric",
      minute: "2-digit",
    }).format(location.capturedAt);
    return `Position at ${time}`;
  }
}
