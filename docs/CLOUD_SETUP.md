# Cloud saves and leaderboards (Supabase)

The game saves progress in the browser first. The cloud part is optional: it adds a backup copy of the save and
four online leaderboards (World Tour ranking points, player level, longest win streak, fastest serve). It stays
switched off until `cloud.enabled` is `true` in `src/config.js`. While it is off, the game makes no cloud requests
and the Leaderboards button is hidden.

## 1. Create the tables (once)
1. Open your project in the Supabase dashboard.
2. Go to **SQL Editor**, click **New query**, paste all of `supabase/schema.sql`, and click **Run**.
   You can run it again after the file changes. It keeps existing data.

## 2. Turn on anonymous sign-in
**Authentication → Sign In / Providers**: turn on **Allow anonymous sign-ins** and save.
Players get an anonymous account per browser. No email or password is needed.

## 3. Limit abuse (recommended)
- **Authentication → Rate Limits**: lower the limit for anonymous sign-ins, for example 30 per hour per IP.
- CAPTCHA (**Authentication → Attack Protection**): leave it off for now. The game doesn't show a CAPTCHA widget
  yet, so turning it on would block cloud sign-in. The game would keep working, but only locally.
- The database checks every score itself. It rejects impossible values, caps the rest, limits how fast a
  score can grow, and limits how often a player can submit. You can tune these limits in the `boards` table.
  Because of the growth limit, a player who already has a lot of progress when you turn the cloud on climbs
  to their real place over a few sessions.

## 4. Test before you switch it on
- Open the live game (the `/play/` page) with `?cloud=1` added to the address. This turns the cloud on for that visit only.
  A **Leaderboards** button appears in the main menu.
- Play one match, then open Leaderboards and set a name.
- In the dashboard, check **Table Editor**: you should see a row in `saves`, rows in `scores` and one in `players`.
- In the browser console, `PalmCourt.Cloud.status` should say `ok`. `await PalmCourt.Cloud.sync()` syncs straight away.

## 5. Switch it on
In `src/config.js`, set `cloud: { url: …, anonKey: …, enabled: true }` and publish.
To switch it off again, set `enabled: false`. Your data stays in Supabase. To turn it off for a single visit,
add `?cloud=0` to the address.

## Keys
`src/config.js` holds the project URL and the **publishable** key (`sb_publishable_…`). That key is made for
browser code. Never put the secret or `service_role` key in this repo or in the game. If `config.js` holds a secret
key, the game refuses to use it.

## What is stored
- `saves`: one save per anonymous account. Only that account can read or write it.
- `scores`, `players`: leaderboard values and display names. These are written only through the database functions.
- Display names are 3 to 16 characters: letters, numbers, spaces and `-` `_` `'`. Emails, links and a list of
  rude words are refused. Anyone can read the boards. User ids are never shown.
- To delete a player's data, delete the user under **Authentication → Users**. Their rows are deleted with it.

A cloud save belongs to one browser's anonymous account. The game can't move progress to another device yet.
That would need an email to be linked to the account, which could be added later.

## Testing without Supabase
- Unit tests: `node test/cloud.test.mjs`
- Local mock server: run `node test/cloud-mock.mjs 8907`, then open
  `http://localhost:8765/play/?cloud=1&cloudUrl=http://127.0.0.1:8907`.
  `cloudUrl` only accepts localhost addresses.
