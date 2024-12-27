import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  console.log('Creating browser client with:', {
    url: supabaseUrl,
    hasKey: !!supabaseAnonKey,
    origin: typeof window !== 'undefined' ? window.location.origin : 'server'
  });
  
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('Missing required environment variables');
    throw new Error('Missing required environment variables');
  }

  return createBrowserClient(
    supabaseUrl,
    supabaseAnonKey
  )
}
