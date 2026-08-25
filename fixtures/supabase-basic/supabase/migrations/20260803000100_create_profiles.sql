create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

grant select on public.profiles to authenticated;

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.profiles(id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'display_name');
  return new;
end
$function$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();
