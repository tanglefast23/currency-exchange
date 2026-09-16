-- Rates (currency-exchange) — one row per signed-in person.
-- Run this once in the Supabase SQL editor.
-- Table prefix cx_ keeps this app separate from others in the same project.

create table if not exists public.cx_prefs (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  base       text not null default 'USD',
  amount     numeric not null default 100,
  list       text[] not null default array[]::text[],
  updated_at timestamptz not null default now()
);

alter table public.cx_prefs enable row level security;

-- Every policy is "your own row only": auth.uid() comes from the signed-in
-- user's JWT, so the anon key alone cannot read or write anybody's data.
drop policy if exists cx_prefs_select_own on public.cx_prefs;
create policy cx_prefs_select_own on public.cx_prefs
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists cx_prefs_insert_own on public.cx_prefs;
create policy cx_prefs_insert_own on public.cx_prefs
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists cx_prefs_update_own on public.cx_prefs;
create policy cx_prefs_update_own on public.cx_prefs
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists cx_prefs_delete_own on public.cx_prefs;
create policy cx_prefs_delete_own on public.cx_prefs
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.cx_prefs from anon;
grant select, insert, update, delete on public.cx_prefs to authenticated;
