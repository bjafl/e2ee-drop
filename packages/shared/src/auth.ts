// packages/shared/src/auth.ts
export interface RegisterRequest {
  email: string;
  username: string;
  name: string;
  // Argon2id(password, sha256(passwordSalt ++ "e2ee-drop-auth-key-v1")),
  // computed client-side (deriveAuthKey). Never the plaintext password: the
  // server must not be able to derive the wrapping key, which uses the same
  // password with the raw passwordSalt as its Argon2id salt.
  authKey: string;
  passwordSalt: string; // base64, client-generated wrapping-KDF salt
  passwordWrappedPrivateKey: string; // base64
  recoveryWrappedPrivateKey: string; // base64
  publicKey: string; // base64
}

export interface RegisterResponse {
  userId: string;
  username: string;
  defaultLinkSlug: string;
}

export interface PreloginRequest {
  email: string;
}

// For an unregistered email, passwordSalt is a deterministic fake of the
// same shape as a real one, so this endpoint can't enumerate accounts.
export interface PreloginResponse {
  passwordSalt: string;
}

export interface LoginRequest {
  email: string;
  authKey: string; // see RegisterRequest.authKey
  totpCode?: string;
}

export interface LoginResponse {
  userId: string;
  username: string;
  name: string;
  email: string;
  emailVerified: boolean;
  publicKey: string;
  passwordSalt: string;
  passwordWrappedPrivateKey: string;
  totpEnabled: boolean;
  requiresTotp?: boolean;
}

export interface MeResponse {
  userId: string;
  username: string;
  name: string;
  email: string;
  emailVerified: boolean;
  publicKey: string;
  passwordSalt: string;
  passwordWrappedPrivateKey: string;
  totpEnabled: boolean;
  allowContactRequests: boolean;
}

export interface PasswordResetRequestRequest {
  email: string;
}

// Identical for every caller regardless of whether the email is registered
// (so it can't enumerate accounts). emailDeliveryAvailable is a property of
// the server instance only — whether a mailer is configured at all — so the
// UI can avoid claiming "check your email" when no email can ever be sent.
export interface PasswordResetRequestResponse {
  requested: true;
  emailDeliveryAvailable: boolean;
}

// Returned by both the registration side-effect (implicitly, via RegisterResponse
// being unchanged) and by /api/auth/verify-email/resend. Mirrors
// PasswordResetRequestResponse's emailDeliveryAvailable pattern: whether an email
// could actually be sent depends only on server SMTP configuration, never on
// anything about the specific account, so it's safe to expose unconditionally.
export interface EmailVerificationResendResponse {
  sent: true;
  emailDeliveryAvailable: boolean;
}

export interface PasswordResetVerifyTokenResponse {
  email: string;
  passwordSalt: string;
  recoveryWrappedPrivateKey: string;
  // When true, /complete and /complete-fresh require a current totpCode —
  // an emailed reset token alone must not bypass the account's 2FA.
  totpEnabled: boolean;
}

export interface PasswordResetCompleteRequest {
  token: string;
  newAuthKey: string; // deriveAuthKey(newPassword, newPasswordSalt) — never the plaintext password
  newPasswordSalt: string;
  newPasswordWrappedPrivateKey: string;
  totpCode?: string; // required iff the account has totpEnabled (see PasswordResetVerifyTokenResponse)
}

export interface PasswordResetCompleteFreshRequest {
  token: string;
  newAuthKey: string; // deriveAuthKey(newPassword, newPasswordSalt) — never the plaintext password
  newPasswordSalt: string;
  newPasswordWrappedPrivateKey: string;
  newRecoveryWrappedPrivateKey: string;
  newPublicKey: string;
  totpCode?: string; // required iff the account has totpEnabled (see PasswordResetVerifyTokenResponse)
}

export interface TotpSetupResponse {
  secretBase32: string;
  otpauthUrl: string;
}

// POST /api/auth/2fa/backup-codes/regenerate response, and also returned inline
// (as the `backupCodes` field) by /api/auth/2fa/enable's own success response,
// so enabling 2FA doesn't need a second round-trip to see the initial batch.
// Plaintext codes exist only in this one response body, never again.
export interface TotpBackupCodesResponse {
  backupCodes: string[]; // e.g. ["a3f9k-7h2mq", ...] — exactly 10 entries
}

export interface TotpEnableRequest {
  code: string;
}

// Response to POST /api/auth/2fa/enable merges these fields with TotpBackupCodesResponse.
export interface TotpEnableResponse extends TotpBackupCodesResponse {
  enabled: true;
}
