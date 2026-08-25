create policy "Users can upload own avatars"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'avatars'
  and owner = auth.uid()
);

create policy "Users can read own avatars"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'avatars'
  and owner = auth.uid()
);

create policy "Users can delete own avatars"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'avatars'
  and owner = auth.uid()
);
