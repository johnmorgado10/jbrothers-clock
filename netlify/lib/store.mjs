// Tiny wrapper around Netlify Blobs so the rest of the code just reads/writes JSON.
// Everything the kiosk remembers (Homeworks login, PINs, tablets, flags) lives here.
import { getStore } from "@netlify/blobs";

let store;
function s() {
  if (globalThis.__TEST_STORE__) return globalThis.__TEST_STORE__;
  if (!store) store = getStore({ name: "kiosk", consistency: "strong" });
  return store;
}

export async function getJSON(key, fallback = null) {
  const v = await s().get(key, { type: "json" });
  return v ?? fallback;
}

export async function setJSON(key, value) {
  await s().setJSON(key, value);
}

export async function del(key) {
  await s().delete(key);
}
