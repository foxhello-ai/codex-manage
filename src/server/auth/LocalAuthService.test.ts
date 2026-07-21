import { describe, expect, it } from "vitest";
import { LocalAuthService } from "./LocalAuthService";

function createService(options: { bootstrapPassword?: string | null; pairingCodeTtlSeconds?: number } = {}) {
  return new LocalAuthService({
    databaseFile: ":memory:",
    bootstrapPassword: options.bootstrapPassword === undefined ? null : options.bootstrapPassword,
    bootstrapPasswordIsDefault: false,
    sessionTtlSeconds: 3600,
    pairingCodeTtlSeconds: options.pairingCodeTtlSeconds ?? 300
  });
}

describe("LocalAuthService", () => {
  it("requires setup when no bootstrap password exists", () => {
    const service = createService();

    expect(service.isSetupRequired()).toBe(true);
    expect(service.setup("a-secure-password")).toBe(true);
    expect(service.setup("another-password")).toBe(false);
    expect(service.verifyPassword("a-secure-password")).toBe(true);
    expect(service.verifyPassword("wrong-password")).toBe(false);

    service.close();
  });

  it("issues, authenticates and revokes opaque sessions", () => {
    const service = createService({ bootstrapPassword: "configured-password" });
    const issued = service.createSession("password", "test-agent");

    expect(service.authenticate(issued.token)).toMatchObject({
      id: issued.session.id,
      source: "password",
      userAgent: "test-agent"
    });
    expect(service.listSessions()).toHaveLength(1);

    service.revokeSessionToken(issued.token);
    expect(service.authenticate(issued.token)).toBeNull();

    service.close();
  });

  it("consumes a pairing code only once", () => {
    const service = createService({ bootstrapPassword: "configured-password" });
    const pairingCode = service.createPairingCode();

    const issued = service.consumePairingCode(pairingCode.code, "mobile-agent");

    expect(issued).not.toBeNull();
    expect(issued?.session.source).toBe("pairing");
    expect(service.consumePairingCode(pairingCode.code, "replay-agent")).toBeNull();

    service.close();
  });

  it("invalidates the previous pairing code when a QR code is refreshed", () => {
    const service = createService({ bootstrapPassword: "configured-password" });
    const first = service.createPairingCode();
    const second = service.createPairingCode();

    expect(service.consumePairingCode(first.code, "first-browser")).toBeNull();
    expect(service.consumePairingCode(second.code, "second-browser")?.session.source).toBe("pairing");

    service.close();
  });

  it("revokes all sessions after a password change", () => {
    const service = createService({ bootstrapPassword: "configured-password" });
    const first = service.createSession("password", null);
    const second = service.createSession("pairing", null);

    service.setPassword("changed-password");

    expect(service.authenticate(first.token)).toBeNull();
    expect(service.authenticate(second.token)).toBeNull();
    expect(service.verifyPassword("changed-password")).toBe(true);

    service.close();
  });
});
