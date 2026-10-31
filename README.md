# J-Brothers Shop Clock

A PIN-pad time clock for the shop tablet. Crew members type a 4-digit PIN to clock their
Homeworks global timer in or out. At clock-out it asks "Did you take lunch?" A yes takes
30 minutes out of the middle of their longest stretch of the day. Their clock-in and
clock-out times stay as punched.

## Pages
- `/` is the clock. On the shop tablet (set up from the admin screen) it does clock in and clock out.
  On any other device, such as a crew member's phone, it only does clock out. Clocking in has to happen at the shop.
- `/admin.html` is the admin screen: Homeworks connection, employee PINs, the shop tablet, and anything that needs attention.
- `/payroll.html` is behind the admin PIN. It shows weekly pay (Monday–Sunday weeks, paid the next Thursday):
  daily in/out/lunch/hours, 4-decimal totals, the Homeworks profile rate, rounded pay, check words, review flags,
  print pages, crew averages, and year-to-date totals starting in 2027.

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
The clock-in and clock-out times always stay as punched. The 30 minutes come out of the middle of entries:
- **Normal day:** one 30-minute gap in the middle of the longest entry (job timer or shop/drive time), if it's 45+ minutes.
- **Choppy day** (no single entry that long): the 30 minutes are spread across the longest entries, e.g. 15 + 15. At least 10 minutes of each entry is always left in place.
- **Not enough time on the clock** (a day under about 40 minutes): nothing is changed, and it shows on the admin screen under "Needs attention."

## Phone clock-out safety
Phones can't clock in (the server refuses). Wrong PINs lock a phone/connection out for 5 minutes after 5 tries,
and 25 wrong tries across all phones pause phone lookups for 10 minutes. The shop tablet is never affected.

## Test
`node test/run.mjs` (clock, admin, phones) and `node test/payroll.mjs` (payroll math, including daylight-saving weeks)
run against a fake Homeworks.
This needs `node_modules/@netlify/blobs` to exist, but the test doesn't use it.
