import {
  MAX_PASSENGERS,
  MAX_STOPS,
  MIN_STOPS,
  OPERATING_DAYS,
} from "./circuit-package.types";
import {
  TIME_OF_DAY_PATTERN,
  minuteOfDay,
  parseTimeOfDay,
} from "../pricing/peak-pricing";

/**
 * Pure rules for circuit packages: when one can be booked, whether Admin may
 * publish it, and how many people a vehicle may carry. Unit-tested without a
 * database; the services only apply them.
 */

export interface AvailabilityRule {
  days: readonly number[];
  opensAt: string;
  closesAt: string;
  validFrom?: string;
  validUntil?: string;
}

export interface PublishableStop {
  order: number;
  placeId?: string;
  name?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
}

/** What one vehicle costs on a circuit. */
export interface VehiclePriceRule {
  rideType: string;
  basePrice: number;
  extraDistanceRatePerKm: number;
  extraDurationRatePerHour: number;
}

export interface PublishablePackage {
  name?: string;
  city?: string;
  stops: readonly PublishableStop[];
  /** Included distance and time, shared by every vehicle. */
  pricing?: {
    includedDistanceMeters: number;
    includedDurationSeconds: number;
  };
  rideTypes: readonly string[];
  vehiclePricing: readonly VehiclePriceRule[];
  maxPassengers: number;
  availability: AvailabilityRule;
}

export interface PublishProblem {
  field: string;
  message: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-MM-DD" of `at` on the business calendar. */
export function localDate(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** 0 = Monday … 6 = Sunday on the business calendar. */
export function localWeekday(at: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(at);
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(name);
}

export type AvailabilityVerdict =
  | { open: true }
  | {
      open: false;
      reason: "OUT_OF_SEASON" | "CLOSED_TODAY" | "OUTSIDE_HOURS";
      message: string;
    };

/** Whether a booking started `at` is inside the package's season, weekday and hours. */
export function checkAvailability(
  rule: AvailabilityRule,
  at: Date,
  timeZone: string,
): AvailabilityVerdict {
  const date = localDate(at, timeZone);
  if (
    (rule.validFrom && date < rule.validFrom) ||
    (rule.validUntil && date > rule.validUntil)
  )
    return {
      open: false,
      reason: "OUT_OF_SEASON",
      message: "This circuit is not available on today's date",
    };
  if (!rule.days.includes(localWeekday(at, timeZone)))
    return {
      open: false,
      reason: "CLOSED_TODAY",
      message: "This circuit does not run today",
    };
  const minute = minuteOfDay(at, timeZone);
  const opens = parseTimeOfDay(rule.opensAt);
  const closes = parseTimeOfDay(rule.closesAt);
  const inside =
    opens < closes
      ? minute >= opens && minute < closes
      : minute >= opens || minute < closes;
  if (!inside)
    return {
      open: false,
      reason: "OUTSIDE_HOURS",
      message: `This circuit can be booked between ${rule.opensAt} and ${rule.closesAt}`,
    };
  return { open: true };
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Everything wrong with a package that is about to go DRAFT → ACTIVE (empty = publishable). */
export function publishProblems(
  pkg: PublishablePackage,
  knownRideTypes: ReadonlyMap<string, { seatCapacity: number }>,
): PublishProblem[] {
  const problems: PublishProblem[] = [];
  const add = (field: string, message: string): void =>
    void problems.push({ field, message });

  if (!pkg.name?.trim()) add("name", "Package name is required");
  if (!pkg.city?.trim()) add("city", "City is required");

  if (pkg.stops.length < MIN_STOPS)
    add("stops", `A circuit needs at least ${MIN_STOPS} stops`);
  if (pkg.stops.length > MAX_STOPS)
    add("stops", `A circuit can have at most ${MAX_STOPS} stops`);
  pkg.stops.forEach((stop, index) => {
    const label = `Stop ${index + 1}`;
    if (stop.order !== index + 1) add("stops", `${label} is out of order`);
    if (!stop.placeId?.trim())
      add(
        "stops",
        `${label} must be picked from the places search (no place id)`,
      );
    if (!stop.name?.trim()) add("stops", `${label} has no name`);
    if (!isFiniteNumber(stop.latitude) || !isFiniteNumber(stop.longitude))
      add("stops", `${label} has no coordinates`);
  });
  const ids = pkg.stops.map((stop) => stop.placeId).filter(Boolean);
  if (new Set(ids).size !== ids.length)
    add("stops", "The same place appears twice");

  const { pricing } = pkg;
  if (!pricing) {
    add("pricing", "Included distance and duration are required");
  } else {
    if (!(pricing.includedDistanceMeters > 0))
      add(
        "pricing.includedDistance",
        "Included distance must be greater than 0",
      );
    if (!(pricing.includedDurationSeconds > 0))
      add(
        "pricing.includedDuration",
        "Included duration must be greater than 0",
      );
  }

  if (pkg.rideTypes.length === 0)
    add("rideTypes", "Choose at least one vehicle type");
  for (const code of pkg.rideTypes)
    if (!knownRideTypes.has(code))
      add("rideTypes", `${code} is not a ride type`);
  problems.push(...vehiclePricingProblems(pkg.rideTypes, pkg.vehiclePricing));
  if (
    !Number.isInteger(pkg.maxPassengers) ||
    pkg.maxPassengers < 1 ||
    pkg.maxPassengers > MAX_PASSENGERS
  )
    add(
      "maxPassengers",
      `Passenger limit must be between 1 and ${MAX_PASSENGERS}`,
    );

  const { availability } = pkg;
  if (availability.days.length === 0)
    add("availability.days", "Choose at least one operating day");
  if (
    availability.days.some(
      (day) => !(OPERATING_DAYS as readonly number[]).includes(day),
    )
  )
    add("availability.days", "Operating days must be 0 (Monday) to 6 (Sunday)");
  if (
    !TIME_OF_DAY_PATTERN.test(availability.opensAt) ||
    !TIME_OF_DAY_PATTERN.test(availability.closesAt)
  )
    add("availability.hours", "Operating hours must be HH:mm");
  else if (availability.opensAt === availability.closesAt)
    add("availability.hours", "Opening and closing time cannot be the same");
  for (const [field, value] of [
    ["availability.validFrom", availability.validFrom],
    ["availability.validUntil", availability.validUntil],
  ] as const)
    if (value && !DATE_PATTERN.test(value))
      add(field, "Dates must be YYYY-MM-DD");
  if (
    availability.validFrom &&
    availability.validUntil &&
    availability.validFrom > availability.validUntil
  )
    add("availability.validUntil", "Valid until cannot be before valid from");

  return problems;
}

/**
 * Every allowed vehicle needs exactly one valid price, and no price may exist
 * for a vehicle that is not allowed.
 */
export function vehiclePricingProblems(
  rideTypes: readonly string[],
  prices: readonly VehiclePriceRule[],
): PublishProblem[] {
  const problems: PublishProblem[] = [];
  const add = (field: string, message: string): void =>
    void problems.push({ field, message });
  const seen = new Set<string>();
  for (const price of prices) {
    if (seen.has(price.rideType))
      add("vehiclePricing", `${price.rideType} is priced twice`);
    seen.add(price.rideType);
    if (!rideTypes.includes(price.rideType))
      add(
        "vehiclePricing",
        `${price.rideType} is priced but not an allowed vehicle`,
      );
  }
  for (const code of rideTypes) {
    const price = prices.find((entry) => entry.rideType === code);
    if (!price) {
      add("vehiclePricing", `Set a price for ${code}`);
      continue;
    }
    if (!(price.basePrice > 0))
      add(
        "vehiclePricing.basePrice",
        `${code}: package price must be greater than 0`,
      );
    if (!(price.extraDistanceRatePerKm >= 0))
      add(
        "vehiclePricing.extraDistanceRate",
        `${code}: extra distance rate cannot be negative`,
      );
    if (!(price.extraDurationRatePerHour >= 0))
      add(
        "vehiclePricing.extraDurationRate",
        `${code}: extra duration rate cannot be negative`,
      );
  }
  return problems;
}

/** The full tariff a customer is quoted for one vehicle, or undefined when it is not priced. */
export function tariffFor(
  pkg: Pick<PublishablePackage, "pricing" | "vehiclePricing">,
  rideType: string,
):
  | (VehiclePriceRule & {
      includedDistanceMeters: number;
      includedDurationSeconds: number;
    })
  | undefined {
  const price = pkg.vehiclePricing.find((entry) => entry.rideType === rideType);
  if (!pkg.pricing || !price) return undefined;
  return {
    rideType,
    basePrice: price.basePrice,
    extraDistanceRatePerKm: price.extraDistanceRatePerKm,
    extraDurationRatePerHour: price.extraDurationRatePerHour,
    includedDistanceMeters: pkg.pricing.includedDistanceMeters,
    includedDurationSeconds: pkg.pricing.includedDurationSeconds,
  };
}

/** Seats the customer may book: the package limit, capped by the chosen vehicle's real capacity. */
export const effectiveCapacity = (
  packageMax: number,
  vehicleSeats: number,
): number => Math.min(packageMax, vehicleSeats);

/**
 * Admin's included distance against the road distance of the stops themselves
 * (the pickup leg is extra and unknown until a customer chooses one).
 */
export function distanceWarning(
  includedDistanceMeters: number,
  stopsDistanceMeters: number,
): string | undefined {
  if (includedDistanceMeters >= stopsDistanceMeters) return undefined;
  return `Included distance (${(includedDistanceMeters / 1000).toFixed(1)} km) is lower than the stops' own route (${(stopsDistanceMeters / 1000).toFixed(1)} km).`;
}
