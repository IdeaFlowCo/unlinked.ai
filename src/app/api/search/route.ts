import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/utils/supabase/server'

export async function POST(request: NextRequest) {
  try {
    const { query } = await request.json()
    
    const supabase = await createClient()
    
    // Basic text search using ilike
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('*')
      .or(`first_name.ilike.%${query}%,last_name.ilike.%${query}%,headline.ilike.%${query}%`)

    if (error) {
      console.error('Error searching profiles:', error)
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      )
    }

    return NextResponse.json({ profiles })
  } catch (e) {
    console.error('Unexpected error:', e)
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    )
  }
}
