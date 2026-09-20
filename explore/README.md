# explore/ — play with each part in isolation

Three standalone scripts to understand the moving parts before they're stitched together. Order matters: 1 → 2 → 3.

## 1. metered (TURN credentials)

Pure HTTPS request. No WebRTC. See exactly what metered hands back.

```
node explore/1-metered.mjs
```

Look at: STUN vs TURN entries, the short-lived credentials, the firewall-friendly ports (80/443, TCP fallback).

## 2. trystero (signaling + discovery)

Trystero on its own — finds peers in a room over BitTorrent trackers and opens a data channel. Uses default public STUN (no TURN).

```
python3 -m http.server 8000
# open http://localhost:8000/explore/2-trystero.html in TWO tabs
```

Do: click Join in both tabs (same room), watch one tab log `PEER JOINED`, then send messages between them.

Look at: `selfId` differs per tab; `onPeerJoin` fires only after the full handshake; messages travel peer-to-peer, not through any server you run.

## 3. merged (TURN + Trystero + a real file)

The actual stitch: fetch metered's ICE servers (part 1) and pass them into Trystero (part 2) via `rtcConfig`. Then send a file and inspect the connection.

```
python3 -m http.server 8000
# open http://localhost:8000/explore/3-merged.html in TWO tabs
```

Do:
1. Join in both tabs, send a file from one, download in the other.
2. Click **Inspect connection** — it reads WebRTC's own stats and tells you `DIRECT` or `RELAY (TURN)`.
3. Tick **force TURN** before joining to prove the relay path works even locally (`iceTransportPolicy: 'relay'`).

Look at: on the same machine you'll normally see `DIRECT` (host candidates win). Force TURN, or test laptop↔corporate VM, to see `RELAY`.

## Notes

- Serve over HTTP, not `file://` — ES modules, `fetch`, and clipboard need a real origin.
- DevTools → Network → WS shows the live tracker messages (the JSON from `docs/tracker-protocol.md`).
- These are throwaway learning scripts, separate from the real app (`../index.html`, `../app.js`).
