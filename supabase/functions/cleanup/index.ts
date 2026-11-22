// Deletes storage objects whose file has expired, been burned, or never got a
// row. Called every 10 minutes by the 'airdrop-cleanup' pg_cron job.
//
// Deploy with JWT verification OFF (the cron job calls it without a token).
// That is safe: it only ever removes objects the database already marked dead.

import { createClient } from 'npm:@supabase/supabase-js@2.118.0'

// New projects expose secret keys as JSON in SUPABASE_SECRET_KEYS; older ones
// expose SUPABASE_SERVICE_ROLE_KEY. CLEANUP_SECRET_KEY is a manual override.
function secretKey(): string {
  const manual = Deno.env.get('CLEANUP_SECRET_KEY')
  if (manual) return manual
  const keys = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (keys) {
    const parsed = JSON.parse(keys) as Record<string, string>
    const key = parsed.default ?? Object.values(parsed)[0]
    if (key) return key
  }
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (legacy) return legacy
  throw new Error('no secret key in environment')
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

Deno.serve(async () => {
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, secretKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data, error } = await sb.rpc('cleanup_targets')
    if (error) return json({ error: error.message }, 500)

    const names = (data as { name: string }[]).map(r => r.name)
    let removed = 0
    for (let i = 0; i < names.length; i += 100) {
      const { data: gone, error: rmError } = await sb.storage.from('drops').remove(names.slice(i, i + 100))
      if (rmError) return json({ error: rmError.message, removed }, 500)
      removed += gone?.length ?? 0
    }
    return json({ candidates: names.length, removed })
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})
