// apps/api/src/lib/senderKey.ts
//
// Turns an upload sender's IP (request.ip, resolved through trustProxy.ts)
// into the opaque tag stored on Drop.reservationSenderKey, which lets
// upload-url cap how much of one owner's quota a single sender holds in
// in-flight reservations (assertWithinSenderShare in lib/quota.ts).
//
// Two decisions live here:
//
// 1. What counts as "one sender". An IPv4 address is one sender. For IPv6,
//    a single host (or a single customer line) is normally handed a whole
//    /64, so keying by the full address would let one attacker mint 2^64
//    distinct "senders" and bypass the cap entirely. IPv6 is therefore keyed
//    by its /64 prefix, and IPv4-mapped IPv6 (::ffff:a.b.c.d, what a
//    dual-stack socket reports for an IPv4 peer) collapses to the IPv4 form.
//
// 2. What gets stored. This is a privacy-focused app and the tag sits in the
//    database next to the drop, so the raw address is never stored: the tag
//    is an HMAC-SHA256 under a random key generated at process start and
//    held only in memory. A database dump alone therefore cannot be tied back
//    to sender IPs, even by someone who also has the app's env secrets (a
//    stable key such as APP_SECRET_KEY would let them brute-force the small
//    IPv4 space). The cost: after a restart, reservations created before it
//    no longer match their sender's new tag, so for at most one reservation
//    window a sender's older reservations don't count toward their share
//    (they still count toward the owner's total quota). Restarts are rare and
//    not attacker-triggerable, so this is an accepted trade-off. The tag is
//    also cleared as soon as the drop completes (routes/uploads.ts).
import { createHmac, randomBytes } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";

const PROCESS_KEY = randomBytes(32);

// Expands any valid IPv6 text form (including "::" compression, an embedded
// dotted IPv4 tail, and a %zone suffix) into its eight 16-bit groups.
function ipv6Groups(address: string): number[] {
  let text = address.split("%")[0]!;
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const [a, b, c, d] = tail.split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split("::") as [string, string | undefined];
  const headGroups = head ? head.split(":") : [];
  const restGroups = rest ? rest.split(":") : [];
  const zeros = rest === undefined ? [] : Array(8 - headGroups.length - restGroups.length).fill("0");
  return [...headGroups, ...zeros, ...restGroups].map((group) => parseInt(group, 16));
}

// The network a request came from, at the granularity one party can be
// assumed to control: the IPv4 address, or the IPv6 /64. Exported for tests.
export function senderNetwork(ip: string): string {
  if (isIPv4(ip)) return ip;
  if (isIPv6(ip)) {
    const groups = ipv6Groups(ip);
    const isV4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
    if (isV4Mapped) return `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
    return `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
  }
  // Not an IP (should not happen behind Fastify); still a stable per-value key.
  return ip;
}

export function reservationSenderKey(ip: string): string {
  return createHmac("sha256", PROCESS_KEY).update(senderNetwork(ip)).digest("base64url");
}
