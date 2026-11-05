// Creates the single Supabase client used by the whole site.
// The library itself is served from /js/vendor/supabase.js (no third-party CDN).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const hasValidSupabaseUrl =
  /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(SUPABASE_URL) &&
  !SUPABASE_URL.includes('YOUR-PROJECT-REF');

const hasValidAnonKey =
  typeof SUPABASE_ANON_KEY === 'string' &&
  SUPABASE_ANON_KEY.startsWith('sb_') &&
  !SUPABASE_ANON_KEY.includes('YOUR-SUPABASE-ANON-KEY');

export const isConfigured = hasValidSupabaseUrl && hasValidAnonKey;

if (!window.supabase || typeof window.supabase.createClient !== 'function') {
  throw new Error('The Supabase library did not load.');
}

export const db = window.supabase.createClient(
  isConfigured ? SUPABASE_URL : 'https://placeholder.supabase.co',
  isConfigured ? SUPABASE_ANON_KEY : 'placeholder',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
);
