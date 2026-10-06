import {
  Controller,
  Get,
  Headers,
  Param,
  Query,
  Res,
  StreamableFile,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { Public } from "../../common/decorators/public.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { ParseObjectIdPipe } from "../../common/pipes/parse-object-id.pipe";
import { UserRole } from "../../common/types/user-role.enum";
import { CircuitPackagesService } from "./circuit-packages.service";
import type { CircuitPackageCustomerView } from "./circuit-packages.service";
import { ListCircuitPackagesQueryDto } from "./dto/circuit-package.dto";

/** What customers browse: only ACTIVE packages, priced and described by the server. */
@ApiTags("Circuits")
@ApiBearerAuth()
@Controller({ path: "circuit-packages", version: "1" })
export class CircuitPackagesController {
  constructor(private readonly packages: CircuitPackagesService) {}

  @Get()
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({
    summary: "Circuit packages customers can book (optionally one city)",
  })
  async list(
    @Query() query: ListCircuitPackagesQueryDto,
  ): Promise<ApiSuccessBody<CircuitPackageCustomerView[]>> {
    return ok(await this.packages.listForCustomers(query.city));
  }

  @Get(":id")
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({
    summary:
      "One circuit package: stops, price, extra charges, vehicles, availability",
  })
  async findOne(
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<CircuitPackageCustomerView>> {
    return ok(await this.packages.getForCustomer(id));
  }

  /** Public like the other brand/marketing images: the app loads it with a plain image request. */
  @Get(":id/cover")
  @Public()
  @ApiOperation({
    summary:
      "Cover image. Immutable-cached when `v` matches the current version",
  })
  async cover(
    @Param("id") id: string,
    @Query("v") requestedVersion: string | undefined,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile | undefined> {
    const file = await this.packages.coverFile(id);
    const etag = `"${file.version}"`;
    response.setHeader("ETag", etag);
    response.setHeader(
      "Cache-Control",
      requestedVersion === file.version
        ? "public, max-age=31536000, immutable"
        : "public, max-age=60",
    );
    response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    if (ifNoneMatch === etag) {
      response.status(304);
      return undefined;
    }
    return new StreamableFile(file.data, {
      type: file.contentType,
      length: file.data.length,
    });
  }
}
