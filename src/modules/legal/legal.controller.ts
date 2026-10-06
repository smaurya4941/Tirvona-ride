import { Controller, Get, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { Public } from "../../common/decorators/public.decorator";
import { renderDeleteAccount, renderPrivacyPolicy, renderTerms } from "./legal-pages";
import type { LegalContext } from "./legal-pages";

/**
 * The privacy policy, terms and account-deletion pages that Google Play and
 * the app link to. Public, static, cacheable. The one web surface besides the
 * share-ride page: Play requires these as URLs.
 */
@ApiTags("Legal")
@Public()
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@Controller({ path: "legal", version: "1" })
export class LegalController {
  private readonly context: LegalContext;

  constructor(config: ConfigService) {
    this.context = {
      entityName: config.getOrThrow<string>("legalEntityName"),
      supportEmail: config.getOrThrow<string>("supportEmail"),
      supportPhone: config.getOrThrow<string>("supportPhone"),
      baseUrl: config.getOrThrow<string>("publicBaseUrl"),
    };
  }

  @Get("privacy")
  @ApiOperation({ summary: "Privacy policy (HTML)" })
  privacy(@Res({ passthrough: true }) response: Response): string {
    return this.html(response, renderPrivacyPolicy(this.context));
  }

  @Get("terms")
  @ApiOperation({ summary: "Terms of use (HTML)" })
  terms(@Res({ passthrough: true }) response: Response): string {
    return this.html(response, renderTerms(this.context));
  }

  @Get("delete-account")
  @ApiOperation({ summary: "How to delete an account (HTML)" })
  deleteAccount(@Res({ passthrough: true }) response: Response): string {
    return this.html(response, renderDeleteAccount(this.context));
  }

  private html(response: Response, body: string): string {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Cache-Control", "public, max-age=3600");
    return body;
  }
}
