// PART 1 — Talk to metered.ca and inspect the ICE servers.
//
// This is the ONLY job of metered here: hand back a list of servers your
// browser's ICE agent can use. Some are STUN (help you find your public IP),
// some are TURN (relay bytes when a direct path fails). No WebRTC yet — this
// is a plain HTTPS request. You could paste the fetch into any browser console.
//
// Run:  node explore/1-metered.mjs      (needs Node 18+ for built-in fetch)

const API_KEY = 'fc7c0fb1b607619385e5c1e223c488e495d3'
const URL = `https://airdrop.metered.live/api/v1/turn/credentials?apiKey=${API_KEY}`

const res = await fetch(URL)
if (!res.ok) throw new Error(`metered returned HTTP ${res.status}`)

const iceServers = await res.json()

console.log('\nRaw iceServers array (this is what you pass to RTCPeerConnection):\n')
console.log(JSON.stringify(iceServers, null, 2))

console.log('\nBreakdown:\n')
for (const server of iceServers) {
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls]
  for (const url of urls) {
    const kind = url.startsWith('stun') ? 'STUN' : 'TURN'
    const creds = server.username ? `  user=${server.username}` : ''
    console.log(`  ${kind.padEnd(4)}  ${url}${creds}`)
  }
}

console.log(`
Notes:
- STUN entries carry no credentials. STUN just reflects your public IP:port back.
- TURN entries carry a short-lived username/credential — these expire, which is
  why you fetch them fresh instead of hardcoding.
- Ports you'll see: 80 and 443 are firewall-friendly (look like web traffic);
  ?transport=tcp forces TCP for networks that block UDP entirely.
`)
