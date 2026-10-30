// The kiosk's server. All /api/* requests land here.
import { getJSON, setJSON } from "../lib/store.mjs";
import {
  randomToken, sha256, hashPin, checkPin, makeAdminSession, verifyAdminSession,
  lockedFor, recordFailure, clearFailures,
} from "../lib/security.mjs";
import * as hw from "../lib/homeworks.mjs";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const redirect = (url) => new Response(null, { status: 302, headers: { Location: url } });

const getConfig = async () => {
  const c = await getJSON("config", {});
  return { adminPin: null, pins: {}, devices: [], ...c };
};
const saveConfig = (c) => setJSON("config", c);

const TRIVIAL = new Set(["0000", "1111", "2222", "3333", "4444", "5555", "6666", "7777", "8888", "9999", "1234", "4321", "1212", "2580", "0852"]);
function newPin(taken) {
  for (;;) {
    const p = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
    if (!TRIVIAL.has(p) && !taken.has(p)) return p;
  }
}

async function addFlag(flag) {
  const flags = await getJSON("flags", []);
  flags.unshift({ id: randomToken(6), at: new Date().toISOString(), ...flag });
  await setJSON("flags", flags.slice(0, 200));
}

// ---------- kiosk (shop tablet) ----------

async function kioskDevice(req) {
  const token = req.headers.get("x-device-token");
  if (!token) return null;
  const cfg = await getConfig();
  return cfg.devices.find((d) => d.hash === sha256(token)) || null;
}

async function findByPin(pin, deviceId) {
  const wait = await lockedFor(`device:${deviceId}`);
  if (wait) return { error: `Too many wrong PINs. Try again in ${wait} seconds.`, status: 429 };
  const cfg = await getConfig();
  const hit = Object.entries(cfg.pins).find(([, v]) => v.pin === String(pin));
  if (!hit) {
    await recordFailure(`device:${deviceId}`);
    return { error: "PIN not recognized.", status: 401 };
  }
  await clearFailures(`device:${deviceId}`);
  return { userId: Number(hit[0]), name: hit[1].name };
}

async function kiosk(req, path) {
  const device = await kioskDevice(req);
  if (!device) return json({ error: "This device isn't set up as the shop clock.", notSetUp: true }, 403);
  const body = await req.json().catch(() => ({}));

  if (path === "kiosk/check") return json({ ok: true, label: device.label });

  const who = await findByPin(body.pin, device.id);
  if (who.error) return json({ error: who.error }, who.status);

  if (path === "kiosk/lookup") {
    const since = await hw.clockedInSince(who.userId);
    return json({ name: who.name, clockedIn: !!since, since });
  }

  if (path === "kiosk/clock") {
    if (body.action === "in") {
      const r = await hw.clockIn(who.userId);
      return json({ ok: true, name: who.name, action: "in", already: !r, at: r?.createdAt || new Date().toISOString() });
    }
    if (body.action === "out") {
      const r = await hw.clockOut(who.userId);
      if (!r) return json({ ok: true, name: who.name, action: "out", already: true });
      let lunch = null;
      if (body.lunch) {
        try {
          lunch = await hw.deductLunch(who.userId, r.createdAt);
        } catch (err) {
          lunch = { ok: false, reason: err.message };
        }
        if (!lunch.ok) await addFlag({ userId: who.userId, name: who.name, kind: "lunch", reason: lunch.reason });
      }
      return json({ ok: true, name: who.name, action: "out", at: r.createdAt, lunch });
    }
    return json({ error: "Unknown action." }, 400);
  }
  return json({ error: "Not found." }, 404);
}

// ---------- admin ----------

async function admin(req, path) {
  if (path === "admin/status") {
    const cfg = await getConfig();
    return json({ hasAdminPin: !!cfg.adminPin, homeworks: await hw.connectionStatus() });
  }

  if (path === "admin/login") {
    const { pin } = await req.json().catch(() => ({}));
    const wait = await lockedFor("admin");
    if (wait) return json({ error: `Too many tries. Wait ${wait} seconds.` }, 429);
    const cfg = await getConfig();
    if (!cfg.adminPin || !checkPin(pin, cfg.adminPin)) {
      await recordFailure("admin");
      return json({ error: "Wrong admin PIN." }, 401);
    }
    await clearFailures("admin");
    return json({ session: await makeAdminSession() });
  }

  // Everything below needs a signed-in admin.
  const session = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
  if (!(await verifyAdminSession(session))) return json({ error: "Please sign in again.", signedOut: true }, 401);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const cfg = await getConfig();

  switch (path) {
    case "admin/set-admin-pin": {
      if (!/^\d{4,8}$/.test(String(body.pin))) return json({ error: "Admin PIN must be 4–8 digits." }, 400);
      if (Object.values(cfg.pins).some((p) => p.pin === String(body.pin))) return json({ error: "That PIN belongs to an employee. Pick another." }, 400);
      cfg.adminPin = hashPin(body.pin);
      await saveConfig(cfg);
      return json({ ok: true });
    }

    case "admin/employees": {
      const people = await hw.listEmployees();
      // Keep stored names in sync with Homeworks.
      let changed = false;
      for (const p of people) if (cfg.pins[p.id] && cfg.pins[p.id].name !== p.name) { cfg.pins[p.id].name = p.name; changed = true; }
      if (changed) await saveConfig(cfg);
      return json({ employees: people.map((p) => ({ ...p, pin: cfg.pins[p.id]?.pin || "" })) });
    }

    case "admin/set-pin": {
      const id = Number(body.userId);
      const pin = String(body.pin ?? "").trim();
      if (!id) return json({ error: "Missing employee." }, 400);
      if (pin === "") {
        delete cfg.pins[id];
      } else {
        if (!/^\d{4}$/.test(pin)) return json({ error: "PIN must be exactly 4 digits." }, 400);
        const clash = Object.entries(cfg.pins).find(([uid, v]) => v.pin === pin && Number(uid) !== id);
        if (clash) return json({ error: `${clash[1].name} already uses that PIN.` }, 400);
        if (cfg.adminPin && checkPin(pin, cfg.adminPin)) return json({ error: "That's the admin PIN. Pick another." }, 400);
        cfg.pins[id] = { pin, name: body.name || cfg.pins[id]?.name || `User ${id}` };
      }
      await saveConfig(cfg);
      return json({ ok: true });
    }

    case "admin/generate-pins": {
      const people = await hw.listEmployees();
      const taken = new Set(Object.values(cfg.pins).map((p) => p.pin));
      let made = 0;
      for (const p of people) {
        if (p.role === "OWNER" || cfg.pins[p.id]) continue;
        let pin = newPin(taken);
        while (cfg.adminPin && checkPin(pin, cfg.adminPin)) pin = newPin(taken);
        taken.add(pin);
        cfg.pins[p.id] = { pin, name: p.name };
        made++;
      }
      await saveConfig(cfg);
      return json({ ok: true, made });
    }

    case "admin/devices":
      return json({ devices: cfg.devices.map(({ id, label, addedAt }) => ({ id, label, addedAt })) });

    case "admin/add-device": {
      const token = randomToken(32);
      const device = { id: randomToken(6), label: String(body.label || "Shop tablet").slice(0, 40), hash: sha256(token), addedAt: new Date().toISOString() };
      cfg.devices.push(device);
      await saveConfig(cfg);
      return json({ ok: true, token, id: device.id });
    }

    case "admin/remove-device":
      cfg.devices = cfg.devices.filter((d) => d.id !== body.id);
      await saveConfig(cfg);
      return json({ ok: true });

    case "admin/flags":
      return json({ flags: await getJSON("flags", []) });

    case "admin/dismiss-flag": {
      const flags = await getJSON("flags", []);
      await setJSON("flags", flags.filter((f) => f.id !== body.id));
      return json({ ok: true });
    }
  }
  return json({ error: "Not found." }, 404);
}

// ---------- OAuth ----------

async function oauth(req, path, url) {
  if (path === "oauth/start") return redirect(await hw.startAuth(url.origin));
  if (path === "oauth/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const back = (params) => redirect(`${url.origin}/admin.html#${new URLSearchParams(params)}`);
    if (!code) return back({ error: url.searchParams.get("error_description") || url.searchParams.get("error") || "Homeworks didn't approve the connection." });
    const r = await hw.finishAuth(code, state);
    if (!r.ok) return back({ error: r.error });
    // Logging in to Homeworks as the owner also signs you in to the admin screen.
    return back({ connected: "1", session: await makeAdminSession() });
  }
  return json({ error: "Not found." }, 404);
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\//, "").replace(/\/$/, "");
  try {
    if (path.startsWith("kiosk/")) return await kiosk(req, path);
    if (path.startsWith("admin/")) return await admin(req, path);
    if (path.startsWith("oauth/")) return await oauth(req, path, url);
    return json({ error: "Not found." }, 404);
  } catch (err) {
    if (err instanceof hw.NotConnectedError) return json({ error: err.message, notConnected: true }, 503);
    console.error(err);
    return json({ error: err.message || "Something went wrong." }, 500);
  }
};

export const config = { path: "/api/*" };
