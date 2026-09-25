// apps/api/src/lib/trustProxy.ts
//
// Builds the function passed as Fastify's `trustProxy` option, trusting
// exactly `hops` reverse-proxy hops (configured via TRUST_PROXY_HOPS — see
// env.ts and the "Fronting with TLS" section of README.md).
//
// Fastify (5.12.5) resolves request.ip via @fastify/proxy-addr's `all()`:
// it builds the address list [socket peer, rightmost X-Forwarded-For entry,
// ..., leftmost X-Forwarded-For entry] and walks it from index 0, calling
// trust(address, hop) for each entry. While trust() returns true it keeps
// going; at the first `false` it stops, and request.ip is that entry. (If
// every entry is trusted, the leftmost X-Forwarded-For entry is used.)
//
// So `hop < hops` trusts the socket peer plus the next (hops - 1) entries
// appended by our own proxies, and request.ip becomes the address the
// outermost trusted proxy saw connecting to it, i.e. the real client. Anything
// further left in X-Forwarded-For was supplied by the client and is ignored,
// so a client can't spoof its IP by pre-filling that header.
//
//   hops = 1 (default; shipped Compose: client -> web/nginx -> api):
//     socket = nginx, trusted; request.ip = rightmost XFF entry (the
//     address nginx saw).
//   hops = 2 (operator proxy in front: client -> proxy -> nginx -> api):
//     socket = nginx and rightmost XFF entry (the operator proxy, added by
//     nginx) are trusted; request.ip = the next XFF entry (the address the
//     operator proxy saw).
//   hops = 0: nothing trusted; request.ip is the socket peer (only right if
//     clients connect to the API directly with no proxy in between).
//
// Setting hops too LOW collapses every client into the address of one of
// our own proxies (one shared rate-limit bucket: a single attacker can lock
// everyone out of login). Setting it too HIGH lets clients spoof their IP
// via X-Forwarded-For. Get it exactly right for the deployment.
//
// This hop-count trust is only safe because the API is never directly
// reachable by untrusted clients: in docker-compose.yml the `api` service
// publishes no ports, so its only peer is the `web` container's nginx. If the
// API were exposed directly, a client would itself be hop 0 and trusted,
// and could set X-Forwarded-For to anything.

export type TrustProxyFunction = (address: string, hop: number) => boolean;

export function createTrustProxyFn(hops: number): TrustProxyFunction {
  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error(`TRUST_PROXY_HOPS must be a non-negative integer, got: ${hops}`);
  }
  return (_address: string, hop: number) => hop < hops;
}
