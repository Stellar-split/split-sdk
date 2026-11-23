import { describe, it, expect, beforeEach } from "vitest";
import { CorsHandler, type CorsRequest } from "../src/cors.js";

const get = (origin?: string): CorsRequest => ({
  method: "GET",
  origin,
  headers: {},
});

const preflight = (
  origin: string,
  requestMethod: string,
  requestHeaders?: string,
): CorsRequest => ({
  method: "OPTIONS",
  origin,
  headers: {
    "access-control-request-method": requestMethod,
    ...(requestHeaders ? { "access-control-request-headers": requestHeaders } : {}),
  },
});

describe("CorsHandler", () => {
  let handler: CorsHandler;

  beforeEach(() => {
    handler = new CorsHandler();
  });

  describe("origin resolution", () => {
    it("allows the default wildcard origin and emits CORS headers", async () => {
      const decision = await handler.handle(get("https://app.example.com"));

      expect(decision.allowed).toBe(true);
      expect(decision.isPreflight).toBe(false);
      expect(decision.headers).toMatchObject({
        "Access-Control-Allow-Origin": "*",
        Vary: "Origin",
      });
    });

    it("allows a fixed origin list and rejects unknown origins", async () => {
      handler = new CorsHandler({ origins: ["https://app.example.com", "https://admin.example.com"] });

      expect(
        (await handler.handle(get("https://app.example.com"))).headers["Access-Control-Allow-Origin"],
      ).toBe("https://app.example.com");
      const denied = await handler.handle(get("https://evil.example.com"));
      expect(denied.allowed).toBe(false);
      expect(denied.reason).toBe("origin-not-allowed");
      expect(denied.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    });

    it("supports asynchronous origin predicates", async () => {
      handler = new CorsHandler({
        origins: async (origin) => origin.endsWith(".trusted.example"),
      });

      expect((await handler.handle(get("https://api.trusted.example"))).allowed).toBe(true);
      expect((await handler.handle(get("https://api.other.example"))).allowed).toBe(false);
      expect(await handler.isOriginAllowed("https://a.trusted.example")).toBe(true);
    });

    it("skips CORS headers for requests without an origin", async () => {
      const decision = await handler.handle(get());

      expect(decision.allowed).toBe(true);
      expect(decision.headers).toEqual({});
    });
  });

  describe("credentials safety", () => {
    it("reflects the origin instead of emitting a wildcard with credentials", async () => {
      handler = new CorsHandler({ credentials: true, exposedHeaders: ["X-Request-Id"] });

      const decision = await handler.handle(get("https://app.example.com"));
      expect(decision.headers["Access-Control-Allow-Origin"]).toBe("https://app.example.com");
      expect(decision.headers["Access-Control-Allow-Credentials"]).toBe("true");
      expect(decision.headers["Access-Control-Allow-Origin"]).not.toBe("*");
      expect(decision.headers["Access-Control-Expose-Headers"]).toBe("X-Request-Id");
    });

    it("applies credential rules to preflights too", async () => {
      handler = new CorsHandler({ credentials: true });
      const decision = await handler.handle(preflight("https://app.example.com", "POST"));

      expect(decision.headers["Access-Control-Allow-Origin"]).toBe("https://app.example.com");
      expect(decision.headers["Access-Control-Allow-Credentials"]).toBe("true");
    });
  });

  describe("preflight handling", () => {
    it("answers allowed preflights with methods, headers and max age", async () => {
      handler = new CorsHandler({ maxAge: 120 });
      const decision = await handler.handle(
        preflight("https://app.example.com", "POST", "Content-Type, X-Stellar-Split-Trace-Id"),
      );

      expect(decision.allowed).toBe(true);
      expect(decision.isPreflight).toBe(true);
      expect(decision.headers["Access-Control-Allow-Methods"]).toContain("POST");
      expect(decision.headers["Access-Control-Allow-Headers"]).toBe(
        "Content-Type, X-Stellar-Split-Trace-Id",
      );
      expect(decision.headers["Access-Control-Max-Age"]).toBe("120");
    });

    it("rejects unsupported methods and headers", async () => {
      const badMethod = await handler.handle(preflight("https://app.example.com", "TRACE"));
      expect(badMethod.allowed).toBe(false);
      expect(badMethod.reason).toBe("method-not-allowed");

      const badHeaders = await handler.handle(
        preflight("https://app.example.com", "POST", "X-Unknown-Header"),
      );
      expect(badHeaders.allowed).toBe(false);
      expect(badHeaders.reason).toBe("headers-not-allowed");
      expect(badHeaders.headers["Access-Control-Allow-Methods"]).toBeUndefined();
    });

    it("supports custom allowed headers", async () => {
      handler = new CorsHandler({ allowedHeaders: ["X-Custom"] });
      const decision = await handler.handle(
        preflight("https://app.example.com", "POST", "x-custom"),
      );

      expect(decision.allowed).toBe(true);
      expect(decision.headers["Access-Control-Allow-Headers"]).toBe("x-custom");
    });
  });

  describe("tracking", () => {
    it("counts requests, preflights, approvals and denials", async () => {
      handler = new CorsHandler({ origins: ["https://app.example.com"] });
      await handler.handle(get("https://app.example.com"));
      await handler.handle(get("https://evil.example.com"));
      await handler.handle(preflight("https://app.example.com", "POST"));

      expect(handler.stats()).toEqual({ requests: 3, preflights: 1, allowed: 2, denied: 1 });
      expect(handler.eventsTrail()).toHaveLength(3);
      expect(handler.eventsTrail()[2]).toMatchObject({ isPreflight: true, allowed: true });
    });

    it("keeps the trail bounded", async () => {
      handler = new CorsHandler({ maxTrackedEvents: 2 });
      for (let i = 0; i < 5; i += 1) {
        await handler.handle(get(`https://app${i}.example.com`));
      }

      expect(handler.eventsTrail()).toHaveLength(2);
      expect(handler.eventsTrail().map((event) => event.origin)).toEqual([
        "https://app3.example.com",
        "https://app4.example.com",
      ]);
    });
  });
});
