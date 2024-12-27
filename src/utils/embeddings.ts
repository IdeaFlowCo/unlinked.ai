const OPENAI_KEY = process.env.OPENAI_KEY || ''

export async function getProfileEmbedding(text: string): Promise<number[]> {
  if (!OPENAI_KEY) {
    console.warn('OpenAI API key not found. Semantic search will be disabled.')
    return new Array(1536).fill(0)
  }

  try {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: 'text-embedding-ada-002',
        input: text
      })
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(`OpenAI API error: ${error.error?.message || 'Unknown error'}`)
    }

    const json = await response.json()
    return json.data[0].embedding
  } catch (error) {
    console.error('Error generating embedding:', error)
    // Return zero vector as fallback
    return new Array(1536).fill(0)
  }
}

// Helper function to combine profile fields for embedding
export function getProfileEmbeddingText(profile: {
  first_name?: string
  last_name?: string
  headline?: string
  industry?: string
}): string {
  const fields = [
    profile.first_name,
    profile.last_name,
    profile.headline,
    profile.industry
  ]
  return fields.filter(Boolean).join(' ')
}
