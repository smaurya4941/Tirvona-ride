import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { LogWhatsAppGateway } from "./log-whatsapp.gateway";
import { MetaWhatsAppGateway } from "./meta-whatsapp.gateway";
import { WhatsAppDeliveryError } from "./whatsapp.gateway";

const TOKEN = "EAAG-secret-access-token";

const config = (overrides: Record<string, unknown> = {}) =>
  new ConfigService({
    nodeEnv: "production",
    whatsappApiBaseUrl: "https://graph.facebook.com",
    whatsappApiVersion: "v23.0",
    whatsappPhoneNumberId: "123456789012345",
    whatsappAccessToken: TOKEN,
    whatsappOtpTemplateName: "tirvona_signup_otp",
    whatsappOtpTemplateLanguage: "en",
    whatsappOtpTemplateCodeButton: true,
    whatsappTimeoutMs: 1_000,
    ...overrides,
  });

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("MetaWhatsAppGateway", () => {
  let fetchMock: jest.SpyInstance;
  let logged: string[];

  beforeEach(() => {
    fetchMock = jest.spyOn(global, "fetch");
    logged = [];
    for (const level of ["log", "warn", "error", "debug"] as const)
      jest.spyOn(Logger.prototype, level).mockImplementation((message: unknown, ..._rest: unknown[]) => {
        logged.push(String(message));
      });
  });

  afterEach(() => jest.restoreAllMocks());

  it("sends the authentication template with the code in body and button", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { messages: [{ id: "wamid.ABC" }] }));
    const result = await new MetaWhatsAppGateway(config()).sendAuthenticationCode({
      to: "+919876543210",
      code: "482913",
    });

    expect(result).toEqual({ messageId: "wamid.ABC" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v23.0/123456789012345/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "919876543210",
      type: "template",
      template: {
        name: "tirvona_signup_otp",
        language: { code: "en" },
        components: [
          { type: "body", parameters: [{ type: "text", text: "482913" }] },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "482913" }] },
        ],
      },
    });
  });

  it("omits the button component for templates without one", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { messages: [{ id: "wamid.X" }] }));
    await new MetaWhatsAppGateway(config({ whatsappOtpTemplateCodeButton: false })).sendAuthenticationCode({
      to: "+919876543210",
      code: "000111",
    });
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.template.components).toHaveLength(1);
  });

  it.each([
    [400, 131026, "RECIPIENT_UNAVAILABLE"],
    [400, 131030, "RECIPIENT_UNAVAILABLE"],
    [400, 131056, "RATE_LIMITED"],
    [429, 130429, "RATE_LIMITED"],
    [401, 190, "MISCONFIGURED"],
    [400, 132001, "MISCONFIGURED"],
  ])("classifies HTTP %i / Meta code %i as %s without retrying", async (status, code, reason) => {
    fetchMock.mockResolvedValue(
      jsonResponse(status, { error: { message: "Meta says no", code, fbtrace_id: "trace-1" } }),
    );
    const sending = new MetaWhatsAppGateway(config()).sendAuthenticationCode({ to: "+919876543210", code: "482913" });
    await expect(sending).rejects.toBeInstanceOf(WhatsAppDeliveryError);
    await expect(sending).rejects.toMatchObject({ reason });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries once on a 5xx or network failure, then reports UNAVAILABLE", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(500, { error: { code: 131000 } }))
      .mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: "wamid.retry" }] }));
    await expect(
      new MetaWhatsAppGateway(config()).sendAuthenticationCode({ to: "+919876543210", code: "482913" }),
    ).resolves.toEqual({ messageId: "wamid.retry" });

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      new MetaWhatsAppGateway(config()).sendAuthenticationCode({ to: "+919876543210", code: "482913" }),
    ).rejects.toMatchObject({ reason: "UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never logs the access token, the code or the full number", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: "wamid.ok" }] }))
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 190, message: "Invalid OAuth access token" } }));
    const gateway = new MetaWhatsAppGateway(config());
    await gateway.sendAuthenticationCode({ to: "+919876543210", code: "482913" });
    await gateway.sendAuthenticationCode({ to: "+919876543210", code: "482913" }).catch(() => undefined);

    const output = logged.join("\n");
    expect(output).toContain("+91 ***** *3210");
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain("482913");
    expect(output).not.toContain("9876543210");
  });
});

describe("LogWhatsAppGateway", () => {
  afterEach(() => jest.restoreAllMocks());

  it("refuses to run in production", async () => {
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    await expect(
      new LogWhatsAppGateway(config({ nodeEnv: "production" })).sendAuthenticationCode({
        to: "+919876543210",
        code: "123456",
      }),
    ).rejects.toMatchObject({ reason: "MISCONFIGURED" });
  });
});
