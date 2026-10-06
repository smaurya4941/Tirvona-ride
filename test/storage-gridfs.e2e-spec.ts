import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test } from "@nestjs/testing";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Types } from "mongoose";
import type { Connection } from "mongoose";
import request from "supertest";
import type { App } from "supertest/types";
import { WhatsAppGateway } from "../src/modules/whatsapp/whatsapp.gateway";
import type { AuthenticationCodeMessage, WhatsAppSendResult } from "../src/modules/whatsapp/whatsapp.gateway";

/**
 * File storage on MongoDB GridFS (docs/storage/README.md): KYC documents and
 * profile photos are stored through StorageService, never on the server disk;
 * old disk files and inline photos are migrated; deleting an account deletes
 * its files.
 */

class FakeWhatsApp extends WhatsAppGateway {
  readonly provider = "fake";
  readonly sent: AuthenticationCodeMessage[] = [];

  lastCodeFor(phone: string): string {
    const message = [...this.sent].reverse().find((item) => item.to === phone);
    if (!message) throw new Error(`no code sent to ${phone}`);
    return message.code;
  }

  async sendAuthenticationCode(message: AuthenticationCodeMessage): Promise<WhatsAppSendResult> {
    this.sent.push(message);
    return { messageId: `wamid.fake.${this.sent.length}` };
  }
}

const PASSWORD = "Password@123";
const FILES = "tirvonaFiles.files";
const CHUNKS = "tirvonaFiles.chunks";

/** A real-looking PNG: signature + IHDR (width × height) + noise. */
const png = (width = 256, height = 256): Buffer => {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, randomBytes(512)]);
};

const pdf = (): Buffer => Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(300)]);

interface Session {
  accessToken: string;
  user: { id: string; phone: string };
}

describe("GridFS file storage (e2e)", () => {
  const originalCwd = process.cwd();
  const whatsapp = new FakeWhatsApp();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  let db: Connection;
  let phoneCounter = 0;

  const api = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const nextPhone = () => `+9198000${String(++phoneCounter).padStart(5, "0")}`;
  const gridId = (reference: unknown) => new Types.ObjectId(String(reference).replace("gridfs:", ""));
  const inGridFs = async (reference: unknown): Promise<boolean> =>
    (await db.collection(FILES).countDocuments({ _id: gridId(reference) })) === 1;

  const signUp = async (role: "CUSTOMER" | "DRIVER"): Promise<Session> => {
    const phone = nextPhone();
    const started = await api()
      .post("/api/v1/auth/register")
      .send({ firstName: "Asha", phone, password: PASSWORD, role })
      .expect(202);
    const verified = await api()
      .post("/api/v1/auth/verify-otp")
      .send({ phone, otp: whatsapp.lastCodeFor(phone), verificationId: started.body.data.verificationId, deviceId: "d1" })
      .expect(200);
    return verified.body.data as Session;
  };

  const upload = (token: string, type: string, file: Buffer, filename = "licence.png", contentType = "image/png") =>
    api()
      .post("/api/v1/drivers/me/documents")
      .set(bearer(token))
      .field("documentType", type)
      .attach("file", file, { filename, contentType });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-storage-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_storage",
      REDIS_URL: "",
      THROTTLE_LIMIT: "1000",
      THROTTLE_AUTH_LIMIT: "1000",
      THROTTLE_SIGNUP_LIMIT: "1000",
      THROTTLE_OTP_SEND_LIMIT: "1000",
      THROTTLE_OTP_VERIFY_LIMIT: "1000",
      THROTTLE_REFRESH_LIMIT: "1000",
      BROADCAST_WORKER_INTERVAL_MS: "0",
      PAYMENT_RECONCILE_INTERVAL_MS: "0",
      MATCHING_SWEEP_INTERVAL_MS: "0",
      JWT_ACCESS_SECRET: randomBytes(48).toString("base64url"),
      JWT_REFRESH_SECRET: randomBytes(48).toString("base64url"),
      OTP_HASH_SECRET: randomBytes(48).toString("base64url"),
      WHATSAPP_PROVIDER: "log",
      OTP_MAX_SENDS_PER_WINDOW: "50",
    });

    const { AppModule } = await import("../src/app.module");
    const { configureApp } = await import("../src/app.setup");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WhatsAppGateway)
      .useValue(whatsapp)
      .compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    configureApp(app);
    await app.init();
    db = app.get<Connection>(getConnectionToken());
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.chdir(originalCwd);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  describe("KYC documents", () => {
    let driverA: Session;
    let driverB: Session;
    let customer: Session;
    let documentId: string;
    let reference: string;
    const original = png(300, 200);

    beforeAll(async () => {
      driverA = await signUp("DRIVER");
      driverB = await signUp("DRIVER");
      customer = await signUp("CUSTOMER");
    });

    it("stores the file in GridFS with a reference, tagged by owner, and nothing on disk", async () => {
      const response = await upload(driverA.accessToken, "DRIVING_LICENSE", original).expect(201);
      documentId = response.body.data.id;
      // The API never returns the storage reference.
      expect(JSON.stringify(response.body)).not.toContain("gridfs:");

      const row = await db.collection("driver_documents").findOne({ _id: new Types.ObjectId(documentId) });
      reference = row?.filePath as string;
      expect(reference).toMatch(/^gridfs:[0-9a-f]{24}$/);

      const file = await db.collection(FILES).findOne({ _id: gridId(reference) });
      expect(file).toMatchObject({ length: original.length });
      expect(file?.filename).toMatch(/^[0-9a-f-]{36}\.png$/);
      expect(file?.metadata).toMatchObject({
        module: "drivers",
        ownerId: String(row?.driverId),
        contentType: "image/png",
        originalName: "licence.png",
      });
      expect(file?.metadata?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(await db.collection(CHUNKS).countDocuments({ files_id: gridId(reference) })).toBeGreaterThan(0);
      expect(existsSync(join(workDir, "uploads", "drivers"))).toBe(false);
    });

    it("streams the exact bytes back to the owner only", async () => {
      const own = await api()
        .get(`/api/v1/drivers/me/documents/${documentId}/file`)
        .set(bearer(driverA.accessToken))
        .buffer(true)
        .parse((res, done) => {
          const parts: Buffer[] = [];
          res.on("data", (chunk: Buffer) => parts.push(chunk));
          res.on("end", () => done(null, Buffer.concat(parts)));
        })
        .expect(200);
      expect(own.headers["content-type"]).toContain("image/png");
      expect(Buffer.compare(own.body as Buffer, original)).toBe(0);

      await api().get(`/api/v1/drivers/me/documents/${documentId}/file`).set(bearer(driverB.accessToken)).expect(404);
      await api().get(`/api/v1/drivers/me/documents/${documentId}/file`).set(bearer(customer.accessToken)).expect(403);
      await api().get(`/api/v1/drivers/me/documents/${documentId}/file`).expect(401);
    });

    it("accepts a PDF and judges files by their bytes, not their name", async () => {
      const ok = await upload(driverA.accessToken, "AADHAAR", pdf(), "aadhaar.pdf", "application/pdf").expect(201);
      const row = await db.collection("driver_documents").findOne({ _id: new Types.ObjectId(ok.body.data.id) });
      expect((await db.collection(FILES).findOne({ _id: gridId(row?.filePath) }))?.metadata?.contentType).toBe("application/pdf");

      const before = await db.collection(FILES).countDocuments();
      const fake = await upload(driverA.accessToken, "PAN", Buffer.from("MZ\x90\x00 not an image"), "pan.png").expect(400);
      expect(fake.body.code).toBe("DOCUMENT_INVALID_TYPE");
      // A PNG renamed to .pdf is still a PNG, so it is stored as one.
      await upload(driverA.accessToken, "PAN", png(), "pan.pdf", "application/pdf").expect(201);
      expect(await db.collection(FILES).countDocuments()).toBe(before + 1);
    });

    it("rejects an oversize file before it reaches storage", async () => {
      const before = await db.collection(FILES).countDocuments();
      const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5 * 1024 * 1024)]);
      const response = await upload(driverA.accessToken, "RC", big, "rc.jpg", "image/jpeg").expect(413);
      expect(response.body.code).toBe("DOCUMENT_TOO_LARGE");
      expect(await db.collection(FILES).countDocuments()).toBe(before);
    });

    it("re-upload replaces the record's file and deletes the old one only after the new is saved", async () => {
      const replacement = png(320, 240);
      await upload(driverA.accessToken, "DRIVING_LICENSE", replacement).expect(201);
      const row = await db.collection("driver_documents").findOne({ _id: new Types.ObjectId(documentId) });
      expect(row?.filePath).not.toBe(reference);
      expect(await inGridFs(row?.filePath)).toBe(true);
      expect(await inGridFs(reference)).toBe(false);
      expect(await db.collection(CHUNKS).countDocuments({ files_id: gridId(reference) })).toBe(0);
      expect(await db.collection("driver_documents").countDocuments({ documentType: "DRIVING_LICENSE" })).toBe(1);
    });

    it("deleting a pending document deletes its file", async () => {
      const created = await upload(driverB.accessToken, "DRIVING_LICENSE", png()).expect(201);
      const row = await db.collection("driver_documents").findOne({ _id: new Types.ObjectId(created.body.data.id) });
      await api().delete(`/api/v1/drivers/me/documents/${created.body.data.id}`).set(bearer(driverB.accessToken)).expect(200);
      expect(await inGridFs(row?.filePath)).toBe(false);
    });
  });

  describe("profile photo", () => {
    let account: Session;
    const photo = png(400, 400);

    beforeAll(async () => {
      account = await signUp("CUSTOMER");
    });

    const get = (etag?: string) => {
      const call = api().get("/api/v1/users/me/profile-image").set(bearer(account.accessToken));
      return etag ? call.set("If-None-Match", etag) : call;
    };

    it("stores the photo in GridFS (no bytes in the profile row) and serves it with an ETag", async () => {
      await api()
        .post("/api/v1/users/profile-image")
        .set(bearer(account.accessToken))
        .attach("file", photo, { filename: "me.png", contentType: "image/png" })
        .expect(200);
      const row = await db.collection("profile_images").findOne({ userId: new Types.ObjectId(account.user.id) });
      expect(row?.fileRef).toMatch(/^gridfs:[0-9a-f]{24}$/);
      expect(row).not.toHaveProperty("data");
      expect((await db.collection(FILES).findOne({ _id: gridId(row?.fileRef) }))?.metadata?.module).toBe("profile-images");

      const first = await get().expect(200);
      expect(first.headers["content-type"]).toContain("image/png");
      expect(first.headers.etag).toBe(`"${row?.version}"`);
      await get(first.headers.etag as string).expect(304);
    });

    it("replacing deletes the previous file; removing deletes the last", async () => {
      const before = await db.collection("profile_images").findOne({ userId: new Types.ObjectId(account.user.id) });
      await api()
        .post("/api/v1/users/profile-image")
        .set(bearer(account.accessToken))
        .attach("file", png(500, 500), { filename: "me2.png", contentType: "image/png" })
        .expect(200);
      const after = await db.collection("profile_images").findOne({ userId: new Types.ObjectId(account.user.id) });
      expect(after?.fileRef).not.toBe(before?.fileRef);
      expect(await inGridFs(before?.fileRef)).toBe(false);
      expect(await inGridFs(after?.fileRef)).toBe(true);

      await api().delete("/api/v1/users/profile-image").set(bearer(account.accessToken)).expect(200);
      expect(await inGridFs(after?.fileRef)).toBe(false);
      await get().expect(404);
    });

    it("still serves a photo stored inline before GridFS", async () => {
      const legacy = await signUp("CUSTOMER");
      await db.collection("profile_images").insertOne({
        userId: new Types.ObjectId(legacy.user.id),
        contentType: "image/png",
        data: photo,
        bytes: photo.length,
        width: 400,
        height: 400,
        version: "legacyversion0001",
      });
      const served = await api()
        .get("/api/v1/users/me/profile-image")
        .set(bearer(legacy.accessToken))
        .buffer(true)
        .parse((res, done) => {
          const parts: Buffer[] = [];
          res.on("data", (chunk: Buffer) => parts.push(chunk));
          res.on("end", () => done(null, Buffer.concat(parts)));
        })
        .expect(200);
      expect(Buffer.compare(served.body as Buffer, photo)).toBe(0);
    });
  });

  describe("migration of legacy files", () => {
    it("moves disk files and inline photos into GridFS, reports missing ones, and is repeatable", async () => {
      const { LegacyUploadsMigrator } = await import("../src/modules/storage/legacy-uploads-migrator");
      const migrator = app.get(LegacyUploadsMigrator);
      const driver = await signUp("DRIVER");
      const driverProfile = await db.collection("driver_profiles").findOne({ userId: new Types.ObjectId(driver.user.id) });
      const directory = join(workDir, "uploads", "drivers", String(driverProfile?._id));
      await mkdir(directory, { recursive: true });
      const onDisk = join(directory, "old-licence.png");
      const bytes = png(310, 210);
      await writeFile(onDisk, bytes);

      const present = await db.collection("driver_documents").insertOne({
        driverId: driverProfile?._id,
        documentType: "OLD_ON_DISK",
        filePath: onDisk,
        status: "PENDING",
      });
      const gone = await db.collection("driver_documents").insertOne({
        driverId: driverProfile?._id,
        documentType: "OLD_WIPED",
        filePath: join(directory, "wiped-by-redeploy.png"),
        status: "PENDING",
      });
      const inline = await signUp("CUSTOMER");
      await db.collection("profile_images").insertOne({
        userId: new Types.ObjectId(inline.user.id),
        contentType: "image/png",
        data: png(400, 400),
        bytes: 100,
        width: 400,
        height: 400,
        version: "inlinephoto000001",
      });

      const dry = await migrator.run({ dryRun: true });
      expect(dry.migrated).toBe(3);
      expect(existsSync(onDisk)).toBe(true);

      const report = await migrator.run();
      expect(report).toMatchObject({ migrated: 3, missing: 1, skipped: 0 }); // disk file + 2 inline photos (this one and the legacy-photo test's)

      const migrated = await db.collection("driver_documents").findOne({ _id: present.insertedId });
      expect(migrated?.filePath).toMatch(/^gridfs:/);
      expect(existsSync(onDisk)).toBe(false);
      expect((await db.collection("driver_documents").findOne({ _id: gone.insertedId }))?.filePath).toContain("wiped-by-redeploy");
      const photo = await db.collection("profile_images").findOne({ userId: new Types.ObjectId(inline.user.id) });
      expect(photo?.fileRef).toMatch(/^gridfs:/);
      expect(photo).not.toHaveProperty("data");

      // Second run: only the missing one is left.
      expect(await migrator.run()).toMatchObject({ migrated: 0, missing: 1 });

      // The owner can read the migrated document through the normal route.
      const download = await api()
        .get(`/api/v1/drivers/me/documents/${present.insertedId.toHexString()}/file`)
        .set(bearer(driver.accessToken))
        .expect(200);
      expect(download.headers["content-type"]).toContain("image/png");
    });
  });

  describe("account deletion", () => {
    it("deletes the driver's documents and photo from GridFS", async () => {
      const driver = await signUp("DRIVER");
      await upload(driver.accessToken, "DRIVING_LICENSE", png()).expect(201);
      await api()
        .post("/api/v1/users/profile-image")
        .set(bearer(driver.accessToken))
        .attach("file", png(400, 400), { filename: "me.png", contentType: "image/png" })
        .expect(200);
      const profile = await db.collection("driver_profiles").findOne({ userId: new Types.ObjectId(driver.user.id) });
      const document = await db.collection("driver_documents").findOne({ driverId: profile?._id });
      const photo = await db.collection("profile_images").findOne({ userId: new Types.ObjectId(driver.user.id) });
      expect(await inGridFs(document?.filePath)).toBe(true);
      expect(await inGridFs(photo?.fileRef)).toBe(true);

      await api().post("/api/v1/users/me/delete-account").set(bearer(driver.accessToken)).send({ password: PASSWORD }).expect(200);

      expect(await inGridFs(document?.filePath)).toBe(false);
      expect(await inGridFs(photo?.fileRef)).toBe(false);
      expect(await db.collection(CHUNKS).countDocuments({ files_id: { $in: [gridId(document?.filePath), gridId(photo?.fileRef)] } })).toBe(0);
    });
  });
});
