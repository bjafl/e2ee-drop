// scripts/verify-e2e.mjs
//
// Full-stack round-trip check against a running `docker compose up` stack.
// Plays both recipient and sender with tweetnacl directly against the HTTP API,
// and uploads/downloads through the real presigned storage URLs the API returns.
//
// BASE_URL: where the web container is reachable (default http://localhost:8080).
// Presigned URLs must be on the same origin (served via the web container's /s3/
// proxy) — an internal-only URL like http://minio:9000 fails this check.
import nacl from "tweetnacl";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
const PAYLOAD = "e2ee-drop verification payload";

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}
function fromB64(str) {
  return new Uint8Array(Buffer.from(str, "base64"));
}

function assertPublicUrl(kind, url) {
  const expectedOrigin = new URL(BASE_URL).origin;
  const actual = new URL(url);
  console.log(`${kind}: ${actual.origin}${actual.pathname} (query omitted)`);
  if (actual.origin !== expectedOrigin) {
    throw new Error(`${kind} origin ${actual.origin} is not the public origin ${expectedOrigin}`);
  }
}

async function main() {
  const recipient = nacl.box.keyPair();
  const sender = nacl.box.keyPair();

  const createRes = await fetch(`${BASE_URL}/api/links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipientPublicKey: b64(recipient.publicKey) }),
  });
  if (!createRes.ok) throw new Error(`create-link failed: ${createRes.status}`);
  const { slug, codewords } = await createRes.json();
  if (!Array.isArray(codewords) || codewords.length === 0) {
    throw new Error("create-link response missing codewords");
  }
  console.log(`created link ${slug} (codewords: ${codewords.join(" ")})`);

  const plaintext = new TextEncoder().encode(PAYLOAD);
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const encrypted = nacl.box(plaintext, nonce, recipient.publicKey, sender.secretKey);

  const uploadUrlRes = await fetch(`${BASE_URL}/api/links/${slug}/upload-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      senderPublicKey: b64(sender.publicKey),
      message: "verification run",
      metadata: {
        fileName: "verify.txt",
        fileSize: plaintext.length,
        nonce: b64(nonce),
        mimeType: "text/plain",
        contentMD5: b64(nacl.hash(encrypted)),
      },
    }),
  });
  if (!uploadUrlRes.ok) throw new Error(`upload-url failed: ${uploadUrlRes.status}`);
  const { dropId, uploadUrl } = await uploadUrlRes.json();
  assertPublicUrl("uploadUrl", uploadUrl);

  const putRes = await fetch(uploadUrl, { method: "PUT", body: encrypted });
  if (!putRes.ok) {
    throw new Error(`PUT to storage failed: ${putRes.status} ${await putRes.text()}`);
  }
  console.log(`uploaded ${encrypted.length} encrypted bytes (HTTP ${putRes.status})`);

  const completeRes = await fetch(`${BASE_URL}/api/links/${slug}/drops/${dropId}/complete`, {
    method: "POST",
  });
  if (!completeRes.ok) throw new Error(`upload-complete failed: ${completeRes.status}`);

  const downloadUrlRes = await fetch(`${BASE_URL}/api/links/${slug}/download-url`);
  if (!downloadUrlRes.ok) throw new Error(`download-url failed: ${downloadUrlRes.status}`);
  const info = await downloadUrlRes.json();
  assertPublicUrl("downloadUrl", info.downloadUrl);

  const fileRes = await fetch(info.downloadUrl);
  if (!fileRes.ok) {
    throw new Error(`GET from storage failed: ${fileRes.status} ${await fileRes.text()}`);
  }
  const downloadedBytes = new Uint8Array(await fileRes.arrayBuffer());
  console.log(`downloaded ${downloadedBytes.length} encrypted bytes (HTTP ${fileRes.status})`);

  const decrypted = nacl.box.open(
    downloadedBytes,
    fromB64(info.nonce),
    fromB64(info.senderPublicKey),
    recipient.secretKey
  );
  if (!decrypted) throw new Error("decryption failed");
  const text = new TextDecoder().decode(decrypted);
  if (text !== PAYLOAD) throw new Error(`unexpected content: ${text}`);

  console.log("OK: full anonymous drop round-trip succeeded");
}

main().catch((err) => {
  console.error("VERIFICATION FAILED:", err);
  process.exit(1);
});
