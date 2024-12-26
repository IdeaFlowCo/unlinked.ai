-- Create tables for LinkedIn data
begin;

-- Drop existing tables
drop table if exists connections cascade;
drop table if exists skills cascade;
drop table if exists education cascade;
drop table if exists positions cascade;
drop table if exists profiles cascade;

-- Create new tables
create table profiles (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade,
  first_name text,
  last_name text,
  maiden_name text,
  email_address text,
  headline text,
  summary text,
  industry text,
  location text,
  address text,
  birth_date text,
  zip_code text,
  geo_location text,
  twitter_handles text,
  websites text,
  instant_messengers text,
  current_company text,
  current_position text,
  linkedin_url_slug text unique,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create table positions (
  id uuid default gen_random_uuid() primary key,
  profile_id uuid references profiles(id) on delete cascade,
  company_name text,
  title text,
  description text,
  location text,
  started_on text, -- storing as text for MVP
  finished_on text, -- storing as text for MVP
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create table education (
  id uuid default gen_random_uuid() primary key,
  profile_id uuid references profiles(id) on delete cascade,
  school_name text,
  degree_name text,
  start_date text, -- storing as text for MVP
  end_date text, -- storing as text for MVP
  activities text,
  notes text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create table skills (
  id uuid default gen_random_uuid() primary key,
  profile_id uuid references profiles(id) on delete cascade,
  name text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create table connections (
  id uuid default gen_random_uuid() primary key,
  user_profile_id uuid references profiles(id) on delete cascade, -- who uploaded
  connection_profile_id uuid references profiles(id) on delete cascade, -- shadow or real
  connected_on text, -- storing as text for MVP
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Create indexes for common queries
create index idx_profiles_user_id on profiles(user_id);
create index idx_profiles_linkedin_url_slug on profiles(linkedin_url_slug);
create index idx_positions_profile_id on positions(profile_id);
create index idx_education_profile_id on education(profile_id);
create index idx_skills_profile_id on skills(profile_id);
create index idx_connections_user_profile_id on connections(user_profile_id);
create index idx_connections_connection_profile_id on connections(connection_profile_id);

commit;
