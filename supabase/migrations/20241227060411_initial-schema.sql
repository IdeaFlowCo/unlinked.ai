create extension if not exists vector with schema extensions;
create extension if not exists moddatetime with schema extensions;

create table profiles (
    id uuid primary key, --references auth.users on delete cascade,
    first_name text,
    last_name text,
    headline text,
    linkedin_slug text unique,
    is_shadow boolean default false,
    summary text,
    industry text,
    created_at timestamp with time zone default now(),
    updated_at timestamp with time zone default now()
);

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

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();



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

create table uploads (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users not null,
    file_name text not null,
    file_path text not null,
    created_at timestamp with time zone default now()
);



create table onboarding_state (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  current_step integer not null default 1,
  completed_at timestamp with time zone,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique(user_id)
);

create trigger handle_updated_at before update on onboarding_state
  for each row execute procedure moddatetime (updated_at);

create index on connections(profile_id_a);
create index on connections(profile_id_b);
