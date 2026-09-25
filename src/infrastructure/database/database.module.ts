import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MongooseModule } from "@nestjs/mongoose";

@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>("mongoUri"),
        dbName: config.getOrThrow<string>("mongoDbName"),
        appName: config.get<string>("serviceName"),
        // Index builds on large collections lock writes; production indexes
        // are created by an explicit migration step instead.
        autoIndex: config.get<string>("nodeEnv") !== "production",
        minPoolSize: config.get<number>("mongoMinPoolSize"),
        maxPoolSize: config.get<number>("mongoMaxPoolSize"),
        serverSelectionTimeoutMS: config.get<number>(
          "mongoServerSelectionTimeoutMs",
        ),
        socketTimeoutMS: config.get<number>("mongoSocketTimeoutMs"),
        retryAttempts: 3,
        retryDelay: 2_000,
      }),
    }),
  ],
})
export class DatabaseModule {}
