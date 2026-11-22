// airdrop.harsath.com: encrypted store-and-forward file drop on Supabase.
// Flow: encrypt in browser -> resumable upload to Storage -> insert row in `files`
// -> DB trigger broadcasts to room:<id> -> others download + decrypt.
// See supabase/migrations/0001_init.sql for the server side.

import * as C from './crypto.js'

const SUPABASE_URL = 'https://vakzpjtoqvzxmilqnbwr.supabase.co'
const STORAGE_URL = 'https://vakzpjtoqvzxmilqnbwr.storage.supabase.co' // direct host for tus uploads
const SUPABASE_KEY = 'sb_publishable_gQ7JlF6hbkTQjoRsAIL8rQ_32rs1xdC' // publishable: safe in the client, RLS protects data
const BUCKET = 'drops'
const MAX_SIZE = 50 * 1024 * 1024 - C.OVERHEAD // bucket cap is 50 MB of ciphertext
const LIBS = {
  supabase: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm',
  qrcode: 'https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/dist/qrcode.mjs',
}

// --- DOM helpers ---
const $ = sel => document.querySelector(sel)

// Developer log: goes to the browser console only (no on-page log).
function diag(text, cls = '') {
  ;(cls === 'bad' ? console.warn : console.info)('[airdrop]', text)
}

function setStatus(text, ok = false) {
  $('#status').textContent = text
  $('#dot').classList.toggle('on', ok)
}

function fatal(text) {
  const el = $('#fatal')
  el.textContent = text
  el.hidden = false
  diag(text, 'bad')
}

function humanSize(n) {
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`
}

function timeLeft(ms) {
  if (ms <= 0) return 'expired'
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'less than 1m left'
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m}m left`
}

function deviceLabel() {
  const ua = navigator.userAgent
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Mac OS X/.test(ua) ? 'Mac'
    : /Linux/.test(ua) ? 'Linux' : 'Device'
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  return `${os} · ${browser}`
}

// sessionStorage can throw (private mode, blocked storage); the app works without it.
const cache = {
  get(k) { try { return JSON.parse(sessionStorage.getItem(k)) } catch { return null } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)) } catch {} },
  del(k) { try { sessionStorage.removeItem(k) } catch {} },
}

// --- state ---
let sb = null          // supabase client
let makeQr = null      // qrcode-generator factory
let me = null          // my anonymous user id
let room = null        // { id, kind, key }
let channel = null
const files = new Map() // id -> item
const peers = new Map() // user id -> device label

async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args)
  if (error) throw new Error(`${name}: ${error.message}`)
  return data
}

async function accessToken() {
  const { data: { session } } = await sb.auth.getSession()
  if (!session) throw new Error('not signed in')
  return session.access_token
}

async function ensureSession() {
  const { data: { session } } = await sb.auth.getSession()
  if (session) return session.user.id
  const { data, error } = await sb.auth.signInAnonymously()
  if (error) throw new Error(`anonymous sign-in failed: ${error.message}`)
  diag(`signed in anonymously as ${data.user.id.slice(0, 8)}`, 'dim')
  return data.user.id
}

// --- URL hash: '#<22-char key>' = link room, '#p/<10-char id>' = password room ---
function parseHash() {
  const h = location.hash.slice(1)
  if (!h) return null
  if (/^[A-Za-z0-9_-]{22}$/.test(h)) return { kind: 'public', secret: h }
  const m = h.match(/^p\/([2-9a-hjkmnp-z]{10})$/)
  if (m) return { kind: 'protected', id: m[1] }
  return { kind: 'invalid' }
}

// Pasting a different room link into an open tab only changes the hash; reload to switch rooms.
window.addEventListener('hashchange', () => location.reload())

// --- start screen ---
function showStart(error = '') {
  $('#start').hidden = false
  $('#room').hidden = true
  const el = $('#startError')
  el.textContent = error
  el.hidden = !error
  if (error) diag(error, 'bad')
}

$('#newPublic').addEventListener('click', () => { location.hash = C.newPublicSecret() })

$('#newProtectedForm').addEventListener('submit', async e => {
  e.preventDefault()
  const pw = $('#newPw').value
  const btn = $('#newProtectedBtn')
  btn.disabled = true
  btn.textContent = 'Creating…'
  try {
    me = await ensureSession()
    const id = C.newProtectedId()
    const salt = C.newSalt()
    const d = await C.deriveProtectedRoom(pw, salt)
    const status = await rpc('create_protected_room', { p_room: id, p_salt: salt, p_proof: d.proof })
    if (status !== 'ok') throw new Error(`Could not create room (${status})`)
    cache.set(`airdrop:p/${id}`, { enc: C.b64uEncode(d.encRaw), proof: d.proof })
    location.hash = `p/${id}` // reloads into the room; the cached key skips the password prompt
  } catch (err) {
    showStart(err.message)
    btn.disabled = false
    btn.textContent = 'Create password room'
  }
})

// --- joining ---
async function enterPublic(secret) {
  const { id, encRaw } = await C.derivePublicRoom(secret)
  const status = await rpc('join_public_room', { p_room: id })
  if (status !== 'ok') throw new Error(`Could not join room (${status})`)
  return { id, kind: 'public', key: await C.importAesKey(encRaw) }
}

function askPassword(error) {
  const dlg = $('#pw')
  $('#pwError').textContent = error
  $('#pwInput').value = ''
  dlg.showModal()
  $('#pwInput').focus()
  return new Promise(resolve => {
    dlg.oncancel = e => e.preventDefault() // Escape must not leave the prompt hanging
    $('#pwCancel').onclick = () => { dlg.close(); location.hash = '' }
    $('#pwForm').onsubmit = e => {
      e.preventDefault()
      dlg.close()
      resolve($('#pwInput').value)
    }
  })
}

async function enterProtected(id) {
  const salt = await rpc('protected_room_salt', { p_room: id })
  if (!salt) throw new Error("That password room doesn't exist. Rooms are deleted after 30 days without use.")

  const cacheKey = `airdrop:p/${id}`
  let cached = cache.get(cacheKey)
  let error = ''
  for (;;) {
    let enc, proof
    if (cached) {
      ({ enc, proof } = cached)
      cached = null
    } else {
      const pw = await askPassword(error)
      setStatus('Checking password…')
      const d = await C.deriveProtectedRoom(pw, salt)
      enc = C.b64uEncode(d.encRaw)
      proof = d.proof
    }
    const status = await rpc('join_protected_room', { p_room: id, p_proof: proof })
    if (status === 'ok') {
      cache.set(cacheKey, { enc, proof })
      return { id, kind: 'protected', key: await C.importAesKey(C.b64uDecode(enc)) }
    }
    cache.del(cacheKey)
    if (status === 'not_found') throw new Error("That password room doesn't exist anymore.")
    error = status === 'bad_password' ? 'Wrong password.'
      : status === 'rate_limited' ? 'Too many wrong tries. Wait 15 minutes and try again.'
      : `Could not join (${status}).`
    diag(`join: ${status}`, 'bad')
  }
}

// --- file list ---
function updateEmpty() { $('#empty').hidden = files.size > 0 }

function createItem(item) {
  const li = document.createElement('li')
  li.className = 'file'
  li.innerHTML = `
    <div class="head"><span class="name"></span><span class="size"></span></div>
    <div class="sub2"><span class="info"></span><span class="actions"></span></div>
    <div class="bar"><span></span></div>`
  item.el = li
  item.refs = {
    name: li.querySelector('.name'), size: li.querySelector('.size'), info: li.querySelector('.info'),
    actions: li.querySelector('.actions'), bar: li.querySelector('.bar'), fill: li.querySelector('.bar > span'),
  }
  files.set(item.id, item)
  $('#files').prepend(li)
  render(item)
  updateEmpty()
  return item
}

function removeItem(id) {
  const it = files.get(id)
  if (!it) return
  it.el.remove()
  if (it.url) URL.revokeObjectURL(it.url)
  files.delete(id)
  updateEmpty()
}

function button(label, onClick, cls = '') {
  const b = document.createElement('button')
  b.textContent = label
  b.className = cls
  b.onclick = onClick
  return b
}

function span(text, cls = '') {
  const s = document.createElement('span')
  s.textContent = text
  s.className = cls
  return s
}

function actionsFor(it) {
  const pct = `${Math.round((it.pct ?? 0) * 100)}%`
  switch (it.state) {
    case 'encrypting': return [span('Encrypting…', 'muted')]
    case 'uploading': return [span(`Uploading ${pct}`, 'muted')]
    case 'claiming': return [span('Opening…', 'muted')]
    case 'downloading': return [span(`Downloading ${pct}`, 'muted')]
    case 'error': return [span(it.error, 'err'), it.mine
      ? button('Dismiss', () => removeItem(it.id), 'ghost')
      : button('Retry', () => download(it), 'ghost')]
    case 'burned': return [span('Opened by someone and burned', 'muted')]
    case 'saved': {
      const a = document.createElement('a')
      a.href = it.url
      a.download = it.name
      a.textContent = 'Save again'
      return [span(it.burn ? 'Saved · deleted from server' : 'Saved', 'ok'), a]
    }
    default: // ready
      if (it.mine) return [...(it.burn ? [span('Waiting to be opened', 'muted')] : []), button('Delete', () => onDelete(it), 'ghost')]
      return [button(it.burn ? 'Download (burns it)' : 'Download', () => download(it))]
  }
}

function render(it) {
  const r = it.refs
  r.name.textContent = it.name
  r.name.title = it.name
  r.size.textContent = humanSize(it.size)
  const parts = [it.mine ? 'from you' : `from ${peers.get(it.uploader) ?? 'another device'}`]
  if (it.burn) parts.push('burn after read')
  if (it.state !== 'saved') parts.push(timeLeft(it.expiresAt - Date.now()))
  r.info.textContent = parts.join(' · ')
  r.actions.replaceChildren(...actionsFor(it))
  r.bar.hidden = !['uploading', 'downloading'].includes(it.state)
  r.fill.style.width = `${Math.round((it.pct ?? 0) * 100)}%`
  it.el.classList.toggle('burn', it.burn)
}

// A row from the `files` table or a file_added broadcast.
async function addRemoteFile(row) {
  const existing = files.get(row.id)
  if (existing) {
    existing.expiresAt = Date.parse(row.expires_at)
    if (existing.state === 'uploading') existing.state = 'ready'
    render(existing)
    return
  }
  let meta
  try { meta = await C.decryptMeta(room.key, row.name_enc) }
  catch { meta = { n: '(name could not be decrypted)', t: '' } }
  if (files.has(row.id)) return // added while we were decrypting
  createItem({
    id: row.id, name: meta.n, type: meta.t, size: row.size, burn: row.burn,
    uploader: row.uploader, mine: row.uploader === me, expiresAt: Date.parse(row.expires_at),
    state: row.uploader === me && row.burn && row.claimed_by ? 'burned' : 'ready',
  })
}

// Fetch the full list and reconcile, so anything missed while offline shows up (or goes away).
async function loadFiles() {
  const { data, error } = await sb.from('files')
    .select('id, uploader, name_enc, size, burn, claimed_by, expires_at')
    .eq('room_id', room.id)
    .order('created_at', { ascending: true })
  if (error) { diag(`list files: ${error.message}`, 'bad'); return }
  const live = new Set(data.map(r => r.id))
  for (const it of [...files.values()]) {
    if (it.state === 'ready' && !live.has(it.id)) removeItem(it.id)
  }
  for (const row of data) await addRemoteFile(row)
}

// --- upload ---
function tusUpload(blob, objectName, token, onProgress) {
  return new Promise((resolve, reject) => {
    const upload = new window.tus.Upload(blob, {
      endpoint: `${STORAGE_URL}/storage/v1/upload/resumable`,
      retryDelays: [0, 1000, 3000, 5000, 10000, 20000],
      headers: { authorization: `Bearer ${token}`, apikey: SUPABASE_KEY, 'x-upsert': 'false' },
      uploadDataDuringCreation: true,
      storeFingerprintForResuming: false, // each upload is freshly encrypted, so never resume an old one
      chunkSize: 6 * 1024 * 1024, // Supabase requires exactly 6 MB chunks
      metadata: { bucketName: BUCKET, objectName, contentType: 'application/octet-stream', cacheControl: '3600' },
      onProgress: (sent, total) => onProgress(sent / total),
      onError: reject,
      onSuccess: resolve,
    })
    upload.start()
  })
}

async function upload(file, burn) {
  if (file.size > MAX_SIZE) {
    diag(`"${file.name}" is ${humanSize(file.size)}, over the 50 MB limit, skipped`, 'bad')
    alert(`"${file.name}" is ${humanSize(file.size)}. The limit is 50 MB per file.`)
    return
  }
  const id = crypto.randomUUID()
  const item = createItem({
    id, name: file.name, type: file.type, size: file.size, burn, uploader: me, mine: true,
    expiresAt: Date.now() + 3 * 3600 * 1000, state: 'encrypting',
  })
  try {
    const blob = await C.encryptFile(room.key, await file.arrayBuffer())
    item.state = 'uploading'; item.pct = 0; render(item)
    diag(`uploading "${file.name}" (${humanSize(file.size)})`)
    await tusUpload(blob, `${room.id}/${id}`, await accessToken(), pct => {
      item.pct = pct
      render(item)
    })
    const name_enc = await C.encryptMeta(room.key, { n: file.name, t: file.type })
    const { error } = await sb.from('files').insert({ id, room_id: room.id, name_enc, size: file.size, burn })
    if (error) throw new Error(error.message)
    if (item.state === 'uploading') { item.state = 'ready'; render(item) }
    diag(`uploaded "${file.name}"`, 'good')
  } catch (e) {
    item.state = 'error'
    item.error = `Upload failed: ${e.message ?? e}`
    render(item)
    diag(item.error, 'bad')
  }
}

// One file at a time keeps memory use to a single file.
let queue = Promise.resolve()
function enqueue(list) {
  if (!room) return
  const burn = $('#burn').checked
  for (const f of list) queue = queue.then(() => upload(f, burn))
}

// --- download ---
async function fetchObject(path, expected, onProgress) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/${BUCKET}/${path}`, {
    headers: { Authorization: `Bearer ${await accessToken()}`, apikey: SUPABASE_KEY },
  })
  if (!res.ok) throw new Error(res.status === 400 || res.status === 404 ? 'the file is gone' : `HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || expected
  const reader = res.body.getReader()
  const chunks = []
  let got = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    got += value.length
    onProgress(Math.min(1, got / total))
  }
  return new Blob(chunks).arrayBuffer()
}

function saveUrl(url, name) {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
}

async function destroy(it) {
  const { error: e1 } = await sb.storage.from(BUCKET).remove([`${room.id}/${it.id}`])
  if (e1) throw new Error(e1.message)
  const { error: e2 } = await sb.from('files').delete().eq('id', it.id)
  if (e2) throw new Error(e2.message)
}

async function download(it) {
  if (it.busy) return
  it.busy = true
  try {
    if (it.burn && !it.mine) {
      it.state = 'claiming'; render(it)
      const status = await rpc('claim_file', { p_file: it.id })
      if (status !== 'ok') {
        diag(`"${it.name}": ${status === 'taken' ? 'someone else opened it first' : 'it is gone'}`, 'bad')
        removeItem(it.id)
        return
      }
    }
    it.state = 'downloading'; it.pct = 0; render(it)
    const buf = await fetchObject(`${room.id}/${it.id}`, it.size + C.OVERHEAD, pct => { it.pct = pct; render(it) })
    let plain
    try { plain = await C.decryptFile(room.key, buf) }
    catch { throw new Error('could not decrypt (wrong key or damaged file)') }
    it.url = URL.createObjectURL(new Blob([plain], { type: it.type || 'application/octet-stream' }))
    saveUrl(it.url, it.name)
    it.state = 'saved'
    diag(`downloaded "${it.name}"`, 'good')
    if (it.burn && !it.mine) {
      try { await destroy(it) } catch (e) { diag(`burn cleanup: ${e.message} (the server deletes it within 15 min)`, 'dim') }
    }
  } catch (e) {
    it.state = 'error'
    it.error = `Download failed: ${e.message}`
    diag(it.error, 'bad')
  } finally {
    it.busy = false
    if (files.has(it.id)) render(it)
  }
}

async function onDelete(it) {
  if (it.busy) return
  it.busy = true
  try {
    await destroy(it)
    removeItem(it.id)
    diag(`deleted "${it.name}"`, 'dim')
  } catch (e) {
    it.busy = false
    diag(`delete failed: ${e.message}`, 'bad')
  }
}

// --- realtime: presence + file events ---
function syncPresence() {
  peers.clear()
  for (const [key, metas] of Object.entries(channel.presenceState())) peers.set(key, metas[0]?.label ?? 'device')
  const others = [...peers].filter(([id]) => id !== me).map(([, label]) => label)
  setStatus(others.length ? `Here now: ${others.join(', ')}` : 'Only you are here. Files wait up to 3 hours for others.', true)
  for (const it of files.values()) render(it)
}

async function connectRealtime() {
  sb.realtime.setAuth(await accessToken())
  channel = sb.channel(`room:${room.id}`, { config: { private: true, presence: { key: me } } })
  channel
    .on('broadcast', { event: 'file_added' }, ({ payload }) => addRemoteFile(payload.file))
    .on('broadcast', { event: 'file_claimed' }, ({ payload }) => {
      const it = files.get(payload.id)
      if (!it || payload.by === me) return
      if (it.mine) { it.state = 'burned'; render(it) } else removeItem(it.id)
    })
    .on('broadcast', { event: 'file_removed' }, ({ payload }) => {
      const it = files.get(payload.id)
      if (it && !['saved', 'burned', 'downloading'].includes(it.state)) removeItem(it.id)
    })
    .on('presence', { event: 'sync' }, syncPresence)
    .subscribe(async (status, err) => {
      if (status === 'SUBSCRIBED') {
        diag('realtime connected', 'good')
        await channel.track({ label: deviceLabel() })
        loadFiles() // catch up on anything missed while disconnected
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        setStatus('Live updates disconnected, retrying…', false)
        diag(`realtime ${status}${err ? `: ${err.message}` : ''}`, 'bad')
      }
    })
}

// --- room screen ---
async function openRoom() {
  $('#start').hidden = true
  $('#room').hidden = false
  const link = location.href
  $('#link').value = link
  $('#kind').textContent = room.kind === 'public' ? 'link room' : 'password room'
  $('#kindNote').textContent = room.kind === 'public'
    ? 'Anyone with this link can open the room and its files.'
    : 'People need this link and the password. Send the password separately.'

  try {
    const qr = makeQr(0, 'M')
    qr.addData(link)
    qr.make()
    $('#qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
  } catch (e) { diag(`QR: ${e.message}`, 'bad') }

  diag(`room ${room.id} (${room.kind})`, 'dim')
  setStatus('Connecting…')
  await loadFiles()
  connectRealtime().catch(e => diag(`realtime: ${e.message}`, 'bad'))

  // Countdowns, and drop files that expired while the tab was open.
  setInterval(() => {
    for (const it of [...files.values()]) {
      if (it.expiresAt <= Date.now() && !['saved', 'uploading', 'encrypting'].includes(it.state)) removeItem(it.id)
      else render(it)
    }
  }, 30000)
  // Phones suspend background tabs; refresh the list when the page comes back.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadFiles() })
}

$('#copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#link').value) } catch {}
  const b = $('#copy')
  b.textContent = 'Copied'
  setTimeout(() => (b.textContent = 'Copy'), 1200)
})

const drop = $('#drop')
const fileInput = $('#file')
drop.addEventListener('click', () => fileInput.click())
fileInput.addEventListener('change', () => { if (fileInput.files.length) enqueue([...fileInput.files]); fileInput.value = '' })
;['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag') }))
;['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag') }))
drop.addEventListener('drop', e => { if (e.dataTransfer?.files.length) enqueue([...e.dataTransfer.files]) })

// --- boot ---
async function boot() {
  try {
    const [supa, qr] = await Promise.all([import(LIBS.supabase), import(LIBS.qrcode)])
    sb = supa.createClient(SUPABASE_URL, SUPABASE_KEY)
    makeQr = qr.default
    if (!window.tus) throw new Error('tus-js-client did not load')
  } catch (e) {
    fatal(`Could not load the app's libraries from jsdelivr: ${e.message}`)
    return
  }

  const target = parseHash()
  if (!target) return showStart()
  if (target.kind === 'invalid') return showStart("That link isn't a valid room link.")

  try {
    me = await ensureSession()
    room = target.kind === 'public' ? await enterPublic(target.secret) : await enterProtected(target.id)
  } catch (e) {
    return showStart(e.message)
  }
  await openRoom()
}

boot()
