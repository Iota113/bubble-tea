-- =============================================================================
-- Study-break bubble tea night: Supabase schema
-- Paste this whole file into Supabase -> SQL Editor -> Run.
-- Safe to re-run: tables/rows are only created if missing, functions are replaced.
--
-- Security model:
--   * RLS is ON for every table and there are NO policies, and table privileges
--     are revoked from anon/authenticated. The browser cannot touch tables.
--   * The browser only calls the SECURITY DEFINER functions at the bottom.
--   * Door functions check a shared PIN; only its sha256 hash is stored, in a
--     table nobody but the database owner can read.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.settings (
  id              boolean primary key default true check (id),  -- forces a single row
  cup_limit       int  not null default 150 check (cup_limit >= 0),
  cups_given      int  not null default 0   check (cups_given >= 0),
  rsvp_closes_at  timestamptz not null,
  event_name      text not null,
  event_time      text not null,
  event_location  text not null
);

create table if not exists public.secrets (
  id            boolean primary key default true check (id),
  door_pin_hash text not null           -- hex sha256 of the PIN, see set_door_pin()
);

create table if not exists public.rsvps (
  id          bigint generated always as identity primary key,
  name        text not null,
  tele_handle text,
  created_at  timestamptz not null default now(),
  arrived_at  timestamptz
);

create index if not exists rsvps_name_idx on public.rsvps (lower(name));

-- ---------------------------------------------------------------------------
-- Initial config  (only inserted the first time; edit later with UPDATE, see README)
-- ---------------------------------------------------------------------------

insert into public.settings (cup_limit, rsvp_closes_at, event_name, event_time, event_location)
values (
  150,                                          -- PLACEHOLDER: cup limit (default 150)
  '2026-11-20 18:00:00+08',                     -- PLACEHOLDER: RSVP deadline, in SGT (+08)
  'Study Break: Free Bubble Tea Night',
  'DATE TBC · 7–9pm',                           -- PLACEHOLDER: event date
  'COM1 Foyer, NUS'
)
on conflict (id) do nothing;

insert into public.secrets (door_pin_hash)
values (encode(sha256(convert_to('CHANGE-ME', 'UTF8')), 'hex'))  -- PLACEHOLDER: door PIN, change with set_door_pin()
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Lock the tables down
-- ---------------------------------------------------------------------------

alter table public.settings enable row level security;
alter table public.secrets  enable row level security;
alter table public.rsvps    enable row level security;

-- Supabase grants anon/authenticated full table privileges by default; RLS with
-- no policies already blocks them, this removes the privileges as well.
revoke all on public.settings, public.secrets, public.rsvps from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable from the browser)
-- ---------------------------------------------------------------------------

create or replace function public._require_pin(p_pin text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from secrets
    where id and door_pin_hash = encode(sha256(convert_to(coalesce(p_pin, ''), 'UTF8')), 'hex')
  ) then
    raise exception 'bad_pin' using errcode = '28P01';
  end if;
end;
$$;

-- Run in the SQL editor:  select public.set_door_pin('your-new-pin');
create or replace function public.set_door_pin(p_new_pin text)
returns void
language sql
security definer
set search_path = public
as $$
  update secrets set door_pin_hash = encode(sha256(convert_to(p_new_pin, 'UTF8')), 'hex') where id;
$$;

-- ---------------------------------------------------------------------------
-- Public functions
-- ---------------------------------------------------------------------------

create or replace function public.get_public_status()
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'cups_given',     cups_given,
    'cup_limit',      cup_limit,
    'rsvp_open',      now() < rsvp_closes_at,
    'rsvp_closes_at', rsvp_closes_at,
    'event_name',     event_name,
    'event_time',     event_time,
    'event_location', event_location
  )
  from settings where id;
$$;

create or replace function public.submit_rsvp(p_name text, p_handle text default null)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_name   text := left(btrim(coalesce(p_name, '')), 80);
  v_handle text := left(ltrim(btrim(coalesce(p_handle, '')), '@'), 40);
begin
  if now() >= (select rsvp_closes_at from settings where id) then
    raise exception 'rsvp_closed';
  end if;
  if v_name = '' then
    raise exception 'name_required';
  end if;

  insert into rsvps (name, tele_handle)
  values (v_name, nullif(v_handle, ''));

  return json_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Door functions (all require the PIN)
-- ---------------------------------------------------------------------------

create or replace function public.give_cup(p_pin text)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_given int;
  v_limit int;
begin
  perform _require_pin(p_pin);

  -- One atomic statement: concurrent callers queue on the row lock and each
  -- re-checks the WHERE against the latest value, so this can never pass the cap.
  update settings
     set cups_given = cups_given + 1
   where id and cups_given < cup_limit
  returning cups_given, cup_limit into v_given, v_limit;

  if v_given is null then
    select cups_given, cup_limit into v_given, v_limit from settings where id;
    return json_build_object('status', 'sold_out', 'cups_given', v_given, 'cup_limit', v_limit);
  end if;

  return json_build_object('status', 'ok', 'cups_given', v_given, 'cup_limit', v_limit);
end;
$$;

create or replace function public.undo_cup(p_pin text)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_given int;
  v_limit int;
begin
  perform _require_pin(p_pin);

  update settings
     set cups_given = greatest(cups_given - 1, 0)
   where id
  returning cups_given, cup_limit into v_given, v_limit;

  return json_build_object('status', 'ok', 'cups_given', v_given, 'cup_limit', v_limit);
end;
$$;

create or replace function public.door_stats(p_pin text)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_given   int;
  v_limit   int;
  v_total   int;
  v_arrived int;
begin
  perform _require_pin(p_pin);

  select cups_given, cup_limit into v_given, v_limit from settings where id;
  select count(*), count(arrived_at) into v_total, v_arrived from rsvps;

  return json_build_object(
    'cups_given',     v_given,
    'cup_limit',      v_limit,
    'rsvps_total',    v_total,
    'rsvps_arrived',  v_arrived,
    'walk_ins',       greatest(v_given - v_arrived, 0)
  );
end;
$$;

create or replace function public.search_rsvps(p_pin text, p_q text default '')
returns table (id bigint, name text, tele_handle text, created_at timestamptz, arrived_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  -- escape LIKE wildcards so the search is a plain substring match
  v_pattern text := '%' || replace(replace(replace(btrim(coalesce(p_q, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
begin
  perform _require_pin(p_pin);

  return query
    select r.id, r.name, r.tele_handle, r.created_at, r.arrived_at
      from rsvps r
     where r.name ilike v_pattern or coalesce(r.tele_handle, '') ilike v_pattern
     order by lower(r.name), r.id
     limit 50;
end;
$$;

create or replace function public.mark_arrived(p_pin text, p_id bigint, p_arrived boolean default true)
returns table (id bigint, name text, tele_handle text, created_at timestamptz, arrived_at timestamptz)
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  perform _require_pin(p_pin);

  return query
    update rsvps r
       set arrived_at = case when p_arrived then coalesce(r.arrived_at, now()) else null end
     where r.id = p_id
    returning r.id, r.name, r.tele_handle, r.created_at, r.arrived_at;
end;
$$;

create or replace function public.export_rsvps(p_pin text)
returns table (id bigint, name text, tele_handle text, created_at timestamptz, arrived_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform _require_pin(p_pin);

  return query
    select r.id, r.name, r.tele_handle, r.created_at, r.arrived_at
      from rsvps r
     order by r.created_at, r.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges: only the browser-facing functions are callable by anon
-- ---------------------------------------------------------------------------

revoke all on function public._require_pin(text)               from public, anon, authenticated;
revoke all on function public.set_door_pin(text)               from public, anon, authenticated;
revoke all on function public.get_public_status()              from public;
revoke all on function public.submit_rsvp(text, text)          from public;
revoke all on function public.give_cup(text)                   from public;
revoke all on function public.undo_cup(text)                   from public;
revoke all on function public.door_stats(text)                 from public;
revoke all on function public.search_rsvps(text, text)         from public;
revoke all on function public.mark_arrived(text, bigint, boolean) from public;
revoke all on function public.export_rsvps(text)               from public;

grant execute on function public.get_public_status()              to anon, authenticated;
grant execute on function public.submit_rsvp(text, text)          to anon, authenticated;
grant execute on function public.give_cup(text)                   to anon, authenticated;
grant execute on function public.undo_cup(text)                   to anon, authenticated;
grant execute on function public.door_stats(text)                 to anon, authenticated;
grant execute on function public.search_rsvps(text, text)         to anon, authenticated;
grant execute on function public.mark_arrived(text, bigint, boolean) to anon, authenticated;
grant execute on function public.export_rsvps(text)               to anon, authenticated;
