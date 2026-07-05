// Password hashing (PBKDF2 via Web Crypto — no external deps needed
// in the Workers runtime) and session token helpers.

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes.buffer;
}

export async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = saltHex ? hexToBuf(saltHex) : crypto.getRandomValues(new Uint8Array(16)).buffer;
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return { hash: bufToHex(derived), salt: bufToHex(salt) };
}

export async function verifyPassword(password, saltHex, expectedHashHex) {
  const { hash } = await hashPassword(password, saltHex);
  return hash === expectedHashHex;
}

export function generateToken() {
  return bufToHex(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

export async function createSession(db, userId, days = 7) {
  const token = generateToken();
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  await db
    .prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(token, userId, expires)
    .run();
  return { token, expires };
}

export async function getSessionUser(db, token) {
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT u.id, u.company_id, u.employee_id, u.email, u.role, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .bind(token)
    .first();
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    await db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
    return null;
  }
  return row;
}

export function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function sessionCookie(token, days = 7) {
  const maxAge = days * 24 * 60 * 60;
  return `session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookie() {
  return `session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// Haversine distance in meters, used to verify a check-in falls
// inside the company's office geofence.
export function distanceMeters(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => v === null || v === undefined)) return null;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
