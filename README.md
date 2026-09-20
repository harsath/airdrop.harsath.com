# airdrop.harsath.com

Peer-to-peer, bidirectional file transfer in the browser. No backend and no central storage — files travel directly between browsers over a WebRTC data channel. The site itself is fully static.

Built for moving files between a corporate VM (locked-down firewall) and a personal laptop, in both directions, with more than two participants supported.

## How it works

- **Signaling** — [Trystero](https://github.com/dmotz/trystero) exchanges the WebRTC handshake over public BitTorrent trackers, so no signaling server is needed.
- **Relay when direct fails** — a free [metered.ca](https://www.metered.ca/) TURN server relays the encrypted stream when a direct peer-to-peer path is blocked (e.g. strict corporate firewalls). On a permissive network (same LAN), the transfer goes direct and touches no server at all.
- **Hosting** — static files on GitHub Pages.

A room is identified by the URL hash (`#roomid`), which is generated on first visit. Share the full URL; anyone who opens it joins the same room.

### The handshake, in detail

Two browsers behind NAT can't address each other directly. Three roles solve this, and they are easy to confuse because they all happen at connection setup:

- **Signaling (the tracker)** — a public WebTorrent WebSocket tracker acts as a note-passer. Both peers announce the same infohash (derived from the app ID + room ID) and the tracker relays each peer's WebRTC session description to the other over a persistent WebSocket. It never reads or forwards the file bytes; it only brokers the introduction.
- **STUN** — a separate server that tells a peer its own public IP and port as seen from the outside (the address its NAT maps its local UDP socket to). This becomes a reachable candidate that the other peer can target.
- **TURN** — a relay used only when a direct path can't be established (e.g. symmetric NAT on a corporate network). Both peers send to the TURN server's fixed address and it forwards between them.

The **ICE agent** built into each browser orchestrates all of this: it gathers candidate addresses (local, STUN-discovered public, and TURN relay), exchanges them inside the SDP via the tracker, tests every candidate pair, and keeps the first one that works. Once the data channel is open, the tracker and STUN are no longer involved; TURN stays in the path only if it was the winning route.

```mermaid
sequenceDiagram
    participant A as Peer A (browser)
    participant T as WebTorrent tracker
    participant S as STUN server
    participant B as Peer B (browser)

    Note over A,B: Both share infohash = hash(appId + roomId)

    A->>S: STUN request (from UDP socket)
    S-->>A: your public addr = 203.0.113.5:44321
    A->>A: createOffer() -> SDP (embeds candidates)
    A->>T: announce(infohash, offers:[{offer_id, sdp}])

    Note over B: B opens the #room link
    B->>S: STUN request
    S-->>B: your public addr = 198.51.100.9:55200
    B->>T: announce(infohash)
    T-->>B: push A's offer {offer_id, sdp}
    B->>B: createAnswer() -> SDP
    B->>T: announce(answer, offer_id)
    T-->>A: push B's answer {offer_id, sdp}

    Note over A,B: ICE connectivity checks (direct UDP)
    A->>B: STUN check -> 198.51.100.9:55200
    B->>A: STUN check -> 203.0.113.5:44321
    Note over A,B: Winning candidate pair chosen
    A-->>B: DataChannel open — file bytes flow peer-to-peer
    Note over T,S: tracker + STUN no longer needed
```

### Topology and its cost

Connections are a full mesh: with N participants, each peer holds a separate encrypted connection to every other peer. Sending one file therefore uploads N−1 copies from the sender — fine up to roughly 6–8 peers, then the sender's uplink becomes the bottleneck. For the intended two-machine use case this is a single copy.

## Files

| File | Purpose |
|------|---------|
| `index.html` | UI and styles |
| `app.js` | Trystero room, TURN fetch, send/receive logic |
| `CNAME` | Custom domain for GitHub Pages |

## Run locally

Serve the folder over HTTP (a module script and clipboard access need a real origin, not `file://`):

```
python3 -m http.server 8000
```

Open `http://localhost:8000` in two browser tabs (or two devices) to test a transfer.

## Deploy

Push to the repository's default branch, then enable GitHub Pages for that branch in the repository settings. Point the `airdrop.harsath.com` DNS record at GitHub Pages and keep the `CNAME` file in place.

## Known limits (v1)

- Received files are buffered fully in memory, so very large files (multi-GB) may fail on low-memory devices. Streaming to disk is a planned upgrade.
- The TURN API key is exposed in the client. This is metered.ca's intended model (the key is rate-limited), but rotate it if abuse occurs.
- Closing a tab mid-transfer cancels it; there is no resume.
