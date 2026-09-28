import { Logger, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { PlacesFallbackName, PlacesProviderName } from "../../config/environment";
import { PlacesController } from "./places.controller";
import { PlacesService } from "./places.service";
import { FallbackGeocodingProvider } from "./providers/fallback.provider";
import { DisabledGeocodingProvider, GeocodingProvider } from "./providers/geocoding.provider";
import { GooglePlacesProvider } from "./providers/google-places.provider";
import { NominatimProvider } from "./providers/nominatim.provider";
import { PhotonProvider } from "./providers/photon.provider";

// Leaf module (config only). Rides still validate every booked point
// themselves; places only helps the rider find one.
@Module({
  controllers: [PlacesController],
  providers: [
    {
      provide: GeocodingProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService): GeocodingProvider => {
        const provider = config.getOrThrow<PlacesProviderName>("placesProvider");
        // Photon for search-as-you-type; Nominatim covers its outages and
        // resolves osm: ids (Photon has no lookup endpoint).
        const osm = () => new FallbackGeocodingProvider(new PhotonProvider(config), new NominatimProvider(config));
        const logger = new Logger(PlacesModule.name);
        if (provider === "google") {
          const google = new GooglePlacesProvider(config);
          if (config.getOrThrow<PlacesFallbackName>("placesFallback") === "none") {
            logger.log("Place search: Google Places (no fallback)");
            return google;
          }
          logger.log("Place search: Google Places with OpenStreetMap fallback");
          return new FallbackGeocodingProvider(google, osm(), {
            failureThreshold: config.getOrThrow<number>("placesFailureThreshold"),
            cooldownMs: config.getOrThrow<number>("placesFailureCooldownSeconds") * 1000,
          });
        }
        logger.log(`Place search: ${provider}`);
        if (provider === "osm") return osm();
        if (provider === "photon") return new PhotonProvider(config);
        if (provider === "nominatim") return new NominatimProvider(config);
        return new DisabledGeocodingProvider();
      },
    },
    PlacesService,
  ],
  exports: [PlacesService],
})
export class PlacesModule {}
