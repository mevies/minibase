insert into auth.users(id, aud, role, email, raw_user_meta_data)
values
  (
    '11111111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'alice@example.com',
    '{"display_name":"Alice"}'::jsonb
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'bob@example.com',
    '{"display_name":"Bob"}'::jsonb
  );

insert into public.notes(owner_id, body)
values
  ('11111111-1111-4111-8111-111111111111', 'Alice note'),
  ('22222222-2222-4222-8222-222222222222', 'Bob note');
