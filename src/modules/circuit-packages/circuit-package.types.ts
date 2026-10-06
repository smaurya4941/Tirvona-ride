/** What Admin sells. Only ACTIVE packages are visible to (and bookable by) customers. */
export enum CircuitPackageStatus {
  DRAFT = "DRAFT",
  ACTIVE = "ACTIVE",
  INACTIVE = "INACTIVE",
  ARCHIVED = "ARCHIVED",
}

/** Legal status moves. ARCHIVED is final; a package that was ever used is archived, never deleted. */
export const PACKAGE_STATUS_TRANSITIONS: Readonly<
  Record<CircuitPackageStatus, readonly CircuitPackageStatus[]>
> = {
  [CircuitPackageStatus.DRAFT]: [
    CircuitPackageStatus.ACTIVE,
    CircuitPackageStatus.ARCHIVED,
  ],
  [CircuitPackageStatus.ACTIVE]: [
    CircuitPackageStatus.INACTIVE,
    CircuitPackageStatus.ARCHIVED,
  ],
  [CircuitPackageStatus.INACTIVE]: [
    CircuitPackageStatus.ACTIVE,
    CircuitPackageStatus.ARCHIVED,
  ],
  [CircuitPackageStatus.ARCHIVED]: [],
};

/** 0 = Monday … 6 = Sunday, the order the admin screens list them in. */
export const OPERATING_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;
export type OperatingDay = (typeof OPERATING_DAYS)[number];

export const MIN_STOPS = 2;
export const MAX_STOPS = 12;
export const MAX_PASSENGERS = 8;
