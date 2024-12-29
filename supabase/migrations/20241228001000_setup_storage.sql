-- Enable storage by creating the storage schema
create schema if not exists storage;

-- Create the linkedin bucket if it doesn't exist
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('linkedin', 'linkedin', false, 52428800, array['text/csv'])
on conflict (id) do update set
  public = false,
  file_size_limit = 52428800,
  allowed_mime_types = array['text/csv'];

-- Create storage policy for authenticated users
create policy "Allow authenticated users to upload CSV files"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'linkedin'
    and storage.foldername(name) = ''
    and storage.extension(name) = 'csv'
  );

create policy "Allow authenticated users to read their own files"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'linkedin'
    and auth.uid() = owner
  );

create policy "Allow authenticated users to delete their own files"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'linkedin'
    and auth.uid() = owner
  );
