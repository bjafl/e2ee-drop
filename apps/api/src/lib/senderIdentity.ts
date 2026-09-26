//
// Design spec §3.2: Drop.senderUserId (set below in uploads.ts when a session is present) has no
// cryptographic binding to Drop.senderPublicKey on its own — nacl.box authenticates the
// ciphertext against whatever key is CLAIMED, not against any particular account. Without this
// check, a divergent senderPublicKey/senderUserId pair would let the inbox (spec 5) display a
// different account's name than the one that actually produced the ciphertext. Anonymous senders
// (no session) make no identity claim at all, so nothing to check.
export class SenderIdentityMismatchError extends Error {
  constructor() {
    super("senderPublicKey does not match the authenticated account's public key");
  }
}

export function assertSenderIdentity(
  user: { publicKey: string } | null,
  claimedPublicKey: string
): void {
  if (user && user.publicKey !== claimedPublicKey) {
    throw new SenderIdentityMismatchError();
  }
}
