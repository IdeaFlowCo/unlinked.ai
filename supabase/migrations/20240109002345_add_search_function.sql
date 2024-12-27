-- Enable vector extension if not already enabled
create extension if not exists vector;

-- Add embedding column to profiles if it doesn't exist
alter table profiles add column if not exists embedding vector(1536);

-- Create or replace the search_profiles function
create or replace function search_profiles(
  query_embedding vector(1536),
  match_threshold float,
  match_count int
)
returns table (
  id uuid,
  first_name text,
  last_name text,
  headline text,
  industry text,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    p.id,
    p.first_name,
    p.last_name,
    p.headline,
    p.industry,
    1 - (p.embedding <=> query_embedding) as similarity
  from profiles p
  where 1 - (p.embedding <=> query_embedding) > match_threshold
  order by similarity desc
  limit match_count;
end;
$$;

-- Grant execute permission to authenticated users
grant execute on function search_profiles(vector, float, int) to authenticated;
