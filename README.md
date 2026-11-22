# airdrop.harsath.com

Encrypted file drop between your own devices, in both directions, with any number of devices in a room. Built for moving files between a locked-down corporate VM and a personal laptop.

Files are encrypted in the browser, stored on Supabase as ciphertext, and deleted after 3 hours. The receiving device doesn't need to be online when you send. Everything goes over HTTPS/WSS on port 443, which is the traffic corporate firewalls most often allow.

## How it works

```
 sender browser                       Supabase (free tier)                  receiver browser
 ──────────────                       ────────────────────                  ────────────────
 anonymous sign-in ────────────────► Auth ◄──────────────────────────────── anonymous sign-in
 join room (RPC) ──────────────────► Postgres + row-level security ◄─────── join room (RPC)
 subscribe room:<id> ──────────────► Realtime (presence + broadcast) ◄───── subscribe room:<id>
 encrypt (AES-GCM)
 resumable upload (tus) ───────────► Storage  drops/<room>/<file>
 insert files row ─────────────────► Postgres ── trigger ── broadcast ─────► list updates
                                                                            download ◄── Storage
                                                                            decrypt, save
                                     pg_cron every 10 min ─► cleanup Edge Function
```

- **Auth:** anonymous sign-ins give each browser a user ID with no account.
- **Postgres:** `rooms`, `room_members`, `files`. Every access rule (tables, storage objects, realtime channels) checks that `auth.uid()` is a member of the room.
- **Storage:** private bucket `drops`, 50 MB per file, uploads via the tus resumable protocol in 6 MB chunks.
- **Realtime:** a private channel per room. Presence shows who's online; a database trigger broadcasts `file_added` / `file_claimed` / `file_removed`.
- **Cleanup:** `pg_cron` deletes expired rows every 10 minutes and calls the `cleanup` Edge Function, which deletes the matching storage objects (they can only be deleted through the Storage API).
- **Hosting:** static files on GitHub Pages. A daily GitHub Action pings the database so the free project doesn't pause.

### Rooms and encryption

| | Link room | Password room |
|---|---|---|
| URL | `/#<22-char key>` | `/#p/<10-char id>` |
| Who can join | anyone with the link | anyone with the link **and** the password |
| Encryption key | HKDF of the key in the link | PBKDF2 (600k rounds) of the password, then HKDF |
| What the server stores | room id = one-way hash of the key | salt + bcrypt of a separate password proof |

The part of a URL after `#` is never sent to any server. The server sees file sizes, times and anonymous uploader IDs, never names, contents, keys or passwords. Wrong passwords are limited to 5 per 15 minutes per browser.

### Burn after read

A per-file checkbox. The first member to download it claims it atomically (`claim_file`); from then on only they can read the object, it disappears from everyone else's list, and it's deleted right after their download (or within 15 minutes by cleanup if the download fails).

## Files

| Path | Purpose |
|---|---|
| `index.html` | UI and styles |
| `app.js` | rooms, upload/download, realtime, UI logic |
| `crypto.js` | all key derivation and encryption (WebCrypto) |
| `supabase/migrations/0001_init.sql` | tables, access rules, bucket, triggers, cron job |
| `supabase/functions/cleanup/index.ts` | Edge Function that deletes dead storage objects |
| `.github/workflows/keepalive.yml` | daily ping so the free project doesn't pause |
| `explore/` | throwaway learning scripts (the old WebRTC versions and the Supabase reachability probe) |

## Setup (one time)

1. **Create a Supabase project** and enable **Authentication → Sign In / Providers → Allow anonymous sign-ins**.
2. **Database:** paste `supabase/migrations/0001_init.sql` into **SQL Editor** and run it. It is safe to re-run.
3. **Edge Function:** **Edge Functions → Deploy a new function → Via Editor**, name it `cleanup`, paste `supabase/functions/cleanup/index.ts`, deploy. Then open the function's **Details** and turn **Verify JWT** off (the cron job calls it without a token; it only deletes objects the database already marked dead).
   With the CLI instead: `supabase functions deploy cleanup --no-verify-jwt --project-ref <ref>`.
4. Put the project URL and publishable key at the top of `app.js` (and in the keep-alive workflow and the cron job URL in the migration).

## Run locally

```
python3 -m http.server 8000
```

Open `http://localhost:8000` in two browsers (or a normal and a private window, so they get different anonymous users).

## Deploy

Push to the default branch; GitHub Pages serves it. Keep the `CNAME` file for the custom domain.

## Free-tier limits

- 50 MB per file, 1 GB total storage (3-hour expiry keeps usage low).
- 5 GB egress per month; every download counts, uploads don't.
- 200 concurrent realtime connections, 2M messages per month (only small notices go through Realtime).
- The project pauses after about a week of no activity; the keep-alive workflow prevents that. GitHub disables scheduled workflows in repos with no commits for 60 days, so re-enable it in the Actions tab if that happens.
- Files are held in memory while encrypting and decrypting, which is fine at 50 MB.
