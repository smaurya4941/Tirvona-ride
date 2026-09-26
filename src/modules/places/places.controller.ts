import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Roles } from "../../common/decorators/roles.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { UserRole } from "../../common/types/user-role.enum";
import type { GeoCoordinates } from "../locations/geo";
import {
  AutocompleteQueryDto,
  PopularPlacesQueryDto,
  ResolvePlaceQueryDto,
  ReverseGeocodeQueryDto,
} from "./dto/places-query.dto";
import type { AutocompleteResult, PlaceSuggestion, ResolvedPlace, ReverseGeocodedPlace } from "./places.types";
import { PlacesService } from "./places.service";

const nearFrom = (query: { latitude?: number; longitude?: number }): GeoCoordinates | undefined =>
  query.latitude !== undefined && query.longitude !== undefined
    ? { latitude: query.latitude, longitude: query.longitude }
    : undefined;

@ApiTags("Places")
@ApiBearerAuth()
@Roles(UserRole.CUSTOMER, UserRole.DRIVER)
@Controller({ path: "places", version: "1" })
export class PlacesController {
  constructor(private readonly places: PlacesService) {}

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
  @ApiOperation({ summary: "Popular pilgrimage places, nearest first when a position is given" })
  popular(@Query() query: PopularPlacesQueryDto): ApiSuccessBody<PlaceSuggestion[]> {
    return ok(this.places.popular(nearFrom(query), query.limit ?? 8));
  }
}
