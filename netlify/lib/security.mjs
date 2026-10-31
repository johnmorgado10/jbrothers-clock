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

// Lockout after too many wrong PINs. key = "admin", a device id, or a phone connection.
const DEFAULT_LIMIT = { max: 5, lockMs: 60_000 };

export async function lockedFor(key) {
  const l = (await getJSON("lockouts", {}))[key];
  return l && l.until > Date.now() ? Math.ceil((l.until - Date.now()) / 1000) : 0;
}

// windowMs: failures older than this are forgotten (so a slow trickle never locks).
export async function recordFailure(key, { max, lockMs, windowMs } = DEFAULT_LIMIT) {
  max = max || DEFAULT_LIMIT.max;
  lockMs = lockMs || DEFAULT_LIMIT.lockMs;
  windowMs = windowMs || 15 * 60_000;
  const all = await getJSON("lockouts", {});
  const prev = all[key];
  const stale = !prev || (prev.until && prev.until <= Date.now()) || (prev.first && Date.now() - prev.first > windowMs);
  const l = stale ? { count: 0, until: 0, first: Date.now() } : prev;
  l.count += 1;
  if (l.count >= max) {
    l.until = Date.now() + lockMs;
    l.count = 0;
    l.first = Date.now();
  }
  all[key] = l;
  // Drop old records so this list never grows forever.
  for (const [k, v] of Object.entries(all)) if (v.until < Date.now() && Date.now() - (v.first || 0) > windowMs) delete all[k];
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
