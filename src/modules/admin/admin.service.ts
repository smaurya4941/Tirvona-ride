import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { startOfDayInTimeZone } from "../../common/utils/time";
import { ComplaintsService } from "../complaints/complaints.service";
import type { ComplaintSummary } from "../complaints/complaints.service";
import { SosService } from "../safety/sos.service";
import type { SosSummary } from "../safety/sos.service";
import { DomainEventsService } from "../../infrastructure/events/domain-events.service";
import { DriversService } from "../drivers/drivers.service";
import type { DriverSummary } from "../drivers/drivers.service";
import { DriverStatus } from "../drivers/schemas/driver-profile.schema";
import { UsersService } from "../users/users.service";
import type { UserSummary } from "../users/users.service";
import { VehiclesService } from "../vehicles/vehicles.service";
import type { VehicleSummary } from "../vehicles/vehicles.service";
import { RidesAdminService } from "../rides/rides-admin.service";
import type { AdminRideStats } from "../rides/rides-admin.service";

export interface DashboardReport {
  pendingDrivers: number;
  underReviewDrivers: number;
  approvedDrivers: number;
  rejectedDrivers: number;
  suspendedDrivers: number;
  totalDrivers: number;
  rides: AdminRideStats;
  /** Phase 5: the dashboard's safety and support cards. */
  safety: SosSummary;
  support: ComplaintSummary;
}

export interface DriverListItem {
  driver: DriverSummary;
  user: Pick<UserSummary, "id" | "firstName" | "lastName" | "phone" | "email">;
}

export interface DriverDetail {
  driver: DriverSummary;
  user: UserSummary;
  // No filePath: server paths stay server-side. The panel fetches file bytes
  // through the /admin/.../file endpoints by document id.
  documents: Array<{
    id: string;
    documentType: string;
    documentNumber?: string;
    status: string;
    rejectionReason?: string;
  }>;
  vehicles: Array<{
    vehicle: VehicleSummary;
    documents: Array<{
      id: string;
      documentType: string;
      documentNumber?: string;
      status: string;
    }>;
  }>;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly users: UsersService,
    private readonly drivers: DriversService,
    private readonly vehicles: VehiclesService,
    private readonly rides: RidesAdminService,
    private readonly domainEvents: DomainEventsService,
    private readonly sos: SosService,
    private readonly complaints: ComplaintsService,
    private readonly config: ConfigService,
  ) {}

  async dashboard(): Promise<DashboardReport> {
    const [counts, rides, safety, support] = await Promise.all([
      this.drivers.countByStatus(),
      this.rides.stats(),
      this.sos.summary(),
      this.complaints.summary(startOfDayInTimeZone(new Date(), this.config.getOrThrow<string>("appTimeZone"))),
    ]);
    return {
      rides,
      safety,
      support,
      pendingDrivers: counts[DriverStatus.PENDING],
      underReviewDrivers: counts[DriverStatus.UNDER_REVIEW],
      approvedDrivers: counts[DriverStatus.APPROVED],
      rejectedDrivers: counts[DriverStatus.REJECTED],
      suspendedDrivers: counts[DriverStatus.SUSPENDED],
      totalDrivers: Object.values(counts).reduce((sum, value) => sum + value, 0),
    };
  }

  async listDrivers(status?: DriverStatus): Promise<DriverListItem[]> {
    const drivers = await this.drivers.listForAdmin(status);
    return Promise.all(
      drivers.map(async (driver) => {
        const user = await this.users.findById(driver.userId.toString());
        const summary = this.users.toSummary(user);
        return {
          driver: this.drivers.toSummary(driver),
          user: {
            id: summary.id,
            firstName: summary.firstName,
            lastName: summary.lastName,
            phone: summary.phone,
            email: summary.email,
          },
        };
      }),
    );
  }

  async getDriverDetail(driverId: string): Promise<DriverDetail> {
    const driver = await this.drivers.getById(driverId);
    const [user, documents, vehicles] = await Promise.all([
      this.users.findById(driver.userId.toString()),
      this.drivers.listDocuments(driver.userId.toString()),
      this.vehicles.listByDriverId(driver._id.toString()),
    ]);

    const vehiclesWithDocuments = await Promise.all(
      vehicles.map(async (vehicle) => ({
        vehicle: this.vehicles.toSummary(vehicle),
        documents: (
          await this.vehicles.listDocumentsByVehicleId(vehicle._id.toString())
        ).map((document) => ({
          id: document._id.toString(),
          documentType: document.documentType,
          documentNumber: document.documentNumber,
          status: document.status,
        })),
      })),
    );

    return {
      driver: this.drivers.toSummary(driver),
      user: this.users.toSummary(user),
      documents: documents.map((document) => ({
        id: document._id.toString(),
        documentType: document.documentType,
        documentNumber: document.documentNumber,
        status: document.status,
        rejectionReason: document.rejectionReason,
      })),
      vehicles: vehiclesWithDocuments,
    };
  }

  async approveDriver(driverId: string, adminUserId: string): Promise<DriverSummary> {
    const driver = await this.drivers.approve(driverId, adminUserId);
    this.domainEvents.emit("driver.reviewed", {
      driverId: driver._id.toString(),
      userId: driver.userId.toString(),
      approved: true,
    });
    return this.drivers.toSummary(driver);
  }

  async rejectDriver(driverId: string, reason: string): Promise<DriverSummary> {
    const driver = await this.drivers.reject(driverId, reason);
    this.domainEvents.emit("driver.reviewed", {
      driverId: driver._id.toString(),
      userId: driver.userId.toString(),
      approved: false,
      reason,
    });
    return this.drivers.toSummary(driver);
  }

  async getDriverDocumentFile(driverId: string, documentId: string) {
    return this.drivers.getDocumentOfDriver(driverId, documentId);
  }

  async getVehicleDocumentFile(documentId: string) {
    return this.vehicles.getDocumentById(documentId);
  }
}
