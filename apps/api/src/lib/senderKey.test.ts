// apps/api/src/lib/senderKey.test.ts
import { describe, it, expect } from "vitest";
import { reservationSenderKey, senderNetwork } from "./senderKey";
import { chargedBytes, senderReservationCap } from "./quota";

describe("senderNetwork", () => {
  it("keys an IPv4 address by the full address", () => {
    expect(senderNetwork("203.0.113.5")).toBe("203.0.113.5");
    expect(senderNetwork("203.0.113.6")).not.toBe(senderNetwork("203.0.113.5"));
  });

  it("collapses IPv4-mapped IPv6 (dual-stack sockets) to the IPv4 form", () => {
    expect(senderNetwork("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(senderNetwork("::ffff:cb00:7105")).toBe("203.0.113.5");
  });

  it("keys IPv6 by its /64, so one host can't mint unlimited senders from its prefix", () => {
    const a = senderNetwork("2001:db8:1:2::1");
    expect(senderNetwork("2001:db8:1:2:ffff:ffff:ffff:fffe")).toBe(a);
    expect(senderNetwork("2001:0db8:0001:0002:0:0:0:9")).toBe(a);
    expect(senderNetwork("2001:db8:1:2::1%eth0")).toBe(a);
    expect(senderNetwork("2001:db8:1:3::1")).not.toBe(a);
    expect(senderNetwork("::1")).toBe("0:0:0:0::/64");
  });
});

describe("reservationSenderKey", () => {
  it("is stable per network, distinct across networks, and never contains the raw address", () => {
    const key = reservationSenderKey("198.51.100.23");
    expect(reservationSenderKey("198.51.100.23")).toBe(key);
    expect(reservationSenderKey("::ffff:198.51.100.23")).toBe(key);
    expect(reservationSenderKey("198.51.100.24")).not.toBe(key);
    expect(key).not.toContain("198.51.100");
  });
});

describe("senderReservationCap", () => {
  const MiB = 1024 * 1024;

  it("is a quarter of the quota when that exceeds one max-size file (the default 5 GiB / 500 MiB case)", () => {
    expect(senderReservationCap(5n * 1024n ** 3n, 500 * MiB)).toBe(1280n * BigInt(MiB));
  });

  it("never drops below one max-size file, so a single acceptable upload is never refused by the cap", () => {
    expect(senderReservationCap(1024n ** 3n, 500 * MiB)).toBe(chargedBytes(500 * MiB));
    expect(senderReservationCap(0n, 500 * MiB)).toBe(chargedBytes(500 * MiB));
  });
});
