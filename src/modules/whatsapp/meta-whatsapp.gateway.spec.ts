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
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("MetaWhatsAppGateway", () => {
  let fetchMock: jest.SpyInstance;
  let logged: string[];

  beforeEach(() => {
    fetchMock = jest.spyOn(global, "fetch");
    logged = [];
    for (const level of ["log", "warn", "error", "debug"] as const)
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((message: unknown, ..._rest: unknown[]) => {
          logged.push(String(message));
        });
  });

  afterEach(() => jest.restoreAllMocks());

  it("sends the authentication template with the code in body and button", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { messages: [{ id: "wamid.ABC" }] }),
    );
    const result = await new MetaWhatsAppGateway(
      config(),
    ).sendAuthenticationCode({
      to: "+919876543210",
      code: "482913",
    });

    expect(result).toEqual({ messageId: "wamid.ABC" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://graph.facebook.com/v23.0/123456789012345/messages",
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
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
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: "482913" }],
          },
        ],
      },
    });
  });

  it("omits the button component for templates without one", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { messages: [{ id: "wamid.X" }] }),
    );
    await new MetaWhatsAppGateway(
      config({ whatsappOtpTemplateCodeButton: false }),
    ).sendAuthenticationCode({
      to: "+919876543210",
      code: "000111",
    });
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.template.components).toHaveLength(1);
  });

  it.each([
    [400, 131026, "RECIPIENT_UNAVAILABLE"],
    [400, 131030, "RECIPIENT_UNAVAILABLE"],
    [400, 131056, "RATE_LIMITED"],
    [429, 130429, "RATE_LIMITED"],
    [401, 190, "MISCONFIGURED"],
    [400, 132001, "MISCONFIGURED"],
  ])(
    "classifies HTTP %i / Meta code %i as %s without retrying",
    async (status, code, reason) => {
      fetchMock.mockResolvedValue(
        jsonResponse(status, {
          error: { message: "Meta says no", code, fbtrace_id: "trace-1" },
        }),
      );
      const sending = new MetaWhatsAppGateway(config()).sendAuthenticationCode({
        to: "+919876543210",
        code: "482913",
      });
      await expect(sending).rejects.toBeInstanceOf(WhatsAppDeliveryError);
      await expect(sending).rejects.toMatchObject({ reason });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("retries once on a 5xx or network failure, then reports UNAVAILABLE", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(500, { error: { code: 131000 } }))
      .mockResolvedValueOnce(
        jsonResponse(200, { messages: [{ id: "wamid.retry" }] }),
      );
    await expect(
      new MetaWhatsAppGateway(config()).sendAuthenticationCode({
        to: "+919876543210",
        code: "482913",
      }),
    ).resolves.toEqual({ messageId: "wamid.retry" });

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      new MetaWhatsAppGateway(config()).sendAuthenticationCode({
        to: "+919876543210",
        code: "482913",
      }),
    ).rejects.toMatchObject({ reason: "UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never logs the access token, the code or the full number", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { messages: [{ id: "wamid.ok" }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse(401, {
          error: { code: 190, message: "Invalid OAuth access token" },
        }),
      );
    const gateway = new MetaWhatsAppGateway(config());
    await gateway.sendAuthenticationCode({
      to: "+919876543210",
      code: "482913",
    });
    await gateway
      .sendAuthenticationCode({ to: "+919876543210", code: "482913" })
      .catch(() => undefined);

    const output = logged.join("\n");
    expect(output).toContain("+91 ***** *3210");
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain("482913");
    expect(output).not.toContain("9876543210");
  });
});

describe("MetaWhatsAppGateway SOS templates", () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, "fetch");
    for (const level of ["log", "warn", "error", "debug"] as const)
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const sosConfig = (overrides: Record<string, unknown> = {}) =>
    config({
      whatsappSosTemplateName: "tirvona_sos_alert",
      whatsappSosUpdateTemplateName: "tirvona_sos_update",
      whatsappSosTemplateLanguage: "en",
      ...overrides,
    });

  const alert = (overrides: Record<string, unknown> = {}) => ({
    to: "+919005011088",
    kind: "ALERT" as const,
    personName: "Asha Verma",
    personPhone: "+919876543210",
    rideCode: "TRMYXP9GBB",
    vehicle: "UP16AB1234 · White Maruti Dzire",
    reference: "SOS-RZ4H2Y",
    location: {
      latitude: 28.6215,
      longitude: 77.3652,
      name: "Asha's location",
      address: "Sushil Marg, Sector 62",
    },
    trackingToken: "tok_abc123",
    trackingUrl: "https://api.tirvona.test/api/v1/shared-rides/view/tok_abc123",
    ...overrides,
  });

  const sentBody = () =>
    JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    );

  it("sends the alert template: location header, five body values, tracking button", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { messages: [{ id: "wamid.SOS" }] }),
    );
    await expect(
      new MetaWhatsAppGateway(sosConfig()).sendSosAlert(alert()),
    ).resolves.toEqual({ messageId: "wamid.SOS" });

    expect(sentBody()).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "919005011088",
      type: "template",
      template: {
        name: "tirvona_sos_alert",
        language: { code: "en" },
        components: [
          {
            type: "header",
            parameters: [
              {
                type: "location",
                location: {
                  latitude: "28.6215",
                  longitude: "77.3652",
                  name: "Asha's location",
                  address: "Sushil Marg, Sector 62",
                },
              },
            ],
          },
          {
            type: "body",
            parameters: [
              { type: "text", text: "Asha Verma" },
              { type: "text", text: "+919876543210" },
              { type: "text", text: "TRMYXP9GBB" },
              { type: "text", text: "UP16AB1234 · White Maruti Dzire" },
              { type: "text", text: "SOS-RZ4H2Y" },
            ],
          },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: "tok_abc123" }],
          },
        ],
      },
    });
  });

  it("sends the update template with two body values", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { messages: [{ id: "wamid.UPD" }] }),
    );
    await new MetaWhatsAppGateway(sosConfig()).sendSosAlert(
      alert({ kind: "UPDATE" }),
    );
    const body = sentBody();
    expect(body.template.name).toBe("tirvona_sos_update");
    expect(body.template.components[1].parameters).toEqual([
      { type: "text", text: "Asha Verma" },
      { type: "text", text: "SOS-RZ4H2Y" },
    ]);
    expect(body.template.components).toHaveLength(3);
  });

  it("reports MISCONFIGURED, without calling Meta, when there is no update template", async () => {
    await expect(
      new MetaWhatsAppGateway(
        sosConfig({ whatsappSosUpdateTemplateName: "" }),
      ).sendSosAlert(alert({ kind: "UPDATE" })),
    ).rejects.toMatchObject({
      reason: "MISCONFIGURED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("flattens values Meta would reject: line breaks, runs of spaces and empty values", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { messages: [{ id: "wamid.X" }] }),
    );
    await new MetaWhatsAppGateway(sosConfig()).sendSosAlert(
      alert({
        personName: "Asha\nVerma   Jr",
        vehicle: "   ",
        personPhone: "",
      }),
    );
    const values = sentBody().template.components[1].parameters.map(
      (entry: { text: string }) => entry.text,
    );
    expect(values).toEqual([
      "Asha Verma Jr",
      "not available",
      "TRMYXP9GBB",
      "not assigned yet",
      "SOS-RZ4H2Y",
    ]);
    for (const value of values) {
      expect(value).not.toMatch(/[\n\t]| {4}/);
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("classifies a missing template as MISCONFIGURED and a non-WhatsApp number as RECIPIENT_UNAVAILABLE", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, {
        error: { code: 132001, message: "Template name does not exist" },
      }),
    );
    await expect(
      new MetaWhatsAppGateway(sosConfig()).sendSosAlert(alert()),
    ).rejects.toMatchObject({ reason: "MISCONFIGURED" });
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        error: { code: 131026, message: "Message undeliverable" },
      }),
    );
    await expect(
      new MetaWhatsAppGateway(sosConfig()).sendSosAlert(alert()),
    ).rejects.toMatchObject({ reason: "RECIPIENT_UNAVAILABLE" });
  });

  it("falls back to the default template name when the OTP-only configuration is used", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { messages: [{ id: "wamid.D" }] }),
    );
    await new MetaWhatsAppGateway(config()).sendSosAlert(alert());
    expect(sentBody().template).toMatchObject({
      name: "tirvona_sos_alert",
      language: { code: "en" },
    });
  });
});

describe("LogWhatsAppGateway", () => {
  afterEach(() => jest.restoreAllMocks());

  it("refuses to run in production", async () => {
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    await expect(
      new LogWhatsAppGateway(
        config({ nodeEnv: "production" }),
      ).sendAuthenticationCode({
        to: "+919876543210",
        code: "123456",
      }),
    ).rejects.toMatchObject({ reason: "MISCONFIGURED" });
  });
});
