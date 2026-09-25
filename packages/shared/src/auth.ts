// packages/shared/src/auth.ts
export interface RegisterRequest {
  email: string;
  username: string;
  name: string;
  password: string; // sent once over TLS at registration only, never stored
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

export interface LoginRequest {
  email: string;
  password: string;
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
}

export interface PasswordResetRequestRequest {
  email: string;
}

export interface PasswordResetVerifyTokenResponse {
  email: string;
  passwordSalt: string;
  recoveryWrappedPrivateKey: string;
}

export interface PasswordResetCompleteRequest {
  token: string;
  newPassword: string; // plaintext, sent once over TLS — hashed server-side, same as registration
  newPasswordSalt: string;
  newPasswordWrappedPrivateKey: string;
}

export interface PasswordResetCompleteFreshRequest {
  token: string;
  newPassword: string; // plaintext, sent once over TLS — hashed server-side, same as registration
  newPasswordSalt: string;
  newPasswordWrappedPrivateKey: string;
  newRecoveryWrappedPrivateKey: string;
  newPublicKey: string;
}

export interface TotpSetupResponse {
  secretBase32: string;
  otpauthUrl: string;
}

export interface TotpEnableRequest {
  code: string;
}
