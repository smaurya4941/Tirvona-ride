import { detectFile } from "./document-content";

describe("detectFile", () => {
  it("recognises JPEG, PNG, WEBP and PDF by their first bytes", () => {
    expect(detectFile(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toMatchObject({ contentType: "image/jpeg", kind: "image" });
    expect(detectFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toMatchObject({ contentType: "image/png" });
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);
    expect(detectFile(webp)).toMatchObject({ contentType: "image/webp", extension: ".webp" });
    expect(detectFile(Buffer.from("%PDF-1.7\n..."))).toMatchObject({ contentType: "application/pdf", kind: "pdf" });
  });

  it("refuses anything else, whatever its name", () => {
    expect(detectFile(Buffer.from("<html><script>alert(1)</script></html>"))).toBeNull();
    expect(detectFile(Buffer.from("MZ\x90\x00"))).toBeNull();
    expect(detectFile(Buffer.alloc(0))).toBeNull();
    // RIFF but not WEBP (e.g. WAV)
    expect(detectFile(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt ")]))).toBeNull();
  });
});
