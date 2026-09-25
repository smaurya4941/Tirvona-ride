/**
 * Creates an ADMIN user directly in MongoDB. The /auth/register endpoint
 * refuses role=ADMIN by design (spec §14) — this is the only way to create
 * one.
 *
 * Usage: npm run seed:admin -- +919812345678 "StrongPass@123" "Ops Admin"
 */
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { UserRole } from "../src/common/types/user-role.enum";
import { UsersService } from "../src/modules/users/users.service";

async function run(): Promise<void> {
  const [phone, password, fullName] = process.argv.slice(2);
  if (!phone || !password) {
    console.error(
      'Usage: npm run seed:admin -- <phone> <password> ["First Last"]',
    );
    process.exitCode = 1;
    return;
  }
  const [firstName, ...rest] = (fullName ?? "Admin User").split(" ");
  const lastName = rest.join(" ") || undefined;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn"],
  });
  try {
    const users = app.get(UsersService);
    if (await users.existsByPhoneOrEmail(phone)) {
      console.error(`A user with phone ${phone} already exists.`);
      process.exitCode = 1;
      return;
    }
    const admin = await users.create({
      phone,
      password,
      role: UserRole.ADMIN,
      firstName: firstName ?? "Admin",
      lastName,
    });
    console.log(`Admin created: ${admin._id.toString()} (${phone})`);
  } finally {
    await app.close();
  }
}

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
