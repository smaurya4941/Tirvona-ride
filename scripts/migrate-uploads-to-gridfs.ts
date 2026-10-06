/**
 * Moves files saved on the server's disk (`uploads/`) and photos stored inline
 * in `profile_images` into the active file storage (GridFS). Safe to repeat.
 *
 * Usage: npm run storage:migrate            (does it)
 *        npm run storage:migrate -- --dry-run   (only counts)
 *
 * Run it where the old `uploads/` folder is (it uses the current directory).
 * Documents whose file is gone from disk are reported as "missing": ask those
 * drivers to upload again.
 */
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { LegacyUploadsMigrator } from "../src/modules/storage/legacy-uploads-migrator";

async function run(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
  try {
    const report = await app.get(LegacyUploadsMigrator).run({ dryRun });
    console.log(`${dryRun ? "[dry run] " : ""}scanned ${report.scanned}, migrated ${report.migrated}, missing ${report.missing}, skipped ${report.skipped}`);
    if (report.missing > 0) process.exitCode = 2;
  } finally {
    await app.close();
  }
}

void run();
