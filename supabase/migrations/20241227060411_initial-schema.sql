-- Enable vector extension
create extension if not exists vector;

-- Core tables
create table user_uploads (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users not null,
    file_name text not null,
    file_content text not null,
    created_at timestamp with time zone default now()
);

create table profiles (
    id uuid primary key, --references auth.users on delete cascade,
    first_name text,
    last_name text,
    headline text,
    summary text,
    industry text,
    embedding vector(1536),
    created_at timestamp with time zone default now(),
    updated_at timestamp with time zone default now()
);

create table companies (
    id uuid primary key default gen_random_uuid(),
    name text not null unique,
    created_at timestamp with time zone default now()
);

create table positions (
    id uuid primary key default gen_random_uuid(),
    profile_id uuid references profiles(id) on delete cascade,
    company_id uuid references companies(id),
    title text,
    description text,
    started_on date,
    finished_on date,
    created_at timestamp with time zone default now()
);

create table institutions (
    id uuid primary key default gen_random_uuid(),
    name text not null unique,
    created_at timestamp with time zone default now()
);

create table education (
    id uuid primary key default gen_random_uuid(),
    profile_id uuid references profiles(id) on delete cascade,
    institution_id uuid references institutions(id),
    degree_name text,
    started_on date,
    finished_on date,
    created_at timestamp with time zone default now()
);

create table skills (
    id uuid primary key default gen_random_uuid(),
    profile_id uuid references profiles(id) on delete cascade,
    name text not null,
    created_at timestamp with time zone default now()
);

create table connections (
    id uuid primary key default gen_random_uuid(),
    profile_id_a uuid references profiles(id) on delete cascade,
    profile_id_b uuid references profiles(id) on delete cascade,
    created_at timestamp with time zone default now(),
    unique(profile_id_a, profile_id_b),
    check (profile_id_a < profile_id_b)
);

-- Find paths between profiles with configurable max length
create or replace function get_paths(
    start_profile_id uuid,
    end_profile_id uuid,
    max_length int default 6
)
returns table (
    path uuid[],
    length int
)
language sql stable
as $$
    with recursive paths as (
        -- Base: direct connections
        select
            array[profile_id_a, profile_id_b] as path,
            case 
                when profile_id_a = start_profile_id then profile_id_b
                else profile_id_a
            end as last_node,
            1 as length
        from connections
        where profile_id_a = start_profile_id or profile_id_b = start_profile_id

        union all

        -- Recursive: extend path
        select
            p.path || 
            case 
                when c.profile_id_a = p.last_node then c.profile_id_b
                else c.profile_id_a
            end,
            case 
                when c.profile_id_a = p.last_node then c.profile_id_b
                else c.profile_id_a
            end,
            p.length + 1
        from paths p
        join connections c on 
            (c.profile_id_a = p.last_node or c.profile_id_b = p.last_node)
            and not (c.profile_id_a = any(p.path) and c.profile_id_b = any(p.path))
        where p.length < max_length
    )
    select 
        path,
        length
    from paths
    where last_node = end_profile_id
    order by length
$$;

-- Get path details including profile info
create or replace function get_path_details(path uuid[])
returns jsonb
language sql stable
as $$
    select jsonb_agg(
        jsonb_build_object(
            'id', p.id,
            'name', p.first_name || ' ' || p.last_name,
            'headline', p.headline
        )
        order by idx
    )
    from unnest(path) with ordinality as x(id, idx)
    join profiles p on p.id = x.id
$$;

-- Semantic search
create or replace function search_profiles(
    query_embedding vector(1536),
    match_threshold float default 0.7,
    match_count int default 10
)
returns table (
    id uuid,
    name text,
    headline text,
    similarity float
)
language sql stable
as $$
    select
        id,
        first_name || ' ' || last_name as name,
        headline,
        1 - (embedding <=> query_embedding) as similarity
    from profiles
    where 1 - (embedding <=> query_embedding) > match_threshold
    order by embedding <=> query_embedding
    limit match_count;
$$;

-- Helpful indexes
create index on profiles using ivfflat (embedding vector_cosine_ops);
create index on connections(profile_id_a);
create index on connections(profile_id_b);

-- Handle new user signups
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, first_name, last_name)
  values (new.id, new.raw_user_meta_data ->> 'first_name', new.raw_user_meta_data ->> 'last_name');
  return new;
end;
$$;

-- trigger the function every time a user is created
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
