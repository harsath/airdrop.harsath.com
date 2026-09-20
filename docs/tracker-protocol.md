# Tracker Protocol & WebTorrent Signaling — Reference

Two parts:

1. A crash course on the BitTorrent tracker protocol (general — useful for any torrent work, not just this app).
2. The exact WebTorrent WebSocket messages this app relies on for WebRTC signaling, stage by stage.

---

## Part 1 — BitTorrent tracker crash course

### What a tracker is for

A tracker is a **rendezvous directory**, nothing more. Its whole job is: given a piece of content, tell a client which other clients are currently sharing it. It answers *"who else is here?"* — it does **not** store the file, and it does **not** track which peer holds which piece. Once a client has a peer list, all the real data logistics happen directly between peers (see "Peer wire protocol" below).

The set of all clients sharing one piece of content is a **swarm**. A **seeder** has the complete content; a **leecher** is still downloading.

### The infohash — content-addressed identity

Every torrent is identified by its **infohash**: the 20-byte SHA-1 of the bencoded `info` dictionary inside the `.torrent` file (the part describing file names, sizes, and piece hashes).

The key property: anyone with the same content computes the **same infohash independently**. That shared value is how strangers find each other — they all announce the same infohash to the tracker, and the tracker groups them.

This is exactly the property WebTorrent/Trystero borrows. Trystero doesn't share a real file; it just hashes `appId + roomId` into an infohash and uses it as a **rendezvous label** so browsers in the same room find each other.

### Bencoding

BitTorrent's serialization format. It encodes four types: byte strings (`4:spam`), integers (`i42e`), lists (`l...e`), and dictionaries (`d...e`). `.torrent` files and classic HTTP tracker responses are bencoded. WebTorrent replaces this with plain JSON over WebSocket, which is why the messages in Part 2 look like ordinary JSON.

### The announce request

"Announce" is the core message a client sends a tracker. It means: *"I'm in this swarm, this is me, here's my progress — register me and give me peers."* It both **registers** the client and **fetches** a peer list in one round trip. Clients re-announce periodically (every `interval` seconds) to stay listed and refresh their peer list.

Standard announce keys (classic HTTP/UDP tracker):

| Key | Meaning |
|-----|---------|
| `info_hash` | 20-byte SHA-1 identifying the torrent (which swarm). |
| `peer_id` | 20-byte random ID identifying this client. |
| `port` | Port this client listens on for incoming peer connections. |
| `uploaded` | Total bytes uploaded so far. |
| `downloaded` | Total bytes downloaded so far. |
| `left` | Bytes still needed. `0` means this client is a seeder. |
| `event` | Lifecycle marker (see below); omitted for routine updates. |
| `numwant` | How many peers the client wants back. |
| `compact` | `1` requests a compact binary peer list instead of a verbose one. |
| `key` | Optional client-chosen key so the tracker can recognize it across IP changes. |

### The `event` field — lifecycle

| Value | Sent when |
|-------|-----------|
| `started` | First announce when joining a swarm. |
| `completed` | The moment the download finishes (client becomes a seeder). |
| `stopped` | Client is leaving cleanly. |
| *(empty)* | Routine periodic re-announce. |

### The tracker response

A successful announce returns:

| Key | Meaning |
|-----|---------|
| `interval` | Seconds to wait before re-announcing. |
| `min interval` | Minimum allowed re-announce interval. |
| `complete` | Number of seeders in the swarm. |
| `incomplete` | Number of leechers in the swarm. |
| `peers` | The peer list — compact binary (`compact=1`) or a list of `{ip, port, peer_id}`. |
| `failure reason` | Present instead of the above if the request errored. |

### Scrape — stats without joining

A separate request that asks the tracker for swarm statistics (`complete`, `downloaded`, `incomplete`) for one or more infohashes **without** announcing yourself. Useful for showing seeder/leecher counts.

### Transports and their action sets

The tracker protocol exists over three transports. "Actions" differ by transport:

- **HTTP/HTTPS** (BEP 3) — the original. Announce and scrape are separate URL endpoints; parameters go in the query string; responses are bencoded.
- **UDP** (BEP 15) — compact and efficient; avoids per-announce TCP setup. Uses numeric action codes:

  | Action code | Meaning |
  |-------------|---------|
  | `0` | connect (get a connection ID first, anti-spoofing) |
  | `1` | announce |
  | `2` | scrape |
  | `3` | error |

- **WebSocket** (WebTorrent) — for browsers, which can't open raw TCP/UDP sockets. JSON messages with `"action": "announce"` or `"action": "scrape"`, **extended** with WebRTC offer/answer fields so the tracker can also relay signaling. This is what Part 2 documents.

So "what are the other actions?" — at the protocol level: **connect, announce, scrape, error**. Announce is the one you use constantly; connect is UDP-only setup; scrape is stats-only; error is a failure reply.

### Finding peers *without* a tracker

Modern BitTorrent doesn't strictly need a tracker:

- **DHT** (BEP 5) — a global Kademlia distributed hash table. Nodes store "peers for infohash X" across the network, so any client can look up peers by infohash with no central tracker. This is the heart of trackerless torrents and magnet links.
- **PEX** (Peer Exchange) — connected peers gossip their peer lists to each other, spreading swarm membership without the tracker.
- **Magnet links** — reference content by infohash alone (`magnet:?xt=urn:btih:<infohash>`), relying on DHT/PEX to find peers and metadata, so no `.torrent` file is needed up front.

### Peer wire protocol (after discovery)

Once a client has peers, it connects to them directly and speaks the **peer wire protocol** — separate from the tracker. After a handshake, peers exchange:

- `bitfield` — a bitmap of which pieces I already have (sent once, up front).
- `have` — "I just got piece N" (incremental updates).
- `interested` / `not interested`, `choke` / `unchoke` — flow control; a peer uploads mainly to those who reciprocate (tit-for-tat), throttling freeloaders.
- `request` / `piece` / `cancel` — the actual block transfers.

Piece selection is typically **rarest-first**, so no piece goes extinct in the swarm. The tracker plays no part in any of this — it only made the introductions.

### Reusing this for your own use cases

The reusable ideas, independent of file sharing:

- **Content-addressed rendezvous:** hash a shared secret/label into an infohash; everyone who knows it finds each other. Works as a general discovery primitive (what Trystero does).
- **The DHT** is a usable, decentralized key→peers lookup you can piggyback for peer discovery in any P2P app.
- **The tracker announce model** (periodic "I'm here, give me peers" heartbeat with lifecycle events) is a clean pattern for any membership/presence system.
- **WebTorrent's WSS trackers** double as free, public WebRTC signaling relays for browser P2P — useful any time you want serverless browser-to-browser connections.

---

## Part 2 — WebTorrent signaling flow (this app)

Roles at connection setup:

- **Tracker** — public WebTorrent WebSocket server. Relays each peer's WebRTC session description to the other. Never reads the file bytes.
- **STUN** — separate server that tells a peer its own public IP:port.
- **TURN** — relay used only when a direct path can't be formed.
- **ICE agent** — built into each browser; gathers candidates, tests pairs, picks the working path.

Two binary fields below are shown readably: `info_hash` (20-byte room infohash, shown as hex) and `peer_id` (20-byte per-peer random ID).

### Stage 1 — A announces, offering a pool of offers

A → tracker. A has pre-built several `RTCPeerConnection`s and their offers, ready for whoever joins.

```json
{
  "action": "announce",
  "info_hash": "8f3a...c1",
  "peer_id": "AAAA-peerid-1111",
  "numwant": 10,
  "uploaded": 0,
  "downloaded": 0,
  "left": 0,
  "offers": [
    { "offer_id": "abc123", "offer": { "type": "offer", "sdp": "v=0\r\no=- ...(A's candidates)..." } },
    { "offer_id": "def456", "offer": { "type": "offer", "sdp": "v=0\r\no=- ..." } }
  ]
}
```

### Stage 2 — Tracker replies to A with swarm stats

Tracker → A. Bookkeeping only; A is still alone.

```json
{
  "action": "announce",
  "info_hash": "8f3a...c1",
  "interval": 120,
  "complete": 0,
  "incomplete": 1
}
```

`interval` = re-announce every 120s to stay in the swarm and refill offers.

### Stage 3 — B announces (also brings its own offers)

B → tracker. Same shape as Stage 1.

```json
{
  "action": "announce",
  "info_hash": "8f3a...c1",
  "peer_id": "BBBB-peerid-2222",
  "numwant": 10,
  "offers": [
    { "offer_id": "ghi789", "offer": { "type": "offer", "sdp": "v=0\r\no=- ...(B's candidates)..." } }
  ]
}
```

### Stage 4 — Tracker pushes one of A's waiting offers to B

Tracker → B. `peer_id` here is **A's** ID (the offer's origin).

```json
{
  "action": "announce",
  "info_hash": "8f3a...c1",
  "peer_id": "AAAA-peerid-1111",
  "offer_id": "abc123",
  "offer": { "type": "offer", "sdp": "v=0\r\no=- ...(A's candidates)..." }
}
```

### Stage 5 — B answers, addressed back to A

B → tracker. `to_peer_id` tells the tracker where to deliver; `offer_id` echoes so A can match it.

```json
{
  "action": "announce",
  "info_hash": "8f3a...c1",
  "peer_id": "BBBB-peerid-2222",
  "to_peer_id": "AAAA-peerid-1111",
  "offer_id": "abc123",
  "answer": { "type": "answer", "sdp": "v=0\r\no=- ...(B's candidates)..." }
}
```

### Stage 6 — Tracker forwards the answer to A

Tracker → A. `peer_id` is B (the sender). A uses `offer_id: "abc123"` to find the idle PeerConnection from Stage 1 and applies this answer.

```json
{
  "action": "announce",
  "info_hash": "8f3a...c1",
  "peer_id": "BBBB-peerid-2222",
  "offer_id": "abc123",
  "answer": { "type": "answer", "sdp": "v=0\r\no=- ...(B's candidates)..." }
}
```

After this, both sides hold offer + answer. The tracker is done; ICE takes over on the UDP sockets.

### What's inside the `"sdp"` string

The candidates are truncated above. A real session description looks like:

```
v=0
o=- 4611731400430051336 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0
m=application 44321 UDP/DTLS/SCTP webrtc-datachannel
c=IN IP4 203.0.113.5
a=ice-ufrag:F7g3
a=ice-pwd:x9aB...
a=fingerprint:sha-256 4A:2C:...          <- DTLS identity (peer verifies this)
a=setup:actpass
a=sctp-port:5000
a=candidate:1 1 udp 2122252543 192.168.1.20 3000  typ host
a=candidate:2 1 udp 1686052607 203.0.113.5 44321 typ srflx raddr 192.168.1.20 rport 3000
```

The tracker treats this whole blob as opaque text. The receiving **peer** reads the candidates (where to send UDP) and the fingerprint (whom to verify).

### Stage → diagram map

| Message | Role |
|---------|------|
| Stage 1 | A announces its offer pool |
| Stage 2 | Tracker's stats reply to A |
| Stage 3 | B joins and announces |
| Stage 4 | Tracker pushes A's offer to B |
| Stage 5 | B returns an answer |
| Stage 6 | Tracker forwards the answer to A |

### See it live

DevTools → Network → WS filter → click the tracker connection → the Messages/Frames tab shows these JSON frames in real time.
