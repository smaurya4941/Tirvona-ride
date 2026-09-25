import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { PlacesProviderName } from "../../config/environment";
import { PlacesController } from "./places.controller";
import { PlacesService } from "./places.service";
import { DisabledGeocodingProvider, GeocodingProvider } from "./providers/geocoding.provider";
import { GooglePlacesProvider } from "./providers/google-places.provider";
import { NominatimProvider } from "./providers/nominatim.provider";

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
        if (provider === "google") return new GooglePlacesProvider(config);
        if (provider === "nominatim") return new NominatimProvider(config);
        return new DisabledGeocodingProvider();
      },
    },
    PlacesService,
  ],
  exports: [PlacesService],
})
export class PlacesModule {}
