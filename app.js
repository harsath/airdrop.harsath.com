const TRYSTERO_URL = 'https://esm.sh/trystero@0.21.6/torrent'
const APP_ID = 'airdrop-harsath-com'
const MAX_SIZE = 5 * 1024 * 1024 // 5 MB per-file upload limit
const RELAY_URLS = ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev']
const TURN_URL =
  'https://airdrop.metered.live/api/v1/turn/credentials?apiKey=fc7c0fb1b607619385e5c1e223c488e495d3'

// --- DOM ---
const $ = sel => document.querySelector(sel)
const shareInput = $('#share')
const dot = $('#dot')
const peersLabel = $('#peers')
const drop = $('#drop')
const fileInput = $('#file')
const xfers = $('#xfers')
const empty = $('#empty')
const logEl = $('#log')
const inspectBtn = $('#inspect')

// --- diagnostics log (fixed height, auto-scrolls) ---
function diag(text, cls) {
  const line = document.createElement('div')
  if (cls) line.className = cls
  line.textContent = text
  logEl.append(line)
  logEl.scrollTop = logEl.scrollHeight
}

function setStatus(text, ok = false) {
  peersLabel.textContent = text
  dot.classList.toggle('on', ok)
}

function humanSize(n) {
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`
}

function newXfer(label, size) {
  empty.hidden = true
  const li = document.createElement('li')
  li.className = 'xfer'
  li.innerHTML = `
    <div class="head"><span class="name"></span><span class="meta"></span></div>
    <div class="bar"><span></span></div>`
  li.querySelector('.name').textContent = label
  li.querySelector('.meta').textContent = humanSize(size)
  xfers.prepend(li)
  const fill = li.querySelector('.bar > span')
  const meta = li.querySelector('.meta')
  return {
    progress(pct) { fill.style.width = `${Math.round(pct * 100)}%` },
    done(node) { li.classList.add('done'); fill.style.width = '100%'; if (node) meta.replaceChildren(node) }
  }
}

// --- room id in the URL hash (no server routing needed) ---
function getRoomId() {
  let id = location.hash.slice(1)
  if (!id) {
    const bytes = crypto.getRandomValues(new Uint8Array(8))
    id = Array.from(bytes, b => b.toString(36)).join('').slice(0, 10)
    location.hash = id
  }
  return id
}

// --- synchronous UI (works before Trystero loads) ---
const roomId = getRoomId()
shareInput.value = location.href

$('#copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(location.href) } catch {}
  const b = $('#copy'); const old = b.textContent
  b.textContent = 'Copied'; setTimeout(() => (b.textContent = old), 1200)
})

let sendFn = null
let peerCount = 0

async function send(files) {
  if (!sendFn) { alert('Not connected yet — wait for the dot to turn green.'); return }
  if (peerCount === 0) { alert('No one is in the room yet. Share the link first.'); return }
  for (const file of files) {
    if (file.size > MAX_SIZE) {
      diag(`✗ "${file.name}" is ${humanSize(file.size)} — over the ${humanSize(MAX_SIZE)} limit, skipped`, 'relay')
      alert(`"${file.name}" is ${humanSize(file.size)}. Max is ${humanSize(MAX_SIZE)}.`)
      continue
    }
    const ui = newXfer(`↑ ${file.name}`, file.size)
    diag(`↑ sending "${file.name}" (${humanSize(file.size)})`)
    const buf = await file.arrayBuffer()
    await sendFn(buf, null, {name: file.name, size: file.size, type: file.type}, pct => ui.progress(pct))
    ui.done()
    diag(`  sent "${file.name}"`, 'dim')
  }
}

drop.addEventListener('click', () => fileInput.click())
fileInput.addEventListener('change', () => { if (fileInput.files.length) send(fileInput.files); fileInput.value = '' })
;['dragenter', 'dragover'].forEach(ev =>
  drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag') }))
;['dragleave', 'drop'].forEach(ev =>
  drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag') }))
drop.addEventListener('drop', e => { if (e.dataTransfer?.files.length) send(e.dataTransfer.files) })

// --- read WebRTC's own stats: show direct vs relay + real endpoints ---
async function logConnection(peerId, pc) {
  for (let i = 0; i < 25; i++) {
    const stats = await pc.getStats()
    let pair
    stats.forEach(r => {
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) pair = r
    })
    if (pair) {
      let local, remote
      stats.forEach(r => { if (r.id === pair.localCandidateId) local = r; if (r.id === pair.remoteCandidateId) remote = r })
      const relay = local?.candidateType === 'relay' || remote?.candidateType === 'relay'
      diag(`↔ ${peerId.slice(0, 6)}: ${relay ? 'RELAY via TURN' : 'DIRECT peer-to-peer'}`, relay ? 'relay' : 'direct')
      diag(`   local  ${local?.address}:${local?.port}/${local?.protocol} (${local?.candidateType})` +
           (local?.url ? ` via ${local.url}` : ''), 'dim')
      diag(`   remote ${remote?.address}:${remote?.port}/${remote?.protocol} (${remote?.candidateType})`, 'dim')
      if (relay && local?.relayProtocol) diag(`   relay transport: ${local.relayProtocol}`, 'dim')
      return
    }
    await new Promise(r => setTimeout(r, 300))
  }
  diag(`   (${peerId.slice(0, 6)}: no succeeded candidate pair yet)`, 'dim')
}

let room = null
inspectBtn.addEventListener('click', () => {
  if (!room) return
  const peers = room.getPeers()
  const ids = Object.keys(peers)
  if (!ids.length) { diag('inspect: no peers connected', 'dim'); return }
  diag('— inspecting connections —', 'dim')
  ids.forEach(id => logConnection(id, peers[id]))
})

// --- boot: load Trystero, fetch TURN, join. Errors surface in the log. ---
async function boot() {
  setStatus('Loading…')
  diag(`room: ${roomId}`, 'dim')

  let joinRoom, selfId
  try {
    ({joinRoom, selfId} = await import(TRYSTERO_URL))
    diag(`selfId: ${selfId}`, 'dim')
  } catch (err) {
    diag(`ERROR loading Trystero: ${err.message}`); setStatus('Failed to load Trystero'); return
  }

  let iceServers
  try {
    iceServers = await (await fetch(TURN_URL)).json()
    diag(`fetched ${iceServers.length} ICE servers from metered:`, 'dim')
    for (const s of iceServers) {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls]
      urls.forEach(u => diag(`   ${u.startsWith('stun') ? 'STUN' : 'TURN'}  ${u}`, 'dim'))
    }
  } catch (err) {
    diag(`TURN fetch failed, using public STUN only (${err.message})`, 'dim')
    iceServers = [{urls: 'stun:stun.l.google.com:19302'}]
  }

  diag(`trackers: ${RELAY_URLS.join(', ')}`, 'dim')
  try {
    room = joinRoom({appId: APP_ID, rtcConfig: {iceServers}, relayUrls: RELAY_URLS}, roomId)
  } catch (err) {
    diag(`ERROR joining room: ${err.message}`); setStatus('Failed to join room'); return
  }

  const [sendFile, getFile, onFileProgress] = room.makeAction('file')
  sendFn = sendFile
  inspectBtn.disabled = false

  function refreshPeers() {
    setStatus(peerCount > 0 ? `${peerCount} peer${peerCount > 1 ? 's' : ''} connected`
                            : 'Waiting for someone to open this link…', peerCount > 0)
  }
  refreshPeers()

  room.onPeerJoin(id => {
    peerCount++; refreshPeers()
    diag(`PEER JOINED: ${id.slice(0, 6)}`)
    const pc = room.getPeers()[id]
    if (pc) logConnection(id, pc)
  })
  room.onPeerLeave(id => { peerCount = Math.max(0, peerCount - 1); refreshPeers(); diag(`PEER LEFT: ${id.slice(0, 6)}`) })

  const receiving = new Map()
  onFileProgress((pct, peerId, meta) => {
    const key = `${peerId}:${meta?.name}`
    let ui = receiving.get(key)
    if (!ui) { ui = newXfer(`↓ ${meta?.name ?? 'file'}`, meta?.size ?? 0); receiving.set(key, ui) }
    ui.progress(pct)
  })

  getFile((data, peerId, meta) => {
    const key = `${peerId}:${meta?.name}`
    const ui = receiving.get(key) ?? newXfer(`↓ ${meta?.name ?? 'file'}`, meta?.size ?? 0)
    receiving.delete(key)
    const url = URL.createObjectURL(new Blob([data], {type: meta?.type || 'application/octet-stream'}))
    const a = document.createElement('a')
    a.className = 'dl'; a.href = url; a.download = meta?.name ?? 'download'; a.textContent = 'Download'
    ui.done(a)
    diag(`↓ received "${meta?.name}" (${humanSize(data.byteLength)}) from ${peerId.slice(0, 6)}`)
  })
}

boot()
