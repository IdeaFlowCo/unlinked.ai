-- Enable RLS
alter table profiles enable row level security;

-- Allow authenticated users to insert their own profile
create policy "Users can insert their own profile"
  on profiles for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Allow authenticated users to update their own profile
create policy "Users can update own profile"
  on profiles for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Allow authenticated users to read all profiles
create policy "Anyone can view profiles"
  on profiles for select
  to authenticated
  using (true);

-- Grant usage on schema
grant usage on schema public to anon, authenticated;

-- Grant access to profiles table
grant all on profiles to authenticated;
grant select on profiles to anon;
