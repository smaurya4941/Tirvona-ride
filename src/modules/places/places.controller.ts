import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import type { GeoCoordinates } from "../locations/geo";
import {
  AutocompleteQueryDto,
  PopularPlacesQueryDto,
  ResolvePlaceQueryDto,
  ReverseGeocodeQueryDto,
} from "./dto/places-query.dto";
import { OtherSavedPlaceDto, SavePlaceDto, UpdateOtherSavedPlaceDto } from "./dto/saved-place.dto";
import type { AutocompleteResult, PlaceSuggestion, ResolvedPlace, ReverseGeocodedPlace } from "./places.types";
import { PlacesService } from "./places.service";
import { PopularPlacesService } from "./popular-places.service";
import { SavedPlacesService } from "./saved-places.service";
import type { SavedPlacesView } from "./saved-places.service";
import { SavedPlaceKind } from "./schemas/saved-place.schema";
import type { FixedSavedPlaceKind } from "./schemas/saved-place.schema";

/** :kind of the Home/Work routes — "other" places have their own routes. */
const FixedKindParam = { HOME: SavedPlaceKind.HOME, WORK: SavedPlaceKind.WORK } as const;

const nearFrom = (query: { latitude?: number; longitude?: number }): GeoCoordinates | undefined =>
  query.latitude !== undefined && query.longitude !== undefined
    ? { latitude: query.latitude, longitude: query.longitude }
    : undefined;

@ApiTags("Places")
@ApiBearerAuth()
@Roles(UserRole.CUSTOMER, UserRole.DRIVER)
@Controller({ path: "places", version: "1" })
export class PlacesController {
  constructor(
    private readonly places: PlacesService,
    private readonly popularPlaces: PopularPlacesService,
    private readonly savedPlaces: SavedPlacesService,
  ) {}

  @Get("autocomplete")
  // The app debounces keystrokes; this still allows brisk typing.
  @Throttle({ default: { limit: 90, ttl: 60_000 } })
  @ApiOperation({ summary: "Search places as the rider types (curated Braj landmarks first when the rider is in Braj)" })
  async autocomplete(@Query() query: AutocompleteQueryDto): Promise<ApiSuccessBody<AutocompleteResult>> {
    return ok(
      await this.places.autocomplete({
        query: query.q,
        near: nearFrom(query),
        sessionToken: query.sessionToken,
        limit: query.limit ?? 8,
      }),
    );
  }

  @Get("resolve")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: "Coordinates and booking address for a tapped suggestion" })
  async resolve(@Query() query: ResolvePlaceQueryDto): Promise<ApiSuccessBody<ResolvedPlace>> {
    return ok(await this.places.resolve(query.id, query.sessionToken));
  }

  @Get("reverse")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: "Name the place at a coordinate (current location, a pin on the map)",
    description: "Always answers: when no provider can name the spot, `approximate` is true and the address is a coordinate label.",
  })
  async reverse(@Query() query: ReverseGeocodeQueryDto): Promise<ApiSuccessBody<ReverseGeocodedPlace>> {
    return ok(await this.places.reverse({ latitude: query.latitude, longitude: query.longitude }));
  }

  @Get("popular")
  @ApiOperation({
    summary: "Admin-curated popular destinations near the rider, nearest first",
    description: "Empty when the rider is farther than PLACES_FEATURED_RADIUS_KM from every active place.",
  })
  async popular(@Query() query: PopularPlacesQueryDto): Promise<ApiSuccessBody<PlaceSuggestion[]>> {
    return ok(await this.popularPlaces.forRider(nearFrom(query), query.limit ?? 8));
  }

  /**
   * Public like the branding images: the app renders it with a plain image
   * request (no auth header), and it only ever serves what an admin published.
   */
  @Get("popular/:id/image")
  @Public()
  @ApiOperation({ summary: "Photo of a popular place. Immutable-cached when `v` matches the current version" })
  async popularImage(
    @Param("id") id: string,
    @Query("v") requestedVersion: string | undefined,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile | undefined> {
    const file = await this.popularPlaces.imageFile(id);
    const etag = `"${file.version}"`;
    response.setHeader("ETag", etag);
    response.setHeader(
      "Cache-Control",
      requestedVersion === file.version ? "public, max-age=31536000, immutable" : "public, max-age=60",
    );
    response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    if (ifNoneMatch === etag) {
      response.status(304);
      return undefined;
    }
    return new StreamableFile(file.data, { type: file.contentType, length: file.data.length });
  }

  // ── Saved places (Home, Work and the rider's own) ──────────────────────

  @Get("saved")
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: "The rider's saved Home and Work (null = not set) and their other saved places" })
  async saved(@CurrentUser() user: AuthenticatedUser): Promise<ApiSuccessBody<SavedPlacesView>> {
    return ok(await this.savedPlaces.forUser(user.userId));
  }

  @Put("saved/:kind")
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: "Set or replace the rider's Home or Work address" })
  async save(
    @CurrentUser() user: AuthenticatedUser,
    @Param("kind", new ParseEnumPipe(FixedKindParam)) kind: FixedSavedPlaceKind,
    @Body() dto: SavePlaceDto,
  ): Promise<ApiSuccessBody<SavedPlacesView>> {
    return ok(await this.savedPlaces.save(user.userId, kind, dto));
  }

  @Delete("saved/:kind")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: "Forget the rider's Home or Work address" })
  async clearSaved(
    @CurrentUser() user: AuthenticatedUser,
    @Param("kind", new ParseEnumPipe(FixedKindParam)) kind: FixedSavedPlaceKind,
  ): Promise<ApiSuccessBody<SavedPlacesView>> {
    return ok(await this.savedPlaces.clear(user.userId, kind));
  }

  @Post("saved/others")
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: "Save a labelled place of the rider's own (\"Gym\", \"Mom's house\")" })
  async addOther(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: OtherSavedPlaceDto,
  ): Promise<ApiSuccessBody<SavedPlacesView>> {
    return ok(await this.savedPlaces.addOther(user.userId, dto));
  }

  @Patch("saved/others/:id")
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: "Rename or move one of the rider's saved places" })
  async updateOther(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: UpdateOtherSavedPlaceDto,
  ): Promise<ApiSuccessBody<SavedPlacesView>> {
    return ok(await this.savedPlaces.updateOther(user.userId, id, dto));
  }

  @Delete("saved/others/:id")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: "Remove one of the rider's saved places" })
  async removeOther(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ): Promise<ApiSuccessBody<SavedPlacesView>> {
    return ok(await this.savedPlaces.removeOther(user.userId, id));
  }
}
