import { describe, expect, it } from "vitest";
import { ModelDomainError, sanitizeModelError } from "./modelErrors";

describe("model errors", () => {
  it("keeps domain metadata", () => {
    const error = new ModelDomainError("MODEL_NOT_SUPPORTED", "模型不可用", 422, { model: "missing" });
    expect(error).toMatchObject({
      name: "ModelDomainError",
      code: "MODEL_NOT_SUPPORTED",
      statusCode: 422,
      details: { model: "missing" }
    });
  });

  it("redacts credentials and global config paths", () => {
    const message = sanitizeModelError(
      "Authorization: secret Cookie=session token=abc api_key=xyz ~/.codex/auth.json https://example.test/v1?token=secret"
    );
    expect(message).not.toContain("secret");
    expect(message).not.toContain("session");
    expect(message).not.toContain("abc");
    expect(message).not.toContain("xyz");
    expect(message).not.toContain("auth.json");
    expect(message).toContain("[REDACTED]");
  });
});
