-- Enable row level security
alter table profiles enable row level security;
alter table companies enable row level security;
alter table positions enable row level security;
alter table institutions enable row level security;
alter table education enable row level security;
alter table skills enable row level security;
alter table connections enable row level security;

-- Create policies for public read access
create policy "Public profiles are viewable by everyone"
on profiles for select
to anon
using (true);

create policy "Public companies are viewable by everyone"
on companies for select
to anon
using (true);

create policy "Public positions are viewable by everyone"
on positions for select
to anon
using (true);

create policy "Public institutions are viewable by everyone"
on institutions for select
to anon
using (true);

create policy "Public education records are viewable by everyone"
on education for select
to anon
using (true);

create policy "Public skills are viewable by everyone"
on skills for select
to anon
using (true);

create policy "Public connections are viewable by everyone"
on connections for select
to anon
using (true);
