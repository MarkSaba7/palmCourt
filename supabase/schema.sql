-- Palm Court: cloud saves and leaderboards on Supabase.
-- Paste this whole file into Dashboard → SQL editor → Run. It is safe to run again after an update (idempotent).
-- Needs Authentication → Sign In / Providers → "Allow anonymous sign-ins" (the game signs players in anonymously).
--
-- Trust model: the browser is untrusted.
--  * saves: one private row per player (RLS: owner only). Nothing online reads a save, so client-side currency
--    (Fuzz) never matters to anyone else.
--  * leaderboards: written only by submit_score(), a SECURITY DEFINER function that validates, clamps and
--    rate-limits every value. Clients can't insert or update score rows themselves.
--  * display names: set only through set_display_name(): trimmed, 3-16 characters, letters/digits/space/_-',
--    no emails or links, basic profanity filter.
--  * everyone (even signed-out visitors) can read the leaderboards through leaderboard(); user ids stay private.

-- ============================================================ cloud saves
create table if not exists public.saves (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  save       jsonb not null,
  version    integer not null default 1,                 -- the save's schema version (profile.js SCHEMA)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),        -- set by the server, never by the client
  constraint saves_is_object check (jsonb_typeof(save) = 'object'),
  constraint saves_size check (octet_length(save::text) <= 262144),
  constraint saves_version check (version between 1 and 1000)
);

-- Server-side timestamps, a fixed owner, and a small write rate limit.
create or replace function public.saves_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if old.updated_at > now() - interval '2 seconds' then
      raise exception 'Saving too often' using errcode = 'P0001', hint = 'Try again in a few seconds';
    end if;
    new.user_id := old.user_id;
    new.created_at := old.created_at;
  else
    new.created_at := now();
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists saves_touch on public.saves;
create trigger saves_touch before insert or update on public.saves for each row execute function public.saves_touch();

alter table public.saves enable row level security;
drop policy if exists "saves: owner reads" on public.saves;
drop policy if exists "saves: owner inserts" on public.saves;
drop policy if exists "saves: owner updates" on public.saves;
drop policy if exists "saves: owner deletes" on public.saves;
create policy "saves: owner reads" on public.saves for select to authenticated using ((select auth.uid()) = user_id);
create policy "saves: owner inserts" on public.saves for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "saves: owner updates" on public.saves for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "saves: owner deletes" on public.saves for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on public.saves from anon, authenticated;
grant select, insert, update, delete on public.saves to authenticated;

-- ============================================================ leaderboards
-- One row per board with its plausibility limits (readable by anyone, changed only here).
create table if not exists public.boards (
  id        text primary key,
  name      text not null,
  unit      text not null default '',
  max_value integer not null,   -- above this a submission is impossible and rejected
  cap       integer not null,   -- plausible ceiling: accepted values are clamped to it
  first_max integer not null,   -- ceiling for an account's first score on this board
  per_hour  numeric not null,   -- how fast a best score may grow
  burst     integer not null,   -- the most it may grow in one submission
  min_gap_s integer not null default 10,
  constraint boards_limits check (cap <= max_value and first_max <= cap and per_hour > 0 and burst > 0 and min_gap_s >= 0)
);
insert into public.boards (id, name, unit, max_value, cap, first_max, per_hour, burst, min_gap_s) values
  ('rating', 'World Tour ranking points', 'pts', 30000, 25000, 3000, 6000, 6000, 10),   -- rolling points: at most ~12 weeks x 2,000
  ('level',  'Player level',              '',    50,    50,    15,   12,   10,   10),
  ('streak', 'Longest win streak',        'wins', 1000, 500,   10,   30,   10,   10),
  ('serve',  'Fastest serve',             'km/h', 300,  250,   250,  100000, 1000, 10)  -- the game's serves top out near 215 km/h
on conflict (id) do update set name = excluded.name, unit = excluded.unit, max_value = excluded.max_value, cap = excluded.cap,
  first_max = excluded.first_max, per_hour = excluded.per_hour, burst = excluded.burst, min_gap_s = excluded.min_gap_s;

-- Scores: period 'all' (all-time best) and one row per season ('YYYY-MM', UTC month) with that season's best.
create table if not exists public.scores (
  user_id    uuid not null references auth.users (id) on delete cascade,
  board      text not null references public.boards (id) on delete cascade,
  period     text not null,
  value      integer not null,
  updated_at timestamptz not null default now(),   -- when the value last went up
  primary key (user_id, board, period),
  constraint scores_period check (period = 'all' or period ~ '^[0-9]{4}-[0-9]{2}$'),
  constraint scores_value check (value between 0 and 1000000)
);
create index if not exists scores_rank on public.scores (board, period, value desc, updated_at);

-- Public display names (no row = shown as "Player XXXX").
create table if not exists public.players (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  updated_at   timestamptz not null default now(),
  constraint players_name check (char_length(display_name) between 3 and 16 and display_name = btrim(display_name) and position('@' in display_name) = 0)
);

-- Private bookkeeping, only touched by the functions below.
create table if not exists public.rate_limits (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  window_start timestamptz not null default now(),
  calls        integer not null default 0
);
create table if not exists public.banned_words (
  word  text primary key,
  whole boolean not null default false   -- true: only as a whole word (so "Hancock" or "grape" stay fine)
);
insert into public.banned_words (word, whole) values
  ('fuck', false), ('fuk', false), ('shit', false), ('cunt', false), ('bitch', false), ('nigg', false), ('fagg', false),
  ('whore', false), ('slut', false), ('pussy', false), ('asshole', false), ('bastard', false), ('retard', false),
  ('twat', false), ('wank', false), ('rapist', false), ('nazi', false), ('hitler', false), ('porn', false), ('penis', false),
  ('vagina', false), ('dildo', false), ('kkk', false), ('admin', false), ('moderator', false), ('palmcourt', false),
  ('cock', true), ('dick', true), ('fag', true), ('spic', true), ('kike', true), ('chink', true), ('coon', true),
  ('rape', true), ('tits', true), ('cum', true), ('sex', true), ('anal', true), ('ass', true), ('staff', true), ('official', true)
on conflict (word) do nothing;

alter table public.boards enable row level security;
alter table public.scores enable row level security;
alter table public.players enable row level security;
alter table public.rate_limits enable row level security;
alter table public.banned_words enable row level security;
drop policy if exists "boards: anyone reads" on public.boards;
drop policy if exists "scores: owner reads" on public.scores;
drop policy if exists "players: owner reads" on public.players;
create policy "boards: anyone reads" on public.boards for select to anon, authenticated using (true);
create policy "scores: owner reads" on public.scores for select to authenticated using ((select auth.uid()) = user_id);
create policy "players: owner reads" on public.players for select to authenticated using ((select auth.uid()) = user_id);
-- No insert/update/delete policies: those go through the functions. rate_limits and banned_words: no policies at all.
revoke all on public.boards, public.scores, public.players, public.rate_limits, public.banned_words from anon, authenticated;
grant select on public.boards to anon, authenticated;
grant select on public.scores, public.players to authenticated;

-- ============================================================ functions
create or replace function public.current_season() returns text
language sql stable set search_path = '' as $$ select to_char(now() at time zone 'utc', 'YYYY-MM') $$;

-- true while p_uid has made at most p_max calls in the current window (counts this call).
create or replace function public.rate_ok(p_uid uuid, p_max integer default 40, p_window interval default interval '10 minutes')
returns boolean language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into public.rate_limits as r (user_id, window_start, calls) values (p_uid, now(), 1)
  on conflict (user_id) do update set
    calls = case when r.window_start < now() - p_window then 1 else r.calls + 1 end,
    window_start = case when r.window_start < now() - p_window then now() else r.window_start end
  returning calls into n;
  return n <= p_max;
end $$;

-- A display name, cleaned, or an exception with a readable message.
create or replace function public.clean_display_name(p_name text) returns text
language plpgsql stable set search_path = '' as $$
declare
  n text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  flat text; squeezed text; words text[];
begin
  if char_length(n) < 3 or char_length(n) > 16 then
    raise exception 'Names are 3 to 16 characters' using errcode = '22023';
  end if;
  if n !~ '^[[:alnum:]À-ɏ][[:alnum:]À-ɏ _''-]*$' then   -- accented Latin letters too, whatever the database locale
    raise exception 'Use letters, numbers, spaces, - _ or '' only' using errcode = '22023';
  end if;
  if char_length(regexp_replace(n, '[^0-9]', '', 'g')) > 6 then
    raise exception 'Too many digits for a name' using errcode = '22023';
  end if;
  -- lower-case, common look-alike digits undone; letters only for the substring test, words for the whole-word test
  flat := translate(lower(n), '0134578', 'oieastb');
  words := regexp_split_to_array(flat, '[^a-z]+');
  flat := regexp_replace(flat, '[^a-z]', '', 'g');
  squeezed := regexp_replace(flat, '(.)\1+', '\1', 'g');
  if exists (select 1 from public.banned_words w
             where (not w.whole and (position(w.word in flat) > 0 or position(w.word in squeezed) > 0))
                or (w.whole and (w.word = any (words) or w.word = squeezed or w.word = flat))) then
    raise exception 'Please pick another name' using errcode = '22023';
  end if;
  return n;
end $$;

-- Set your leaderboard name. Returns the name as stored.
create or replace function public.set_display_name(p_name text) returns text
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); n text;
begin
  if uid is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if not public.rate_ok(uid) then raise exception 'Too many changes: try again in a few minutes' using errcode = 'P0001'; end if;
  n := public.clean_display_name(p_name);
  insert into public.players (user_id, display_name, updated_at) values (uid, n, now())
  on conflict (user_id) do update set display_name = excluded.display_name, updated_at = now();
  return n;
end $$;

-- Submit a score. The server decides what counts: impossible values are rejected, the rest are clamped to the board's
-- cap and to how fast a best score can plausibly grow, and each player is rate-limited.
-- Returns { ok, board, value (your all-time best), season (this season's best), accepted, clamped } or { ok: false, reason }.
create or replace function public.submit_score(p_board text, p_value numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  b public.boards%rowtype;
  cur public.scores%rowtype;
  have boolean;
  season text := public.current_season();
  v integer; best integer; sbest integer; allowed numeric;
begin
  if uid is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select * into b from public.boards where id = p_board;
  if not found then raise exception 'Unknown board' using errcode = '22023'; end if;
  if p_value is null or p_value = 'NaN'::numeric or p_value < 0 or p_value > b.max_value then
    raise exception 'Impossible score' using errcode = '22003';
  end if;
  if not public.rate_ok(uid) then return jsonb_build_object('ok', false, 'reason', 'rate_limited'); end if;
  v := floor(least(p_value, b.cap))::integer;
  select * into cur from public.scores s where s.user_id = uid and s.board = b.id and s.period = 'all' for update;
  have := found;
  if have then
    if v > cur.value and cur.updated_at > now() - make_interval(secs => b.min_gap_s) then
      return jsonb_build_object('ok', false, 'reason', 'too_soon', 'value', cur.value);
    end if;
    allowed := cur.value + least(b.burst, b.per_hour * extract(epoch from now() - cur.updated_at) / 3600.0);
  else
    allowed := b.first_max;
  end if;
  v := least(v, floor(allowed))::integer;
  if not have then
    insert into public.scores (user_id, board, period, value) values (uid, b.id, 'all', v);
    best := v;
  elsif v > cur.value then
    update public.scores s set value = v, updated_at = now() where s.user_id = uid and s.board = b.id and s.period = 'all';
    best := v;
  else
    best := cur.value;
  end if;
  insert into public.scores as s (user_id, board, period, value) values (uid, b.id, season, v)
  on conflict (user_id, board, period) do update set value = excluded.value, updated_at = now() where excluded.value > s.value
  returning s.value into sbest;
  if sbest is null then select s.value into sbest from public.scores s where s.user_id = uid and s.board = b.id and s.period = season; end if;
  return jsonb_build_object('ok', true, 'board', b.id, 'value', best, 'season', sbest, 'accepted', v, 'clamped', v < floor(p_value));
end $$;

-- A board: the top p_limit (max 100) plus your own row. p_period: 'all' or 'season' (the current UTC month).
create or replace function public.leaderboard(p_board text, p_period text default 'all', p_limit integer default 50)
returns table (place bigint, name text, value integer, me boolean)
language sql stable security definer set search_path = '' as $$
  with ranked as (
    select s.user_id, s.value, rank() over (order by s.value desc, s.updated_at asc) as pos
    from public.scores s
    where s.board = p_board and s.value > 0
      and s.period = case when p_period = 'season' then public.current_season() else 'all' end
  )
  select r.pos, coalesce(p.display_name, 'Player ' || upper(substr(md5(r.user_id::text), 1, 4))), r.value,
         coalesce(r.user_id = auth.uid(), false)
  from ranked r left join public.players p on p.user_id = r.user_id
  where r.pos <= least(greatest(coalesce(p_limit, 50), 1), 100) or r.user_id = auth.uid()
  order by r.pos
$$;

-- Postgres lets everyone execute new functions by default; open only what the game calls.
revoke execute on function public.saves_touch() from public, anon, authenticated;
revoke execute on function public.rate_ok(uuid, integer, interval) from public, anon, authenticated;
revoke execute on function public.clean_display_name(text) from public, anon, authenticated;
revoke execute on function public.current_season() from public, anon, authenticated;
revoke execute on function public.set_display_name(text) from public, anon, authenticated;
revoke execute on function public.submit_score(text, numeric) from public, anon, authenticated;
revoke execute on function public.leaderboard(text, text, integer) from public, anon, authenticated;
grant execute on function public.current_season() to anon, authenticated;
grant execute on function public.leaderboard(text, text, integer) to anon, authenticated;
grant execute on function public.set_display_name(text) to authenticated;
grant execute on function public.submit_score(text, numeric) to authenticated;
