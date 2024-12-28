-- Enable RLS on tables
alter table profiles enable row level security;
alter table connections enable row level security;
alter table companies enable row level security;
alter table institutions enable row level security;
alter table positions enable row level security;
alter table education enable row level security;
alter table skills enable row level security;

-- Grant usage on schema
grant usage on schema public to authenticated, anon;

-- Grant access to tables for authenticated users
grant select on all tables in schema public to authenticated;
grant insert, update, delete on profiles to authenticated;
grant insert, update, delete on connections to authenticated;
grant insert on companies to authenticated;
grant insert on institutions to authenticated;
grant insert, update, delete on positions to authenticated;
grant insert, update, delete on education to authenticated;
grant insert, update, delete on skills to authenticated;

-- Grant limited access to anonymous users
grant select on profiles to anon;
grant select on connections to anon;
grant select on companies to anon;
grant select on institutions to anon;
grant select on positions to anon;
grant select on education to anon;
grant select on skills to anon;

-- RLS policies for profiles
create policy "Users can view all profiles"
    on profiles for select
    to authenticated, anon
    using (true);

create policy "Users can update their own profile"
    on profiles for update
    to authenticated
    using (auth.uid() = user_id);

create policy "Users can delete their own profile"
    on profiles for delete
    to authenticated
    using (auth.uid() = user_id);

-- RLS policies for connections
create policy "Users can view all connections"
    on connections for select
    to authenticated, anon
    using (true);

create policy "Users can manage their own connections"
    on connections for all
    to authenticated
    using (
        exists (
            select 1 from profiles
            where id in (profile_id_a, profile_id_b)
            and user_id = auth.uid()
        )
    );

-- RLS policies for companies and institutions
create policy "Anyone can view companies"
    on companies for select
    to authenticated, anon
    using (true);

create policy "Anyone can view institutions"
    on institutions for select
    to authenticated, anon
    using (true);

create policy "Authenticated users can create companies"
    on companies for insert
    to authenticated
    with check (true);

create policy "Authenticated users can create institutions"
    on institutions for insert
    to authenticated
    with check (true);

-- RLS policies for positions
create policy "Anyone can view positions"
    on positions for select
    to authenticated, anon
    using (true);

create policy "Users can manage their own positions"
    on positions for all
    to authenticated
    using (
        exists (
            select 1 from profiles
            where profiles.id = positions.profile_id
            and profiles.user_id = auth.uid()
        )
    );

-- RLS policies for education
create policy "Anyone can view education"
    on education for select
    to authenticated, anon
    using (true);

create policy "Users can manage their own education"
    on education for all
    to authenticated
    using (
        exists (
            select 1 from profiles
            where profiles.id = education.profile_id
            and profiles.user_id = auth.uid()
        )
    );

-- RLS policies for skills
create policy "Anyone can view skills"
    on skills for select
    to authenticated, anon
    using (true);

create policy "Users can manage their own skills"
    on skills for all
    to authenticated
    using (
        exists (
            select 1 from profiles
            where profiles.id = skills.profile_id
            and profiles.user_id = auth.uid()
        )
    );
