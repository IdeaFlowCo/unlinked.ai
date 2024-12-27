import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('Missing required environment variables');
    throw new Error('Missing required environment variables');
  }

  try {
    console.log('Creating browser client with:', {
      url: supabaseUrl,
      hasKey: !!supabaseAnonKey,
      keyLength: supabaseAnonKey?.length,
      origin: typeof window !== 'undefined' ? window.location.origin : 'server',
      window: typeof window !== 'undefined',
      document: typeof document !== 'undefined'
    });

    const client = createBrowserClient(
      supabaseUrl,
      supabaseAnonKey
    );

    console.log('Supabase client created successfully');
    return client;
  } catch (error) {
    console.error('Error creating Supabase client:', error);
    throw error;
  }
}
