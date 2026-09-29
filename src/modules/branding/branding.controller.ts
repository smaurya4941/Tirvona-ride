import { Controller, Get, Headers, Param, ParseEnumPipe, Query, Res, StreamableFile } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { Public } from "../../common/decorators/public.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { BrandAssetKind } from "./branding-rules";
import { BrandingService } from "./branding.service";
import type { BrandingView } from "./branding.service";

/**
 * Public on purpose: the apps read branding before anyone signs in (splash,
 * sign-in screen) and the admin panel shows the logo on its login page.
 * Read-only, and it only ever exposes what an admin chose to publish.
 */
@ApiTags("Branding")
@Public()
@Controller({ path: "branding", version: "1" })
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Get()
  @ApiOperation({ summary: "Current logo and splash screen (null = use the app's bundled default)" })
  async current(): Promise<ApiSuccessBody<BrandingView>> {
    return ok(await this.branding.current());
  }

  @Get("assets/:kind")
  @ApiOperation({ summary: "The image bytes. Immutable-cached when `v` matches the current version" })
  async asset(
    @Param("kind", new ParseEnumPipe(BrandAssetKind)) kind: BrandAssetKind,
    @Query("v") requestedVersion: string | undefined,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile | undefined> {
    const file = await this.branding.file(kind);
    const etag = `"${file.version}"`;
    response.setHeader("ETag", etag);
    response.setHeader(
      "Cache-Control",
      requestedVersion === file.version ? "public, max-age=31536000, immutable" : "public, max-age=60",
    );
    // helmet defaults to same-origin; the admin panel on another origin
    // renders these in <img>.
    response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    if (ifNoneMatch === etag) {
      response.status(304);
      return undefined;
    }
    return new StreamableFile(file.data, { type: file.contentType, length: file.data.length });
  }
}
