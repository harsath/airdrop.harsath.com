// All encryption happens in the browser. Supabase only ever stores ciphertext.
//
// Public room:    link secret (16 random bytes, after '#')
//                   -> HKDF 'airdrop/room-id' -> room id (32 hex, sent to server)
//                   -> HKDF 'airdrop/enc'     -> AES-256-GCM key (never sent)
// Protected room: PBKDF2-SHA256(password, salt, 600k) -> master
//                   -> HKDF 'airdrop/enc'  -> AES-256-GCM key (never sent)
//                   -> HKDF 'airdrop/auth' -> proof (sent; server stores bcrypt of it)
// Ciphertext format: 12-byte random IV || AES-GCM ciphertext+tag.

const te = new TextEncoder()
const td = new TextDecoder()

export const ROOM_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz' // no 0/o, 1/l/i
export const OVERHEAD = 12 + 16 // IV + GCM tag

export function b64uEncode(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64uDecode(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4))
  return Uint8Array.from(s, c => c.charCodeAt(0))
}

const toHex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')

async function hkdf(ikm, info, bits = 256) {
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  const out = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(info) }, base, bits)
  return new Uint8Array(out)
}

export const importAesKey = raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])

// --- room secrets ---

export function newPublicSecret() {
  return b64uEncode(crypto.getRandomValues(new Uint8Array(16)))
}

export async function derivePublicRoom(secret) {
  const ikm = b64uDecode(secret)
  if (ikm.length !== 16) throw new Error('bad link')
  return { id: toHex(await hkdf(ikm, 'airdrop/room-id', 128)), encRaw: await hkdf(ikm, 'airdrop/enc') }
}

export function newProtectedId(len = 10) {
  let id = ''
  while (id.length < len) {
    for (const b of crypto.getRandomValues(new Uint8Array(len))) {
      // rejection sampling: 248 = 8 * 31, so every character is equally likely
      if (b < 248 && id.length < len) id += ROOM_ALPHABET[b % ROOM_ALPHABET.length]
    }
  }
  return id
}

export const newSalt = () => b64uEncode(crypto.getRandomValues(new Uint8Array(16)))

export async function deriveProtectedRoom(password, salt) {
  const base = await crypto.subtle.importKey('raw', te.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits'])
  const master = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: b64uDecode(salt), iterations: 600_000 }, base, 256))
  return { encRaw: await hkdf(master, 'airdrop/enc'), proof: b64uEncode(await hkdf(master, 'airdrop/auth')) }
}

// --- file bytes ---

export async function encryptFile(key, arrayBuffer) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, arrayBuffer)
  return new Blob([iv, ct], { type: 'application/octet-stream' })
}

export async function decryptFile(key, arrayBuffer) {
  const iv = new Uint8Array(arrayBuffer, 0, 12)
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, new Uint8Array(arrayBuffer, 12))
}

// --- small metadata (file name + type) ---

export async function encryptMeta(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj))))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv); out.set(ct, 12)
  return b64uEncode(out)
}

export async function decryptMeta(key, str) {
  const bytes = b64uDecode(str)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12))
  return JSON.parse(td.decode(pt))
}
