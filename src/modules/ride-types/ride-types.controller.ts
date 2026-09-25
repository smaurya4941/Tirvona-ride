import { Controller, Get } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { RideTypesService } from "./ride-types.service";
import type { RideTypeSummary } from "./ride-types.service";

@ApiTags("Ride types")
@ApiBearerAuth()
@Controller({ path: "ride-types", version: "1" })
export class RideTypesController {
  constructor(private readonly rideTypes: RideTypesService) {}

  @Get()
  @ApiOperation({ summary: "List bookable ride types" })
  async list(): Promise<ApiSuccessBody<RideTypeSummary[]>> {
    const rideTypes = await this.rideTypes.listActive();
    return ok(rideTypes.map((rideType) => this.rideTypes.toSummary(rideType)));
  }
}
