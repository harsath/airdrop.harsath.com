// Paste this into a browser console to test whether tracker/relay WebSocket URLs
// are reachable from the current network (useful for corporate firewalls).
//
// IMPORTANT: run it in a tab that is NOT under a strict Content Security Policy.
// Open about:blank or https://airdrop.harsath.com first, then paste. Running it on
// a corporate app page (Okta, etc.) makes every result a false BLOCKED, because
// that page's CSP connect-src blocks the connections, not the network.

// ---- edit this list ----
const TRACKERS = [
  'wss://tracker.webtorrent.dev',
  'wss://tracker.openwebtorrent.com',
  // add more below:
  // 'wss://your.new.tracker/announce',
]
// ------------------------

TRACKERS.forEach(url => {
  const t0 = performance.now()
  let done = false
  const ws = new WebSocket(url)
  const finish = ok => {
    if (done) return
    done = true
    clearTimeout(timer)
    console.log(`${ok ? '✓ OK     ' : '✗ BLOCKED'}  ${url}  (${Math.round(performance.now() - t0)}ms)`)
    try { ws.close() } catch {}
  }
  const timer = setTimeout(() => finish(false), 6000)
  ws.onopen = () => finish(true)
  ws.onerror = () => finish(false)
})
