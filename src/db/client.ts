import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { env } from "../config/env";

let supabase: SupabaseClient;

/**
 * Get the Supabase client (singleton).
 * Uses service role key for full DB access from backend.
 */
export function getSupabaseClient(): SupabaseClient {
  if (!supabase) {
    supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return supabase;
}
