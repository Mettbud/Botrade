import { describe, expect, it } from "vitest";
import { JupiterApiError } from "../src/jupiter/client.js";

describe("JupiterApiError", () => {
  it("folds a JSON error body into the message so it shows up in logs", () => {
    const err = new JupiterApiError(400, "Bad Request", {
      error: "Could not find any route",
    });
    expect(err.message).toContain("400");
    expect(err.message).toContain("Bad Request");
    expect(err.message).toContain("Could not find any route");
    expect(err.status).toBe(400);
  });

  it("handles a plain-text (non-JSON) error body without crashing", () => {
    const err = new JupiterApiError(502, "Bad Gateway", "<html>upstream error</html>");
    expect(err.message).toContain("502");
    expect(err.message).toContain("upstream error");
  });

  it("still produces a readable message with no body at all", () => {
    const err = new JupiterApiError(500, "Internal Server Error", undefined);
    expect(err.message).toBe("Jupiter API 500 Internal Server Error");
  });
});
