// Secrets, hashing, signed admin sessions, and wrong-PIN lockouts.
import crypto from "node:crypto";
import { getJSON, setJSON } from "./store.mjs";

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// One random secret per site, created the first time it's needed.
async function siteSecret() {
  let secret = await getJSON("secret");
  if (!secret) {
    secret = { value: randomToken(48) };
    await setJSON("secret", secret);
  }
  return secret.value;
}

export function hashPin(pin, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(pin), salt, 32).toString("hex");
  return { salt, hash };
}

export function checkPin(pin, stored) {
  if (!stored) return false;
  const { hash } = hashPin(pin, stored.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(stored.hash, "hex"));
}

// Admin session = "expiry.signature", signed with the site secret.
export async function makeAdminSession(hours = 12) {
  const exp = Date.now() + hours * 3600_000;
  const sig = crypto.createHmac("sha256", await siteSecret()).update(`admin|${exp}`).digest("base64url");
  return `${exp}.${sig}`;
}

export async function verifyAdminSession(token) {
  if (!token || !token.includes(".")) return false;
  const [expStr, sig] = token.split(".");
  const exp = Number(expStr);
  if (!exp || exp < Date.now()) return false;
  const good = crypto.createHmac("sha256", await siteSecret()).update(`admin|${exp}`).digest("base64url");
  return good.length === sig.length && crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig));
}

// Lockout after too many wrong PINs. key = "admin" or a device id.
const MAX_TRIES = 5;
const LOCK_MS = 60_000;

export async function lockedFor(key) {
  const l = (await getJSON("lockouts", {}))[key];
  return l && l.until > Date.now() ? Math.ceil((l.until - Date.now()) / 1000) : 0;
}

export async function recordFailure(key) {
  const all = await getJSON("lockouts", {});
  const prev = all[key];
  // Start fresh if there's no record or an old lockout has expired.
  const l = !prev || (prev.until && prev.until <= Date.now()) ? { count: 0, until: 0 } : prev;
  l.count += 1;
  if (l.count >= MAX_TRIES) {
    l.until = Date.now() + LOCK_MS;
    l.count = 0;
  }
  all[key] = l;
  await setJSON("lockouts", all);
}

export async function clearFailures(key) {
  const all = await getJSON("lockouts", {});
  if (all[key]) {
    delete all[key];
    await setJSON("lockouts", all);
  }
}
