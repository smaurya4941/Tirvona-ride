import {
  Controller,
  Get,
  Header,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { Public } from "../../../common/decorators/public.decorator";
import { ok } from "../../../common/http/api-response";
import type { ApiSuccessBody } from "../../../common/http/api-response";
import { HealthService } from "../application/health.service";
import type { HealthReport } from "../application/health.service";

@ApiTags("Health")
@SkipThrottle()
@Public()
@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get("live")
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Liveness probe — the process is up" })
  live(): ApiSuccessBody<ReturnType<HealthService["liveness"]>> {
    return ok(this.health.liveness());
  }

  @Get()
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Readiness probe — MongoDB and Redis reachable" })
  async ready(): Promise<ApiSuccessBody<HealthReport>> {
    const report = await this.health.readiness();
    if (report.status !== "ready")
      throw new ServiceUnavailableException({
        message: "Service dependencies are not ready",
        code: "DEPENDENCIES_UNAVAILABLE",
        data: report,
      });
    return ok(report);
  }
}
