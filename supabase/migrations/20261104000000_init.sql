-- Clipper Network analytics: accounts, their platform logins, and the daily history.
--
-- Who can see anything: only people listed in team_members (by email) who have signed in.
-- Viewers see the dashboard; admins also manage accounts, connections and the team.
-- Platform logins (connections), platform app keys (app_settings) and sign-in attempts
-- (oauth_states) have no policies at all, so only the server side can read them.

create table public.team_members (
  email text primary key check (email = lower(email)),
  role text not null default 'viewer' check (role in ('admin', 'viewer')),
  added_at timestamptz not null default now()
);

create or replace function public.is_team() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.team_members where email = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.team_members
                 where email = lower(coalesce(auth.jwt() ->> 'email', '')) and role = 'admin');
$$;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.team_members where email = lower(coalesce(auth.jwt() ->> 'email', ''));
$$;
grant execute on function public.is_team(), public.is_admin(), public.my_role() to authenticated;

-- Platform developer-app keys entered on the Settings page. Only the server side reads them.
create table public.app_settings (
  key text primary key check (key in (
    'META_APP_ID', 'META_APP_SECRET', 'TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET',
    'YOUTUBE_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
    'X_CLIENT_ID', 'X_CLIENT_SECRET', 'X_BEARER_TOKEN')),
  value text not null,
  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);

create table public.accounts (
  id text primary key default ('acc-' || substr(md5(gen_random_uuid()::text), 1, 10)),
  platform text not null check (platform in ('facebook', 'tiktok', 'instagram', 'youtube', 'x')),
  handle text not null,
  external_id text not null default '',
  name text not null,
  group_name text not null default '',
  profile_url text not null default '',
  avatar text not null default '',
  connection text not null default 'handle' check (connection in ('handle', 'oauth')),
  connection_expires timestamptz,
  active boolean not null default true,
  last_success date,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  unique (platform, handle)
);

-- Handles are stored without @ and in lowercase, except YouTube channel ids (UC…), which are case-sensitive.
create or replace function public.normalize_handle() returns trigger language plpgsql as $$
begin
  new.handle := btrim(new.handle);
  new.handle := regexp_replace(new.handle, '^@', '');
  if not (new.platform = 'youtube' and new.handle ~ '^UC[A-Za-z0-9_-]{22}$') then
    new.handle := lower(new.handle);
  end if;
  return new;
end $$;
create trigger accounts_normalize before insert or update of handle, platform on public.accounts
  for each row execute function public.normalize_handle();

create table public.connections (
  account_id text primary key references public.accounts (id) on delete cascade,
  provider text not null,
  access_token text not null default '',
  refresh_token text not null default '',
  access_expires bigint not null default 0,
  refresh_expires bigint not null default 0,
  open_id text not null default '',
  scope text not null default '',
  updated_at timestamptz not null default now()
);

create table public.oauth_states (
  state text primary key,
  platform text not null,
  user_id uuid not null,
  code_verifier text not null default '',
  created_at timestamptz not null default now()
);

create table public.daily_stats (
  date date not null,
  account_id text not null references public.accounts (id) on delete cascade,
  followers bigint,
  following bigint,
  posts_count bigint,
  likes_total bigint,
  views_lifetime bigint,
  views_day bigint,
  status text not null,
  note text not null default '',
  primary key (date, account_id)
);
create index daily_stats_account on public.daily_stats (account_id, date);

create table public.posts (
  platform text not null,
  post_id text not null,
  account_id text not null references public.accounts (id) on delete cascade,
  published_at timestamptz,
  title text not null default '',
  url text not null default '',
  thumbnail text not null default '',
  duration_s integer,
  views bigint,
  likes bigint,
  comments bigint,
  shares bigint,
  views_prev bigint,
  prev_date date,
  first_seen date not null,
  last_seen date not null,
  primary key (platform, post_id)
);
create index posts_account on public.posts (account_id);
create index posts_views on public.posts (views desc nulls last);

alter table public.team_members enable row level security;
alter table public.app_settings enable row level security;
alter table public.accounts enable row level security;
alter table public.connections enable row level security;
alter table public.oauth_states enable row level security;
alter table public.daily_stats enable row level security;
alter table public.posts enable row level security;

create policy "admins read team" on public.team_members for select to authenticated using (public.is_admin());
create policy "team reads accounts" on public.accounts for select to authenticated using (public.is_team());
create policy "admins add accounts" on public.accounts for insert to authenticated with check (public.is_admin() and connection = 'handle');
create policy "admins edit accounts" on public.accounts for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins remove accounts" on public.accounts for delete to authenticated using (public.is_admin());
create policy "team reads stats" on public.daily_stats for select to authenticated using (public.is_team());
create policy "team reads posts" on public.posts for select to authenticated using (public.is_team());

-- Admins may rename, regroup, pause or remove accounts, but not forge a platform connection.
-- Team membership is changed only through the settings function.
revoke insert, update, delete on public.team_members from authenticated, anon;
revoke update on public.accounts from authenticated;
grant update (name, group_name, active) on public.accounts to authenticated;

-- Everything the dashboard needs in one call (RLS still applies: runs as the signed-in user).
create or replace function public.dashboard_data() returns json
language sql stable security invoker set search_path = public as $$
  select json_build_object(
    'generated', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'demo', false,
    'accounts', coalesce((
      select json_agg(json_build_object(
        'id', a.id, 'name', a.name, 'platform', a.platform, 'handle', a.handle, 'group', a.group_name,
        'url', a.profile_url, 'avatar', a.avatar, 'lastSuccess', coalesce(a.last_success::text, '')
      ) order by a.platform, a.name)
      from accounts a where a.active), '[]'::json),
    'daily', coalesce((
      select json_agg(json_build_array(d.date::text, d.account_id, d.followers, d.views_lifetime, d.views_day,
                                       d.likes_total, d.status, d.note) order by d.date, d.account_id)
      from daily_stats d join accounts a on a.id = d.account_id and a.active), '[]'::json),
    'posts', coalesce((
      select json_agg(json_build_array(p.account_id, p.post_id,
                                       coalesce(to_char(p.published_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), p.first_seen::text),
                                       p.title, p.url, p.thumbnail, p.views, p.likes, p.comments, p.shares,
                                       p.views_prev, coalesce(p.prev_date::text, ''), p.last_seen::text))
      from (
        select p.* from posts p join accounts a on a.id = p.account_id and a.active
        where coalesce(p.published_at::date, p.first_seen) >= current_date - 400
        order by p.views desc nulls last limit 20000
      ) p), '[]'::json)
  );
$$;
grant execute on function public.dashboard_data() to authenticated;

-- Daily job: save a batch of posts, keeping yesterday's views so "gaining fastest" works.
create or replace function public.ingest_posts(p_account text, p_today date, p_posts jsonb) returns void
language plpgsql set search_path = public as $$
declare v_platform text;
begin
  select platform into v_platform from accounts where id = p_account;
  if v_platform is null then raise exception 'unknown account %', p_account; end if;
  insert into posts as t (platform, post_id, account_id, published_at, title, url, thumbnail, duration_s,
                          views, likes, comments, shares, first_seen, last_seen)
  select v_platform, x.post_id, p_account, nullif(x.published_at, '')::timestamptz, coalesce(x.title, ''),
         coalesce(x.url, ''), coalesce(x.thumbnail, ''), x.duration_s, x.views, x.likes, x.comments, x.shares,
         p_today, p_today
  from jsonb_to_recordset(p_posts) as x(post_id text, published_at text, title text, url text, thumbnail text,
                                         duration_s integer, views bigint, likes bigint, comments bigint, shares bigint)
  on conflict (platform, post_id) do update set
    views_prev = case when t.last_seen < p_today then t.views else t.views_prev end,
    prev_date = case when t.last_seen < p_today then t.last_seen else t.prev_date end,
    published_at = coalesce(excluded.published_at, t.published_at),
    title = case when excluded.title <> '' then excluded.title else t.title end,
    url = case when excluded.url <> '' then excluded.url else t.url end,
    thumbnail = case when excluded.thumbnail <> '' then excluded.thumbnail else t.thumbnail end,
    duration_s = coalesce(excluded.duration_s, t.duration_s),
    views = coalesce(excluded.views, t.views),
    likes = coalesce(excluded.likes, t.likes),
    comments = coalesce(excluded.comments, t.comments),
    shares = coalesce(excluded.shares, t.shares),
    last_seen = p_today;
end $$;

-- Daily job: one row per account per day. p_snap is null when the account failed or was skipped.
create or replace function public.record_daily(p_account text, p_today date, p_status text, p_note text, p_snap jsonb)
returns void language plpgsql set search_path = public as $$
begin
  insert into daily_stats (date, account_id, followers, following, posts_count, likes_total, views_lifetime, views_day, status, note)
  values (
    p_today, p_account,
    (p_snap ->> 'followers')::bigint, (p_snap ->> 'following')::bigint, (p_snap ->> 'posts_count')::bigint,
    (p_snap ->> 'likes_total')::bigint,
    case when p_snap is null then null
         else coalesce((p_snap ->> 'views_lifetime')::bigint, (select sum(views) from posts where account_id = p_account)) end,
    (p_snap ->> 'views_day')::bigint, p_status, coalesce(p_note, ''))
  on conflict (date, account_id) do update set
    followers = excluded.followers, following = excluded.following, posts_count = excluded.posts_count,
    likes_total = excluded.likes_total, views_lifetime = excluded.views_lifetime, views_day = excluded.views_day,
    status = excluded.status, note = excluded.note;
  if p_snap is not null then
    update accounts set
      last_success = p_today,
      profile_url = coalesce(nullif(p_snap ->> 'profile_url', ''), profile_url),
      avatar = coalesce(nullif(p_snap ->> 'avatar', ''), avatar)
    where id = p_account;
  end if;
end $$;

revoke execute on function public.ingest_posts(text, date, jsonb) from public, anon, authenticated;
revoke execute on function public.record_daily(text, date, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_posts(text, date, jsonb) to service_role;
grant execute on function public.record_daily(text, date, text, text, jsonb) to service_role;
