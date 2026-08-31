import { describe, expect, it } from "vitest";
import { imageToBase64 } from "../src/utils/media.js";

describe("imageToBase64 (string inputs)", () => {
  it("returns a raw base64 string unchanged", async () => {
    const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgAB";
    await expect(imageToBase64(b64)).resolves.toBe(b64);
  });

  it("decodes a data: URL to its base64 payload", async () => {
    await expect(imageToBase64("data:image/png;base64,AAAA")).resolves.toBe("AAAA");
  });

  it("throws on a data: URL with no payload", async () => {
    await expect(imageToBase64("data:,")).rejects.toThrow("Invalid data URL image");
  });

  it("rejects a file: URL rather than forwarding it as base64", async () => {
    await expect(imageToBase64("file:///etc/passwd")).rejects.toThrow("Unsupported image URL scheme");
  });

  it("rejects other non-http URL schemes (blob:, ftp:)", async () => {
    await expect(imageToBase64("blob:https://example.com/uuid")).rejects.toThrow("Unsupported image URL scheme");
    await expect(imageToBase64("ftp://example.com/image.png")).rejects.toThrow("Unsupported image URL scheme");
  });
});
