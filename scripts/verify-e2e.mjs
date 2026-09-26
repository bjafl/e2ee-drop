// scripts/verify-e2e.mjs
//
// Full-stack round-trip check against a running `docker compose up` stack.
// Plays sender and recipient (and, for the request-flow scenario, an authenticated
// initiator) directly against the HTTP API with tweetnacl, and uploads/downloads
// through the real presigned storage URLs the API returns.
//
// BASE_URL: where the web container is reachable (default http://localhost:8080).
// Presigned URLs must be on the same origin (served via the web container's /s3/
// proxy) — an internal-only URL like http://minio:9000 fails this check.
//
// Two scenarios run in sequence:
//   1. recipientInitiatedOneTimeLink — POST /api/links (anonymous one-time link),
//      send a message + one file, reveal the message once, download and decrypt
//      the file once, and confirm a second reveal/download attempt is refused.
//   2. senderInitiatedRequestFlow — POST /api/links/request (authenticated
//      initiator) -> anonymous claim -> the initiator sends -> the claimed
//      recipient receives, plus the claim/ownership boundary checks (a second
//      claim is refused, and the initiator/owner is never granted receive-side
//      access to their own request link).
//
// Wire shapes (RequestUploadUrlRequest, DropSummary, DownloadUrlResponse, ...) are
// defined in packages/shared/src/api.ts; the envelope-building here mirrors
// apps/web/src/lib/cryptoUtils.ts's encryptBytes/decryptBytes exactly, except the
// "archive" is sent as plain (unzipped) file bytes rather than a real zip —
// nothing server-side ever inspects the archive's contents, only its ciphertext
// length and hash, so building a real zip here would add no verification value.
import nacl from "tweetnacl";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
const PAYLOAD = "e2ee-drop verification payload";
const MESSAGE = "e2ee-drop verification message";
const REQUEST_FLOW_PAYLOAD = "e2ee-drop request-flow verification payload";
const REQUEST_FLOW_MESSAGE = "e2ee-drop request-flow verification message";

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}
function fromB64(str) {
  return new Uint8Array(Buffer.from(str, "base64"));
}
function textBytes(str) {
  return new TextEncoder().encode(str);
}

function assertPublicUrl(kind, url) {
  const expectedOrigin = new URL(BASE_URL).origin;
  const actual = new URL(url);
  console.log(`${kind}: ${actual.origin}${actual.pathname} (query omitted)`);
  if (actual.origin !== expectedOrigin) {
    throw new Error(`${kind} origin ${actual.origin} is not the public origin ${expectedOrigin}`);
  }
}

function boxEncrypt(bytes, recipientPublicKey, senderSecretKey) {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const encrypted = nacl.box(bytes, nonce, recipientPublicKey, senderSecretKey);
  return { encrypted, nonce };
}

function boxDecrypt(encrypted, nonce, senderPublicKey, recipientSecretKey) {
  const decrypted = nacl.box.open(encrypted, nonce, senderPublicKey, recipientSecretKey);
  if (!decrypted) throw new Error("decryption failed");
  return decrypted;
}

// Builds the three send envelopes (archive, metadata, message) the way
// apps/web/src/lib/cryptoUtils.ts's encryptBytes does for each of them — see
// RequestUploadUrlRequest for the wire shape this feeds into.
function buildSendEnvelopes({ fileName, fileBytes, message, recipientPublicKey, senderSecretKey }) {
  const archive = boxEncrypt(fileBytes, recipientPublicKey, senderSecretKey);
  const metadataPlain = textBytes(
    JSON.stringify({ files: [{ name: fileName, size: fileBytes.length }], mimeType: "application/zip" })
  );
  const metadata = boxEncrypt(metadataPlain, recipientPublicKey, senderSecretKey);
  const messagePayload = message !== null ? boxEncrypt(textBytes(message), recipientPublicKey, senderSecretKey) : null;
  return {
    archiveCiphertext: archive.encrypted,
    archiveNonce: b64(archive.nonce),
    encryptedMetadata: b64(metadata.encrypted),
    metadataNonce: b64(metadata.nonce),
    encryptedMessage: messagePayload ? b64(messagePayload.encrypted) : null,
    messageNonce: messagePayload ? b64(messagePayload.nonce) : null,
    fileSize: fileBytes.length,
    contentMD5: b64(nacl.hash(archive.encrypted)),
  };
}

// Runs upload-url -> PUT -> complete for one drop and returns its dropId.
// extraHeaders carries the initiator's session cookie for the request-flow
// scenario (so assertSenderIdentity's account-key match actually applies); the
// anonymous scenario passes none, exactly like an unauthenticated sender.
async function uploadDrop(slug, envelopes, senderPublicKey, extraHeaders = {}) {
  const uploadUrlRes = await fetch(`${BASE_URL}/api/links/${slug}/upload-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify({
      senderPublicKey,
      archiveNonce: envelopes.archiveNonce,
      encryptedMessage: envelopes.encryptedMessage,
      messageNonce: envelopes.messageNonce,
      encryptedMetadata: envelopes.encryptedMetadata,
      metadataNonce: envelopes.metadataNonce,
      metadata: { fileSize: envelopes.fileSize, contentMD5: envelopes.contentMD5 },
    }),
  });
  if (!uploadUrlRes.ok) throw new Error(`upload-url failed: ${uploadUrlRes.status} ${await uploadUrlRes.text()}`);
  const { dropId, uploadUrl } = await uploadUrlRes.json();
  assertPublicUrl("uploadUrl", uploadUrl);

  const putRes = await fetch(uploadUrl, { method: "PUT", body: envelopes.archiveCiphertext });
  if (!putRes.ok) {
    throw new Error(`PUT to storage failed: ${putRes.status} ${await putRes.text()}`);
  }
  console.log(`uploaded ${envelopes.archiveCiphertext.length} encrypted bytes (HTTP ${putRes.status})`);

  const completeRes = await fetch(`${BASE_URL}/api/links/${slug}/drops/${dropId}/complete`, { method: "POST" });
  if (!completeRes.ok) throw new Error(`upload-complete failed: ${completeRes.status}`);

  return dropId;
}

async function recipientInitiatedOneTimeLink() {
  console.log("\n--- scenario: recipient-initiated one-time link (message + file) ---");
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

  const envelopes = buildSendEnvelopes({
    fileName: "verify.txt",
    fileBytes: textBytes(PAYLOAD),
    message: MESSAGE,
    recipientPublicKey: recipient.publicKey,
    senderSecretKey: sender.secretKey,
  });
  const dropId = await uploadDrop(slug, envelopes, b64(sender.publicKey));
  console.log(`drop ${dropId} uploaded and completed`);

  // Receive side: the link status response carries the drop's ciphertext
  // envelopes for an anonymous link (see toLinkStatusResponse).
  const statusRes = await fetch(`${BASE_URL}/api/links/${slug}`);
  if (!statusRes.ok) throw new Error(`link status failed: ${statusRes.status}`);
  const status = await statusRes.json();
  if (!status.drop) throw new Error("link status is missing the uploaded drop");
  if (!status.drop.hasMessage) throw new Error("expected drop to report hasMessage: true before reveal");

  const metadata = JSON.parse(
    new TextDecoder().decode(
      boxDecrypt(
        fromB64(status.drop.encryptedMetadata),
        fromB64(status.drop.metadataNonce),
        fromB64(status.drop.senderPublicKey),
        recipient.secretKey
      )
    )
  );
  if (metadata.files?.[0]?.name !== "verify.txt") throw new Error(`unexpected metadata: ${JSON.stringify(metadata)}`);
  console.log(`decrypted metadata: ${JSON.stringify(metadata)}`);

  // Reveal the message once.
  const revealRes = await fetch(`${BASE_URL}/api/links/${slug}/drops/${dropId}/reveal-message`, { method: "POST" });
  if (!revealRes.ok) throw new Error(`reveal-message failed: ${revealRes.status}`);
  const { encryptedMessage, messageNonce } = await revealRes.json();
  const revealedMessage = new TextDecoder().decode(
    boxDecrypt(fromB64(encryptedMessage), fromB64(messageNonce), fromB64(status.drop.senderPublicKey), recipient.secretKey)
  );
  if (revealedMessage !== MESSAGE) throw new Error(`unexpected revealed message: ${revealedMessage}`);
  console.log("message revealed and decrypted correctly");

  // A second reveal attempt must be refused — it's a one-time reveal.
  const secondRevealRes = await fetch(`${BASE_URL}/api/links/${slug}/drops/${dropId}/reveal-message`, { method: "POST" });
  if (secondRevealRes.status !== 409) {
    throw new Error(`expected a second reveal-message to be refused with 409, got ${secondRevealRes.status}`);
  }
  console.log("second reveal-message attempt correctly refused (409)");

  // Download and decrypt the file once.
  const downloadUrlRes = await fetch(`${BASE_URL}/api/links/${slug}/download-url?dropId=${encodeURIComponent(dropId)}`);
  if (!downloadUrlRes.ok) throw new Error(`download-url failed: ${downloadUrlRes.status}`);
  const info = await downloadUrlRes.json();
  assertPublicUrl("downloadUrl", info.downloadUrl);

  const fileRes = await fetch(info.downloadUrl);
  if (!fileRes.ok) {
    throw new Error(`GET from storage failed: ${fileRes.status} ${await fileRes.text()}`);
  }
  const downloadedBytes = new Uint8Array(await fileRes.arrayBuffer());
  console.log(`downloaded ${downloadedBytes.length} encrypted bytes (HTTP ${fileRes.status})`);

  const decrypted = boxDecrypt(downloadedBytes, fromB64(info.archiveNonce), fromB64(info.senderPublicKey), recipient.secretKey);
  const text = new TextDecoder().decode(decrypted);
  if (text !== PAYLOAD) throw new Error(`unexpected content: ${text}`);

  const completeDownloadRes = await fetch(`${BASE_URL}/api/links/${slug}/drops/${dropId}/complete-download`, {
    method: "POST",
  });
  if (!completeDownloadRes.ok) throw new Error(`complete-download failed: ${completeDownloadRes.status}`);
  const { completed } = await completeDownloadRes.json();
  if (!completed) throw new Error("expected the first complete-download to report completed: true");

  // A second complete-download call must be a no-op — the drop is already delivered.
  const secondCompleteDownloadRes = await fetch(`${BASE_URL}/api/links/${slug}/drops/${dropId}/complete-download`, {
    method: "POST",
  });
  if (!secondCompleteDownloadRes.ok) {
    throw new Error(`second complete-download failed unexpectedly: ${secondCompleteDownloadRes.status}`);
  }
  const second = await secondCompleteDownloadRes.json();
  if (second.completed !== false) {
    throw new Error(`expected a second complete-download to report completed: false, got ${JSON.stringify(second)}`);
  }
  console.log("second complete-download call correctly reported completed: false");

  // The underlying storage object is gone now (complete-download deletes it), so a
  // real second download attempt is refused — download-url itself still issues a
  // fresh presigned URL (nothing gates re-issuance), but the object it points at
  // no longer exists.
  const secondDownloadUrlRes = await fetch(`${BASE_URL}/api/links/${slug}/download-url?dropId=${encodeURIComponent(dropId)}`);
  if (!secondDownloadUrlRes.ok) throw new Error(`second download-url failed: ${secondDownloadUrlRes.status}`);
  const secondInfo = await secondDownloadUrlRes.json();
  const secondFileRes = await fetch(secondInfo.downloadUrl);
  if (secondFileRes.ok) {
    throw new Error("expected the second download attempt to be refused, but GET from storage succeeded");
  }
  console.log(`second download attempt correctly refused by storage (HTTP ${secondFileRes.status})`);

  console.log("OK: recipient-initiated one-time link round-trip succeeded (message + file, second download refused)");
}

async function senderInitiatedRequestFlow() {
  console.log("\n--- scenario: sender-initiated request -> claim -> send -> receive ---");
  const initiator = nacl.box.keyPair();
  const recipient = nacl.box.keyPair();

  const suffix = b64(nacl.randomBytes(6)).replace(/[^a-z0-9]/gi, "").toLowerCase();
  const email = `e2e-verify-${suffix}@example.com`;
  const username = `e2e-verify-${suffix}`;

  // authKey/passwordSalt/passwordWrappedPrivateKey/recoveryWrappedPrivateKey are
  // opaque, server-stored blobs (real client-side password-vault crypto lives in
  // apps/web/src/lib/keyWrapping.ts) — any well-formed base64 works here, since
  // nothing in this scenario exercises password login. publicKey must be a real
  // nacl key: it's what assertSenderIdentity checks the upload-url call against.
  const registerRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      username,
      name: "E2E Verify",
      authKey: b64(nacl.randomBytes(32)),
      passwordSalt: b64(nacl.randomBytes(16)),
      passwordWrappedPrivateKey: b64(nacl.randomBytes(64)),
      recoveryWrappedPrivateKey: b64(nacl.randomBytes(64)),
      publicKey: b64(initiator.publicKey),
    }),
  });
  if (!registerRes.ok) throw new Error(`register failed: ${registerRes.status} ${await registerRes.text()}`);
  const setCookies = registerRes.headers.getSetCookie();
  if (!setCookies.length) throw new Error("register response is missing a session cookie");
  const sessionCookie = setCookies.map((cookie) => cookie.split(";")[0]).join("; ");
  console.log(`registered initiator account ${username} and received a session cookie`);

  const requestRes = await fetch(`${BASE_URL}/api/links/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: sessionCookie },
    body: JSON.stringify({}),
  });
  if (!requestRes.ok) throw new Error(`links/request failed: ${requestRes.status} ${await requestRes.text()}`);
  const { slug } = await requestRes.json();
  console.log(`created request link ${slug}`);

  const beforeClaimRes = await fetch(`${BASE_URL}/api/links/${slug}`);
  if (!beforeClaimRes.ok) throw new Error(`link status before claim failed: ${beforeClaimRes.status}`);
  const beforeClaim = await beforeClaimRes.json();
  if (beforeClaim.recipientPublicKey !== null) {
    throw new Error(`expected an unclaimed request link to report recipientPublicKey: null, got ${beforeClaim.recipientPublicKey}`);
  }

  // Claim anonymously — no session required.
  const claimRes = await fetch(`${BASE_URL}/api/links/${slug}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipientPublicKey: b64(recipient.publicKey) }),
  });
  if (!claimRes.ok) throw new Error(`claim failed: ${claimRes.status} ${await claimRes.text()}`);
  console.log("claimed the request link anonymously");

  // A second claim attempt must be refused — a request link can only be claimed once.
  const reclaimRes = await fetch(`${BASE_URL}/api/links/${slug}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipientPublicKey: b64(nacl.box.keyPair().publicKey) }),
  });
  if (reclaimRes.status !== 409) {
    throw new Error(`expected a second claim to be refused with 409, got ${reclaimRes.status}`);
  }
  console.log("second claim attempt correctly refused (409)");

  const afterClaimRes = await fetch(`${BASE_URL}/api/links/${slug}`);
  if (!afterClaimRes.ok) throw new Error(`link status after claim failed: ${afterClaimRes.status}`);
  const afterClaim = await afterClaimRes.json();
  if (afterClaim.recipientPublicKey !== b64(recipient.publicKey)) {
    throw new Error("claimed recipientPublicKey does not match what the claimant sent");
  }

  // The initiator (authenticated, using their own account key) sends a message +
  // one file to the now-claimed recipient.
  const envelopes = buildSendEnvelopes({
    fileName: "request-flow.txt",
    fileBytes: textBytes(REQUEST_FLOW_PAYLOAD),
    message: REQUEST_FLOW_MESSAGE,
    recipientPublicKey: recipient.publicKey,
    senderSecretKey: initiator.secretKey,
  });
  const dropId = await uploadDrop(slug, envelopes, b64(initiator.publicKey), { Cookie: sessionCookie });
  console.log(`initiator sent drop ${dropId} to the claimed recipient`);

  // Receive side: the claimant (anonymous, no session) reads and decrypts everything.
  const statusRes = await fetch(`${BASE_URL}/api/links/${slug}`);
  if (!statusRes.ok) throw new Error(`link status for claimant failed: ${statusRes.status}`);
  const status = await statusRes.json();
  if (!status.drop) throw new Error("claimant's link status is missing the sent drop");

  const metadata = JSON.parse(
    new TextDecoder().decode(
      boxDecrypt(
        fromB64(status.drop.encryptedMetadata),
        fromB64(status.drop.metadataNonce),
        fromB64(status.drop.senderPublicKey),
        recipient.secretKey
      )
    )
  );
  if (metadata.files?.[0]?.name !== "request-flow.txt") {
    throw new Error(`unexpected metadata: ${JSON.stringify(metadata)}`);
  }

  const revealRes = await fetch(`${BASE_URL}/api/links/${slug}/drops/${dropId}/reveal-message`, { method: "POST" });
  if (!revealRes.ok) throw new Error(`reveal-message failed: ${revealRes.status}`);
  const { encryptedMessage, messageNonce } = await revealRes.json();
  const revealedMessage = new TextDecoder().decode(
    boxDecrypt(fromB64(encryptedMessage), fromB64(messageNonce), fromB64(status.drop.senderPublicKey), recipient.secretKey)
  );
  if (revealedMessage !== REQUEST_FLOW_MESSAGE) throw new Error(`unexpected revealed message: ${revealedMessage}`);
  console.log("claimed recipient revealed and decrypted the message");

  const downloadUrlRes = await fetch(`${BASE_URL}/api/links/${slug}/download-url?dropId=${encodeURIComponent(dropId)}`);
  if (!downloadUrlRes.ok) throw new Error(`download-url failed: ${downloadUrlRes.status}`);
  const info = await downloadUrlRes.json();
  assertPublicUrl("downloadUrl", info.downloadUrl);

  const fileRes = await fetch(info.downloadUrl);
  if (!fileRes.ok) throw new Error(`GET from storage failed: ${fileRes.status} ${await fileRes.text()}`);
  const downloadedBytes = new Uint8Array(await fileRes.arrayBuffer());
  const decrypted = boxDecrypt(downloadedBytes, fromB64(info.archiveNonce), fromB64(info.senderPublicKey), recipient.secretKey);
  const text = new TextDecoder().decode(decrypted);
  if (text !== REQUEST_FLOW_PAYLOAD) throw new Error(`unexpected content: ${text}`);
  console.log(`claimed recipient downloaded and decrypted the file (${downloadedBytes.length} encrypted bytes)`);

  const completeDownloadRes = await fetch(`${BASE_URL}/api/links/${slug}/drops/${dropId}/complete-download`, {
    method: "POST",
  });
  if (!completeDownloadRes.ok) throw new Error(`complete-download failed: ${completeDownloadRes.status}`);

  // The initiator/owner must never be granted receive-side access to their own
  // request link — that capability belongs solely to whoever claimed it (see
  // canReceive in apps/api/src/lib/links.ts).
  const ownerDownloadUrlRes = await fetch(
    `${BASE_URL}/api/links/${slug}/download-url?dropId=${encodeURIComponent(dropId)}`,
    { headers: { Cookie: sessionCookie } }
  );
  if (ownerDownloadUrlRes.status !== 403) {
    throw new Error(`expected the initiator/owner to be refused download-url with 403, got ${ownerDownloadUrlRes.status}`);
  }
  console.log("initiator/owner correctly refused receive-side download-url (403)");

  console.log("OK: sender-initiated request/claim/send/receive round-trip succeeded");
}

async function main() {
  await recipientInitiatedOneTimeLink();
  await senderInitiatedRequestFlow();
}

main().catch((err) => {
  console.error("VERIFICATION FAILED:", err);
  process.exit(1);
});
