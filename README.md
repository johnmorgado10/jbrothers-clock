# J-Brothers Shop Clock

A PIN-pad time clock for the shop tablet. Crew members type a 4-digit PIN to clock their
Homeworks global timer in or out. At clock-out it asks "Did you take lunch?" A yes takes
30 minutes out of the middle of their longest stretch of the day. Their clock-in and
clock-out times stay as punched.

## Pages
- `/` is the kiosk. It only works on a device you've set up from the admin screen.
- `/admin.html` is the admin screen: Homeworks connection, employee PINs, the shop tablet, and anything that needs attention.

## First-time setup
1. Open `/admin.html` and tap **Connect Homeworks**. Log in with the **owner** account and approve.
2. Pick an admin PIN.
3. Tap **Make PINs for everyone who doesn't have one**, or type PINs in yourself.
4. On the shop tablet, open `/admin.html`, sign in, and tap **Make this device the shop clock**.
   Then add the clock to the home screen (Share → Add to Home Screen) so it opens full-screen.

## How it works
- `netlify/functions/api.mjs` is the server for everything under `/api/*`.
- `netlify/lib/homeworks.mjs` handles the Homeworks login (OAuth with PKCE), `clockInUser` / `clockOutUser`, and the lunch split.
- `netlify/functions/keep-connected.mjs` renews the Homeworks connection daily so it doesn't expire.
  The renewal pass lasts 14 days and is replaced each time it's used.
- Everything the kiosk remembers lives in Netlify Blobs (store `kiosk`), not in the code.

## Lunch rule
The 30 minutes come out of the middle of the longest single time entry (job timer or shop/drive
time) from the shift that just ended, as long as it's at least 45 minutes. If there's no such
entry, the admin screen shows it under "Needs attention" so it can be fixed by hand in Homeworks.

## Test
`node test/run.mjs` runs the logic against a fake Homeworks.
This needs `node_modules/@netlify/blobs` to exist, but the test doesn't use it.
