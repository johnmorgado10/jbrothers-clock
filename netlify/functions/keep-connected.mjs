// Runs once a day so the Homeworks connection never sits unused long enough to expire
// (its renewal pass lasts 14 days and is replaced every time it's used).
import { getAccessToken, connectionStatus } from "../lib/homeworks.mjs";

export default async () => {
  const status = await connectionStatus();
  if (!status.connected) {
    console.log("Homeworks not connected; nothing to refresh.");
    return;
  }
  await getAccessToken({ force: true });
  console.log("Homeworks connection refreshed.");
};

export const config = { schedule: "@daily" };
