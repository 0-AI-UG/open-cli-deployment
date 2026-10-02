import db from "./connection.ts";

export type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  webauthn_enabled: number;
  created_at: string;
  token_version: number;
};

export type WebAuthnCredential = {
  id: string;
  user_id: string;
  public_key: Buffer;
  counter: number;
  device_type: string;
  backed_up: number;
  transports: string;
  name: string;
  created_at: string;
};

export function getUserCount(): number {
  const row = db.query("SELECT COUNT(*) as count FROM users").get() as { count: number } | null;
  return row?.count ?? 0;
}

export function getUserByUsername(username: string): UserRow | null {
  return db.query("SELECT * FROM users WHERE username = ?").get(username) as UserRow | null;
}

export function getUserById(id: string): UserRow | null {
  return db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow | null;
}

export function getUsers(): UserRow[] {
  return db.query("SELECT id, username, webauthn_enabled, created_at FROM users ORDER BY created_at").all() as UserRow[];
}

export function insertUser(user: { id: string; username: string; password_hash: string }): void {
  db.query("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)").run(
    user.id, user.username, user.password_hash,
  );
}

export function updateUserPassword(id: string, passwordHash: string): void {
  db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, id);
}

export function deleteUser(id: string): void {
  db.query("DELETE FROM users WHERE id = ?").run(id);
}

export function insertWebAuthnCredential(data: {
  id: string;
  userId: string;
  publicKey: Uint8Array;
  counter: number;
  deviceType: string;
  backedUp: boolean;
  transports: string[];
  name: string;
}): void {
  db.query(
    "INSERT INTO webauthn_credentials (id, user_id, public_key, counter, device_type, backed_up, transports, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    data.id,
    data.userId,
    Buffer.from(data.publicKey),
    data.counter,
    data.deviceType,
    data.backedUp ? 1 : 0,
    JSON.stringify(data.transports),
    data.name,
  );
}

export function getWebAuthnCredentials(userId: string): WebAuthnCredential[] {
  return db.query("SELECT * FROM webauthn_credentials WHERE user_id = ?").all(userId) as WebAuthnCredential[];
}

export function getWebAuthnCredentialById(credentialId: string): WebAuthnCredential | null {
  return (db.query("SELECT * FROM webauthn_credentials WHERE id = ?").get(credentialId) as WebAuthnCredential) ?? null;
}

export function updateWebAuthnCounter(credentialId: string, counter: number): void {
  db.query("UPDATE webauthn_credentials SET counter = ? WHERE id = ?").run(counter, credentialId);
}

export function deleteWebAuthnCredential(credentialId: string): void {
  db.query("DELETE FROM webauthn_credentials WHERE id = ?").run(credentialId);
}

export function enableWebAuthn(userId: string): void {
  db.query("UPDATE users SET webauthn_enabled = 1 WHERE id = ?").run(userId);
}

export function disableWebAuthn(userId: string): void {
  db.query("UPDATE users SET webauthn_enabled = 0 WHERE id = ?").run(userId);
  db.query("DELETE FROM webauthn_credentials WHERE user_id = ?").run(userId);
}

export function getWebAuthnCredentialCount(userId: string): number {
  const row = db.query("SELECT COUNT(*) as count FROM webauthn_credentials WHERE user_id = ?").get(userId) as { count: number } | null;
  return row?.count ?? 0;
}

export function incrementTokenVersion(userId: string): void {
  db.run("UPDATE users SET token_version = token_version + 1 WHERE id = ?", [userId]);
}
