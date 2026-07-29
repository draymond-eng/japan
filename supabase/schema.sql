-- =============================================================================
-- Japan 2027 — Supabase setup.
-- Run this once in your project: Supabase Dashboard → SQL Editor → paste → Run.
-- Then put your Project URL + anon key into js/config.js.
--
-- NOTE on security: this is a small private friends' app with no login, so the
-- policies below let the anon key read/write these tables. That's the standard
-- tradeoff for a no-auth shared app. If you ever want it locked down, we can add
-- Supabase Auth + per-user policies later.
-- =============================================================================

-- ---- Tables ----------------------------------------------------------------
create table if not exists public.votes (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null,          -- 'decision' | 'stay' | 'idea'
  topic      text not null,          -- decision id / city / idea id
  choice     text not null,          -- option id (or 'up' for ideas)
  voter      text not null,          -- traveler id: dj, laura, ali, draymond, curtis, alexis
  created_at timestamptz default now(),
  unique (kind, topic, voter)        -- one vote per person per topic (upsert)
);

create table if not exists public.expenses (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,
  amount      numeric not null,
  currency    text not null default 'JPY',
  paid_by     text not null,
  split_among text[] not null default '{}',
  created_at  timestamptz default now()
);

create table if not exists public.ideas (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  note       text default '',
  city       text default 'any',
  author     text default '',
  created_at timestamptz default now()
);

create table if not exists public.photos (
  id         uuid primary key default gen_random_uuid(),
  path       text not null,
  url        text not null,
  caption    text default '',
  author     text default '',
  created_at timestamptz default now()
);

-- ---- Row-level security: open policies (no-auth friends app) ----------------
alter table public.votes    enable row level security;
alter table public.expenses enable row level security;
alter table public.ideas    enable row level security;
alter table public.photos   enable row level security;

drop policy if exists "anon votes"    on public.votes;
drop policy if exists "anon expenses" on public.expenses;
drop policy if exists "anon ideas"    on public.ideas;
drop policy if exists "anon photos"   on public.photos;

create policy "anon votes"    on public.votes    for all using (true) with check (true);
create policy "anon expenses" on public.expenses for all using (true) with check (true);
create policy "anon ideas"    on public.ideas    for all using (true) with check (true);
create policy "anon photos"   on public.photos   for all using (true) with check (true);

-- ---- Realtime (so tallies/feeds update live) -------------------------------
-- Ignore "already member of publication" errors if you re-run this.
alter publication supabase_realtime add table public.votes;
alter publication supabase_realtime add table public.expenses;
alter publication supabase_realtime add table public.ideas;
alter publication supabase_realtime add table public.photos;

-- ---- Group-submitted decisions & stay options ------------------------------
create table if not exists public.decisions (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  note       text default '',
  options    jsonb not null default '[]',  -- [{id, label, note}]
  status     text default 'open',
  author     text default '',
  created_at timestamptz default now()
);

create table if not exists public.stay_options (
  id         uuid primary key default gen_random_uuid(),
  city       text not null,                -- tokyo | hakone | kyoto
  name       text not null,
  tag        text default '',
  note       text default '',
  link       text default '',
  lat        double precision,
  lng        double precision,
  author     text default '',
  created_at timestamptz default now()
);

alter table public.decisions    enable row level security;
alter table public.stay_options enable row level security;

drop policy if exists "anon decisions"    on public.decisions;
drop policy if exists "anon stay_options" on public.stay_options;
create policy "anon decisions"    on public.decisions    for all using (true) with check (true);
create policy "anon stay_options" on public.stay_options for all using (true) with check (true);

create table if not exists public.flights (
  id         uuid primary key default gen_random_uuid(),
  traveler   text not null,                -- traveler id
  dir        text not null,                -- 'arrive' | 'depart'
  airline    text default '',
  flight_no  text default '',
  airport    text default '',
  date       text default '',
  time       text default '',
  note       text default '',
  created_at timestamptz default now(),
  unique (traveler, dir)
);
alter table public.flights enable row level security;
drop policy if exists "anon flights" on public.flights;
create policy "anon flights" on public.flights for all using (true) with check (true);

create table if not exists public.fares (
  id         uuid primary key default gen_random_uuid(),
  route      text not null,                -- e.g. ORD-HND
  price      numeric not null,
  currency   text default 'USD',
  note       text default '',
  author     text default '',
  created_at timestamptz default now()
);
alter table public.fares enable row level security;
drop policy if exists "anon fares" on public.fares;
create policy "anon fares" on public.fares for all using (true) with check (true);

alter publication supabase_realtime add table public.decisions;
alter publication supabase_realtime add table public.stay_options;
alter publication supabase_realtime add table public.flights;
alter publication supabase_realtime add table public.fares;

-- ---- Notes / omiyage + confirmations vault ---------------------------------
create table if not exists public.notes (
  id         uuid primary key default gen_random_uuid(),
  list       text default 'note',          -- 'note' | 'omiyage'
  text       text not null,
  done       boolean default false,
  author     text default '',
  created_at timestamptz default now()
);

create table if not exists public.confirmations (
  id              uuid primary key default gen_random_uuid(),
  category        text default 'Other',
  label           text not null,
  confirmation_no text default '',
  url             text default '',
  path            text default '',
  author          text default '',
  created_at      timestamptz default now()
);

alter table public.notes         enable row level security;
alter table public.confirmations enable row level security;
drop policy if exists "anon notes"         on public.notes;
drop policy if exists "anon confirmations" on public.confirmations;
create policy "anon notes"         on public.notes         for all using (true) with check (true);
create policy "anon confirmations" on public.confirmations for all using (true) with check (true);
alter publication supabase_realtime add table public.notes;
alter publication supabase_realtime add table public.confirmations;

-- ---- Storage bucket for photos ---------------------------------------------
insert into storage.buckets (id, name, public)
values ('trip-photos', 'trip-photos', true)
on conflict (id) do nothing;

drop policy if exists "trip-photos read"   on storage.objects;
drop policy if exists "trip-photos insert" on storage.objects;
drop policy if exists "trip-photos delete" on storage.objects;

create policy "trip-photos read"   on storage.objects for select using (bucket_id = 'trip-photos');
create policy "trip-photos insert" on storage.objects for insert with check (bucket_id = 'trip-photos');
create policy "trip-photos delete" on storage.objects for delete using (bucket_id = 'trip-photos');
