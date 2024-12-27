import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/utils/supabase/server'
import OpenAI from 'openai'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

export async function POST(request: NextRequest) {
  try {
    const { query } = await request.json()
    
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { error: 'OpenAI API key not configured' },
        { status: 500 }
      )
    }

    // Generate embedding for the search query
    const embedding = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: query
    })

    const supabase = await createClient()
    
    // Use the embedding vector to search profiles
    const { data: profiles, error } = await supabase.rpc('search_profiles', {
      query_embedding: embedding.data[0].embedding,
      match_threshold: 0.5,
      match_count: 10
    })

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
