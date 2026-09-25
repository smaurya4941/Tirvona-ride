import { ValidationPipe, VersioningType } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import compression from "compression";
import type { Express } from "express";
import helmet from "helmet";
import { ApiExceptionFilter } from "./common/filters/api-exception.filter";
import { requestIdMiddleware } from "./common/middleware/request-id.middleware";
import { RealtimeIoAdapter } from "./modules/realtime/realtime-io.adapter";

export const API_PREFIX = "api";
export const API_DEFAULT_VERSION = "1";

// Shared by main.ts and the e2e suite so tests exercise the real HTTP surface.
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService);

  app.use(requestIdMiddleware);
  app.use(helmet());
  app.use(compression());
  if (config.get<boolean>("trustProxy"))
    (app.getHttpAdapter().getInstance() as Express).set("trust proxy", 1);

  app.setGlobalPrefix(API_PREFIX);
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: API_DEFAULT_VERSION,
  });
  app.enableCors({
    origin: config.getOrThrow<string[]>("corsOrigins"),
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Request-Id"],
    exposedHeaders: ["X-Request-Id"],
    maxAge: 86_400,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new ApiExceptionFilter());
  // Socket.IO on the same HTTP server (namespace /realtime).
  app.useWebSocketAdapter(new RealtimeIoAdapter(app));
  app.enableShutdownHooks();

  if (config.get<boolean>("swaggerEnabled")) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle("Tirvona Rides API")
        .setDescription("Customer, driver and admin APIs for Tirvona Rides")
        .setVersion(API_DEFAULT_VERSION)
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup(`${API_PREFIX}/docs`, app, document);
  }
}
