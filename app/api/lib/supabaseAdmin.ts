// Server-side-only Supabase client using the service-role key, which bypasses Row
// Level Security entirely. Used exclusively by the scan-batch endpoints to read/
// write the private 'scan-uploads' storage bucket (original multi-page scan PDFs)
// — the anon key used by the browser (src/lib/supabase.ts) never touches that
// bucket directly, by design (see 0008_scan_batches.sql).
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the Vercel project's
// environment variables (and a local .env for `vercel dev`) — see .env.example.
// Never import this from anything that ships to the browser.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let cached: SupabaseClient | null = null

export function getSupabaseAdmin(): SupabaseClient {
  if (cached) return cached

  const url = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceRoleKey) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set — add them to the Vercel project env vars')
  }

  cached = createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  })
  return cached
}
