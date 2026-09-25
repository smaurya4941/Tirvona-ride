import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import type { Server } from "node:http";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { API_DEFAULT_VERSION, API_PREFIX, configureApp } from "./app.setup";

async function bootstrap(): Promise<void> {
  // rawBody: the Razorpay webhook signature is computed over the exact bytes
  // Razorpay sent, not over a re-serialised JSON object.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(Logger));
  configureApp(app);

  const config = app.get(ConfigService);
  const port = config.getOrThrow<number>("port");
  await app.listen(port, config.getOrThrow<string>("host"));

  const server = app.getHttpServer() as Server;
  // Must exceed the upstream proxy's idle timeout to avoid 502s on reuse.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  const base = `http://localhost:${port}/${API_PREFIX}/v${API_DEFAULT_VERSION}`;
  app.get(Logger).log(`Tirvona Rides API ready: ${base}`, "Bootstrap");
  app.get(Logger).log(`Health check: ${base}/health`, "Bootstrap");
  if (config.get<boolean>("swaggerEnabled"))
    app
      .get(Logger)
      .log(`Swagger: http://localhost:${port}/${API_PREFIX}/docs`, "Bootstrap");
}

void bootstrap().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`Tirvona Rides API failed to start: ${message}\n`);
  process.exitCode = 1;
});
