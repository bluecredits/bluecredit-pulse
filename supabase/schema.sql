-- =====================================================================
-- BlueCredit Pulse — Supabase schema
-- Run once in Supabase: SQL Editor → New query → paste this file → Run.
-- Safe to re-run: it only creates what is missing and replaces functions.
--
-- Security model
--   * Anyone can create a Supabase login, but a login sees NOTHING until it
--     joins with the company code (join_company). Every table is locked by
--     row-level security to active members only.
--   * The first person to join becomes admin. Admins see and rotate the
--     company code and can turn accounts off or make other admins.
-- =====================================================================

-- ---------------------------------------------------------------- team
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  email text,
  role text not null default 'member' check (role in ('admin', 'member')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.settings (key text primary key, value text);
create table if not exists public.join_attempts (uid uuid, ts timestamptz default now());

create or replace function public.new_company_code() returns text
language sql volatile as $$
  select 'BLUE-' || string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '')
         filter (where g <= 4) || '-' ||
         string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '')
         filter (where g > 4)
  from generate_series(1, 8) g
$$;

insert into public.settings (key, value) values ('company_code', public.new_company_code())
on conflict (key) do nothing;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active)
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active and role = 'admin')
$$;

-- First name of the signed-in member; used for "updated by" and the activity log
create or replace function public.member_name() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select split_part(display_name, ' ', 1) from profiles where id = auth.uid()), 'system')
$$;

create or replace function public.join_company(p_code text, p_name text) returns text
language plpgsql volatile security definer set search_path = public as $$
declare v_code text; v_role text; v_email text; v_active boolean;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if (select count(*) from join_attempts where uid = auth.uid() and ts > now() - interval '1 hour') >= 8 then
    raise exception 'Too many tries. Wait an hour, or ask your admin for the code.';
  end if;
  insert into join_attempts (uid) values (auth.uid());
  select value into v_code from settings where key = 'company_code';
  if v_code is null or upper(trim(coalesce(p_code, ''))) <> upper(v_code) then
    raise exception 'That company code isn''t valid. Check it with your admin.';
  end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Enter your name.'; end if;

  select role, active into v_role, v_active from profiles where id = auth.uid();
  if found then
    if not v_active then raise exception 'This account is turned off. Ask an admin to turn it back on.'; end if;
    update profiles set display_name = trim(p_name) where id = auth.uid();
    return v_role;
  end if;
  select email into v_email from auth.users where id = auth.uid();
  v_role := case when exists (select 1 from profiles) then 'member' else 'admin' end;
  insert into profiles (id, display_name, email, role) values (auth.uid(), trim(p_name), v_email, v_role);
  insert into activity (user_name, entity, action, summary)
    values (split_part(trim(p_name), ' ', 1), 'team', 'create', trim(p_name) || ' joined the team');
  return v_role;
end $$;

create or replace function public.get_company_code() returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Only admins can see the company code.'; end if;
  return (select value from settings where key = 'company_code');
end $$;

create or replace function public.rotate_company_code(p_code text default null) returns text
language plpgsql volatile security definer set search_path = public as $$
declare v text := upper(trim(coalesce(p_code, '')));
begin
  if not is_admin() then raise exception 'Only admins can change the company code.'; end if;
  if v = '' then v := new_company_code(); end if;
  if length(v) < 6 then raise exception 'Use at least 6 characters.'; end if;
  update settings set value = v where key = 'company_code';
  insert into activity (user_name, entity, action, summary) values (member_name(), 'team', 'update', 'Changed the company code');
  return v;
end $$;

create or replace function public.set_member(p_id uuid, p_role text, p_active boolean) returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_name text;
begin
  if not is_admin() then raise exception 'Only admins can change team members.'; end if;
  if p_id = auth.uid() and (p_role <> 'admin' or not p_active) then
    raise exception 'You can''t remove your own admin access. Ask another admin.';
  end if;
  update profiles set role = p_role, active = p_active where id = p_id returning display_name into v_name;
  insert into activity (user_name, entity, action, summary)
    values (member_name(), 'team', 'update', v_name || ': ' || p_role || case when p_active then '' else ', turned off' end);
end $$;

-- ---------------------------------------------------------------- records
create table if not exists public.opportunities (
  id bigint generated by default as identity primary key,
  title text, kind text, agency text, ref_no text, stage text, priority text, deadline date,
  value numeric, value_text text, pwin numeric, owner text, naics text, set_aside text, location text,
  contact_name text, contact_email text, url text, notes text, source text,
  meta jsonb, created_at timestamptz default now(), updated_at timestamptz default now(), updated_by text
);
create table if not exists public.funding (
  id bigint generated by default as identity primary key,
  name text, organization text, type text, status text, deadline date, amount numeric, amount_text text,
  pwin numeric, owner text, region text, contact_email text, submitted_date date, decision_date date,
  url text, notes text, source text,
  meta jsonb, created_at timestamptz default now(), updated_at timestamptz default now(), updated_by text
);
create table if not exists public.contacts (
  id bigint generated by default as identity primary key,
  name text, organization text, role text, email text, phone text, category text, status text, owner text,
  last_touch date, next_step text, next_step_date date, location text, linkedin text, tags text,
  notes text, source text,
  meta jsonb, created_at timestamptz default now(), updated_at timestamptz default now(), updated_by text
);
create table if not exists public.resources (
  id bigint generated by default as identity primary key,
  name text, category text, agency text, url text, contact text, notes text,
  meta jsonb, created_at timestamptz default now(), updated_at timestamptz default now(), updated_by text
);
create table if not exists public.reviews (
  id bigint generated by default as identity primary key,
  cadence text not null, review_date date not null default current_date, title text, attendees text,
  notes text, snapshot jsonb, created_by text,
  created_at timestamptz default now(), updated_at timestamptz default now(), updated_by text
);
create table if not exists public.actions (
  id bigint generated by default as identity primary key,
  text text, owner text, due_date date, status text default 'Open',
  review_id bigint references public.reviews (id) on delete set null,
  linked_type text, linked_id bigint, notes text,
  meta jsonb, created_at timestamptz default now(), updated_at timestamptz default now(), updated_by text
);
create table if not exists public.activity (
  id bigint generated by default as identity primary key,
  ts timestamptz not null default now(), user_name text, entity text, entity_id bigint, action text,
  field text, old_value text, new_value text, summary text
);

create index if not exists ix_opp_deadline on public.opportunities (deadline);
create index if not exists ix_opp_stage on public.opportunities (stage);
create index if not exists ix_fund_deadline on public.funding (deadline);
create index if not exists ix_fund_status on public.funding (status);
create index if not exists ix_contacts_email on public.contacts (lower(email));
create index if not exists ix_contacts_category on public.contacts (category);
create index if not exists ix_contacts_next on public.contacts (next_step_date);
create index if not exists ix_actions_status on public.actions (status, due_date);
create index if not exists ix_actions_review on public.actions (review_id);
create index if not exists ix_actions_linked on public.actions (linked_type, linked_id);
create index if not exists ix_activity_ts on public.activity (ts desc);
create index if not exists ix_activity_entity on public.activity (entity, entity_id);
create index if not exists ix_reviews_cadence on public.reviews (cadence, review_date desc);

-- ---------------------------------------------------------------- stamps + activity log
create or replace function public.stamp_row() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if auth.uid() is not null then new.updated_by := member_name(); end if;
  if tg_op = 'INSERT' and tg_table_name = 'reviews' then
    new := jsonb_populate_record(new, jsonb_build_object('created_by', coalesce(to_jsonb(new) ->> 'created_by', member_name())));
  end if;
  return new;
end $$;

create or replace function public.log_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  tcol text := tg_argv[0];
  scol text := nullif(tg_argv[1], '');
  noun text := tg_argv[2];
  nm text; title text; o jsonb; n jsonb; changed text;
begin
  if auth.uid() is null then return null; end if;   -- bulk loads with the service key aren't logged
  if current_setting('pulse.bulk', true) = 'on' then return null; end if;   -- import_contacts logs one summary line instead
  nm := member_name();
  if tg_op = 'DELETE' then
    o := to_jsonb(old);
    insert into activity (user_name, entity, entity_id, action, old_value, summary)
      values (nm, tg_table_name, (o ->> 'id')::bigint, 'delete', left(o::text, 4000),
              'Deleted ' || noun || ': ' || coalesce(o ->> tcol, o ->> 'organization', ''));
    return null;
  end if;
  n := to_jsonb(new);
  title := coalesce(nullif(n ->> tcol, ''), n ->> 'organization', '');
  if tg_op = 'INSERT' then
    insert into activity (user_name, entity, entity_id, action, summary)
      values (nm, tg_table_name, (n ->> 'id')::bigint, 'create', 'Added ' || noun || ': ' || title);
    if scol is not null and tg_table_name in ('opportunities', 'funding') and n ->> scol is not null then
      insert into activity (user_name, entity, entity_id, action, field, new_value, summary)
        values (nm, tg_table_name, (n ->> 'id')::bigint, 'update', scol, n ->> scol, title || ': ' || scol || ' → ' || (n ->> scol));
    end if;
    return null;
  end if;
  o := to_jsonb(old);
  if scol is not null and (o ->> scol) is distinct from (n ->> scol) then
    insert into activity (user_name, entity, entity_id, action, field, old_value, new_value, summary)
      values (nm, tg_table_name, (n ->> 'id')::bigint, 'update', scol, o ->> scol, n ->> scol,
              title || ': ' || scol || ' ' || coalesce(o ->> scol, '—') || ' → ' || coalesce(n ->> scol, '—'));
  end if;
  select string_agg(k, ', ' order by k) into changed
    from jsonb_object_keys(n) k
   where k not in ('updated_at', 'updated_by', 'created_at', 'meta', coalesce(scol, ''))
     and (n -> k) is distinct from (o -> k);
  if changed is not null then
    insert into activity (user_name, entity, entity_id, action, summary)
      values (nm, tg_table_name, (n ->> 'id')::bigint, 'update', title || ': edited ' || changed);
  end if;
  return null;
end $$;

do $$
declare t record;
begin
  for t in select * from (values
      ('opportunities', 'title', 'stage', 'opportunity'),
      ('funding', 'name', 'status', 'funding item'),
      ('contacts', 'name', 'status', 'contact'),
      ('resources', 'name', '', 'resource'),
      ('actions', 'text', 'status', 'action item'),
      ('reviews', 'title', '', 'review')) v(tbl, tcol, scol, noun)
  loop
    execute format('drop trigger if exists stamp on public.%I', t.tbl);
    execute format('create trigger stamp before insert or update on public.%I for each row execute function public.stamp_row()', t.tbl);
    execute format('drop trigger if exists log on public.%I', t.tbl);
    if t.tbl = 'reviews' then  -- notes autosave; only log start/delete
      execute format('create trigger log after insert or delete on public.%I for each row execute function public.log_change(%L, %L, %L)', t.tbl, t.tcol, t.scol, t.noun);
    else
      execute format('create trigger log after insert or update or delete on public.%I for each row execute function public.log_change(%L, %L, %L)', t.tbl, t.tcol, t.scol, t.noun);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- row-level security
alter table public.profiles enable row level security;
alter table public.settings enable row level security;
alter table public.join_attempts enable row level security;
alter table public.activity enable row level security;

drop policy if exists members_read on public.profiles;
create policy members_read on public.profiles for select to authenticated using (is_member() or id = auth.uid());
drop policy if exists own_name on public.profiles;
create policy own_name on public.profiles for update to authenticated using (id = auth.uid() and is_member()) with check (id = auth.uid());
revoke update on public.profiles from authenticated, anon;
grant update (display_name) on public.profiles to authenticated;
revoke all on public.settings, public.join_attempts from authenticated, anon;

drop policy if exists members_read on public.activity;
create policy members_read on public.activity for select to authenticated using (is_member());
revoke insert, update, delete on public.activity from authenticated, anon;

do $$
declare t text;
begin
  foreach t in array array['opportunities', 'funding', 'contacts', 'resources', 'reviews', 'actions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists members_all on public.%I', t);
    execute format('create policy members_all on public.%I for all to authenticated using (is_member()) with check (is_member())', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

revoke execute on function public.join_company(text, text), public.get_company_code(), public.rotate_company_code(text),
  public.set_member(uuid, text, boolean) from anon, public;
grant execute on function public.join_company(text, text), public.get_company_code(), public.rotate_company_code(text),
  public.set_member(uuid, text, boolean) to authenticated;

-- ---------------------------------------------------------------- dashboard + review snapshot
create or replace function public.dashboard_data(p_owner text) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  t date := current_date;
  ao text[] := array['Identified', 'Qualifying', 'Pursuing', 'Submitted'];
  af text[] := array['Identified', 'Pursuing', 'Submitted'];
begin
  if not is_member() then raise exception 'Not a member'; end if;
  return jsonb_build_object(
    'kpis', jsonb_build_object(
      'active_opps', (select count(*) from opportunities where stage = any (ao)),
      'active_funding', (select count(*) from funding where status = any (af)),
      'submitted', (select count(*) from opportunities where stage = 'Submitted') + (select count(*) from funding where status = 'Submitted'),
      'won', (select count(*) from opportunities where stage = 'Won') + (select count(*) from funding where status = 'Won'),
      'open_actions', (select count(*) from actions where status = 'Open'),
      'overdue_actions', (select count(*) from actions where status = 'Open' and due_date < t),
      'followups_due', (select count(*) from contacts where next_step_date <= t
                         and coalesce(status, '') not in ('Do Not Contact', 'Dormant'))),
    'due_soon', coalesce((select jsonb_agg(x order by x.deadline) from (
        select 'opportunities' entity, id, title as name, agency org, deadline, stage status, owner, priority
          from opportunities where stage = any (ao) and deadline between t and t + 14
        union all
        select 'funding', id, name, organization, deadline, status, owner, null
          from funding where status = any (af) and deadline between t and t + 14) x), '[]'),
    'my_actions', coalesce((select jsonb_agg(a order by a.due_date nulls last) from (
        select * from actions where status = 'Open' and lower(coalesce(owner, '')) = lower(p_owner) limit 20) a), '[]'),
    'opp_by_stage', coalesce((select jsonb_agg(jsonb_build_object('k', stage, 'n', n)) from (
        select stage, count(*) n from opportunities group by stage) s), '[]'),
    'funding_by_status', coalesce((select jsonb_agg(jsonb_build_object('k', status, 'n', n)) from (
        select status, count(*) n from funding where coalesce(status, '') <> 'Catalog' group by status) s), '[]'),
    'recent', coalesce((select jsonb_agg(a order by a.ts desc) from (
        select * from activity order by ts desc limit 15) a), '[]'),
    'last_reviews', coalesce((select jsonb_object_agg(cadence, last) from (
        select cadence, max(review_date) last from reviews group by cadence) r), '{}'));
end $$;

create or replace function public.build_snapshot(p_cadence text, p_as_of date default null) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  t date := coalesce(p_as_of, current_date);
  lb int; ah int; since date; until date;
  ao text[] := array['Identified', 'Qualifying', 'Pursuing', 'Submitted'];
  af text[] := array['Identified', 'Pursuing', 'Submitted'];
  snap jsonb; prev record; won int; lost int;
  o jsonb; f jsonb;
begin
  if not is_member() then raise exception 'Not a member'; end if;
  select v.lb, v.ah into lb, ah from (values ('daily', 1, 7), ('weekly', 7, 30), ('monthly', 31, 60), ('quarterly', 92, 120))
    v(c, lb, ah) where v.c = p_cadence;
  if lb is null then raise exception 'Unknown cadence %', p_cadence; end if;
  since := t - lb; until := t + ah;

  snap := jsonb_build_object('cadence', p_cadence, 'as_of', t, 'since', since, 'until', until,
    'opp_deadlines', coalesce((select jsonb_agg(x order by x.deadline) from (
        select id, title, agency, deadline, stage, priority, owner, value, value_text from opportunities
         where stage = any (ao) and deadline between t and until) x), '[]'),
    'funding_deadlines', coalesce((select jsonb_agg(x order by x.deadline) from (
        select id, name, organization, deadline, status, owner, amount_text from funding
         where status = any (af) and deadline between t and until) x), '[]'),
    'stale_count', (select count(*) from opportunities where stage in ('Identified', 'Qualifying', 'Pursuing') and deadline < t)
                 + (select count(*) from funding where status in ('Identified', 'Pursuing') and deadline < t),
    'stale', coalesce((select jsonb_agg(x order by x.deadline desc) from (
        select * from (
          select 'opportunities' entity, id, title as name, deadline, stage status, owner from opportunities
           where stage in ('Identified', 'Qualifying', 'Pursuing') and deadline < t
          union all
          select 'funding', id, name, deadline, status, owner from funding
           where status in ('Identified', 'Pursuing') and deadline < t) u
        order by deadline desc limit 25) x), '[]'),
    'actions_overdue', coalesce((select jsonb_agg(a order by a.due_date) from actions a where status = 'Open' and due_date < t), '[]'),
    'actions_completed', coalesce((select jsonb_agg(a order by a.updated_at desc) from actions a
        where status = 'Done' and updated_at::date >= since), '[]'),
    'followups_due', coalesce((select jsonb_agg(x order by x.next_step_date) from (
        select id, name, organization, next_step, next_step_date, owner, status from contacts
         where next_step_date <= until and coalesce(status, '') not in ('Do Not Contact', 'Dormant')
         order by next_step_date limit 100) x), '[]'),
    'contacts_touched', (select count(*) from contacts where last_touch >= since),
    'moves', jsonb_build_object(
        'submitted', coalesce((select jsonb_agg(a order by a.ts desc) from activity a where field in ('stage', 'status')
            and entity in ('opportunities', 'funding') and ts::date >= since and new_value = 'Submitted'), '[]'),
        'won', coalesce((select jsonb_agg(a order by a.ts desc) from activity a where field in ('stage', 'status')
            and entity in ('opportunities', 'funding') and ts::date >= since and new_value = 'Won'), '[]'),
        'lost', coalesce((select jsonb_agg(a order by a.ts desc) from activity a where field in ('stage', 'status')
            and entity in ('opportunities', 'funding') and ts::date >= since and new_value in ('Lost', 'Missed')), '[]')),
    'created', jsonb_build_object(
        'opportunities', (select count(*) from activity where entity = 'opportunities' and action = 'create' and ts::date >= since),
        'funding', (select count(*) from activity where entity = 'funding' and action = 'create' and ts::date >= since),
        'contacts', (select count(*) from activity where entity = 'contacts' and action = 'create' and ts::date >= since)));

  if p_cadence <> 'daily' then
    snap := snap || jsonb_build_object(
      'opp_pipeline', coalesce((select jsonb_agg(jsonb_build_object('k', stage, 'n', n, 'value', v) order by n desc) from (
          select stage, count(*) n, coalesce(sum(value), 0) v from opportunities group by stage) s), '[]'),
      'funding_pipeline', coalesce((select jsonb_agg(jsonb_build_object('k', status, 'n', n) order by n desc) from (
          select status, count(*) n from funding where coalesce(status, '') <> 'Catalog' group by status) s), '[]'));
  end if;

  if p_cadence in ('monthly', 'quarterly') then
    select coalesce(jsonb_object_agg(new_value, n), '{}') into o from (
      select new_value, count(distinct entity_id) n from activity where entity = 'opportunities' and field = 'stage'
         and ts::date >= since group by new_value) s;
    select coalesce(jsonb_object_agg(new_value, n), '{}') into f from (
      select new_value, count(distinct entity_id) n from activity where entity = 'funding' and field = 'status'
         and ts::date >= since group by new_value) s;
    won := coalesce((o ->> 'Won')::int, 0) + coalesce((f ->> 'Won')::int, 0);
    lost := coalesce((o ->> 'Lost')::int, 0) + coalesce((f ->> 'Lost')::int, 0);
    snap := snap || jsonb_build_object(
      'results', jsonb_build_object('opportunities', o, 'funding', f,
        'win_rate', case when won + lost > 0 then round(100.0 * won / (won + lost)) end,
        'value_won', (select coalesce(sum(value), 0) from opportunities where stage = 'Won' and id in (
            select entity_id from activity where entity = 'opportunities' and new_value = 'Won' and ts::date >= since)),
        'funding_submitted_by_date', (select count(*) from funding where submitted_date between since and t)),
      'by_owner', coalesce((select jsonb_agg(x order by x.active_opps + x.active_funding desc) from (
          select coalesce(nullif(owner, ''), 'Unassigned') owner,
                 count(*) filter (where src = 'o' and st = any (ao)) active_opps,
                 count(*) filter (where src = 'f' and st = any (af)) active_funding,
                 count(*) filter (where st = 'Submitted') submitted,
                 count(*) filter (where st = 'Won') won
            from (select owner, stage st, 'o' src from opportunities
                  union all select owner, status, 'f' from funding where coalesce(status, '') <> 'Catalog') u
           group by 1) x), '[]'));
  end if;

  select id, review_date, title into prev from reviews where cadence = p_cadence and review_date < t
   order by review_date desc, id desc limit 1;
  if found then
    snap := snap || jsonb_build_object('previous_review', jsonb_build_object('id', prev.id, 'review_date', prev.review_date, 'title', prev.title),
      'carry_over', coalesce((select jsonb_agg(a) from actions a where review_id = prev.id and status = 'Open'), '[]'));
  else
    snap := snap || jsonb_build_object('previous_review', null, 'carry_over', '[]'::jsonb);
  end if;
  return snap;
end $$;

grant execute on function public.dashboard_data(text), public.build_snapshot(text, date) to authenticated;
revoke execute on function public.dashboard_data(text), public.build_snapshot(text, date) from anon, public;

-- ---------------------------------------------------------------- bulk contact import
-- Called by the "Import contacts" button (and usable from the SQL Editor). Each row is a JSON object with any of:
-- name, organization, role, email, phone, category, status, owner, location, linkedin, tags, notes, source.
-- A row merges into an existing contact when the email matches and the organizations agree (or one is blank),
-- or, with no email, when name + organization match. Merging fills empty fields, adds the import label to Tags
-- and appends new details to Notes, so nothing already there is overwritten. Writes one activity line per import.
create or replace function public.import_contacts(p_rows jsonb, p_label text default null, p_by text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  r jsonb; v_id bigint; v_email text; v_name text; v_org text; v_notes text; v_tags text;
  n_new int := 0; n_merged int := 0; n_skipped int := 0;
  who text := case when auth.uid() is null then coalesce(nullif(trim(p_by), ''), 'system') else member_name() end;
  lbl text := nullif(trim(p_label), '');
begin
  if auth.uid() is not null and not is_member() then raise exception 'Only team members can import contacts.'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Expected a list of contacts.'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'Import at most 5,000 rows at a time.'; end if;
  perform set_config('pulse.bulk', 'on', true);
  for r in select value from jsonb_array_elements(p_rows) loop
    v_email := lower(nullif(trim(r ->> 'email'), ''));
    v_name := nullif(trim(r ->> 'name'), '');
    v_org := nullif(trim(r ->> 'organization'), '');
    v_notes := nullif(trim(r ->> 'notes'), '');
    v_tags := concat_ws('; ', nullif(trim(r ->> 'tags'), ''), lbl);
    if v_email is null and v_name is null and v_org is null then n_skipped := n_skipped + 1; continue; end if;
    v_id := null;
    if v_email is not null then
      select id into v_id from contacts
       where lower(email) = v_email and (organization is null or organization = '' or v_org is null or lower(organization) = lower(v_org))
       order by id limit 1;
    else
      select id into v_id from contacts
       where lower(coalesce(name, '')) = lower(coalesce(v_name, '')) and lower(coalesce(organization, '')) = lower(coalesce(v_org, ''))
       order by id limit 1;
    end if;
    if v_id is null then
      insert into contacts (name, organization, role, email, phone, category, status, owner, location, linkedin, tags, notes, source, updated_by)
      values (v_name, v_org, nullif(trim(r ->> 'role'), ''), v_email, nullif(trim(r ->> 'phone'), ''),
              coalesce(nullif(trim(r ->> 'category'), ''), 'Other'), coalesce(nullif(trim(r ->> 'status'), ''), 'To Contact'),
              nullif(trim(r ->> 'owner'), ''), nullif(trim(r ->> 'location'), ''), nullif(trim(r ->> 'linkedin'), ''),
              nullif(v_tags, ''), v_notes, coalesce(nullif(trim(r ->> 'source'), ''), lbl, 'Import'), who);
      n_new := n_new + 1;
    else
      update contacts c set
        name = coalesce(nullif(c.name, ''), v_name),
        organization = coalesce(nullif(c.organization, ''), v_org),
        role = coalesce(nullif(c.role, ''), nullif(trim(r ->> 'role'), '')),
        email = coalesce(nullif(c.email, ''), v_email),
        phone = coalesce(nullif(c.phone, ''), nullif(trim(r ->> 'phone'), '')),
        location = coalesce(nullif(c.location, ''), nullif(trim(r ->> 'location'), '')),
        linkedin = coalesce(nullif(c.linkedin, ''), nullif(trim(r ->> 'linkedin'), '')),
        owner = coalesce(nullif(c.owner, ''), nullif(trim(r ->> 'owner'), '')),
        tags = case when lbl is null or coalesce(c.tags, '') ilike '%' || lbl || '%' then c.tags
                    else concat_ws('; ', nullif(c.tags, ''), lbl) end,
        notes = case when v_notes is null or coalesce(c.notes, '') ilike '%' || v_notes || '%' then c.notes
                     else concat_ws(E'\n', nullif(c.notes, ''), 'From ' || coalesce(lbl, 'import') || ': ' || v_notes) end,
        updated_by = who
      where c.id = v_id;
      n_merged := n_merged + 1;
    end if;
  end loop;
  perform set_config('pulse.bulk', 'off', true);
  insert into activity (user_name, entity, action, summary)
    values (who, 'contacts', 'import', format('Imported %s: %s new contact%s, %s matched existing contact%s',
            coalesce(lbl, 'a contact list'), n_new, case when n_new = 1 then '' else 's' end,
            n_merged, case when n_merged = 1 then '' else 's' end));
  return jsonb_build_object('added', n_new, 'merged', n_merged, 'skipped', n_skipped);
end $$;
revoke execute on function public.import_contacts(jsonb, text, text) from anon, public;
grant execute on function public.import_contacts(jsonb, text, text) to authenticated;

-- ---------------------------------------------------------------- keep id counters ahead of imported rows
-- Rows loaded with explicit ids (Table Editor CSV import) don't advance the id counters; this realigns them.
do $$
declare t text; m bigint;
begin
  foreach t in array array['opportunities', 'funding', 'contacts', 'resources', 'reviews', 'actions', 'activity'] loop
    execute format('select max(id) from public.%I', t) into m;
    perform setval(pg_get_serial_sequence('public.' || t, 'id'), greatest(coalesce(m, 0), 1), m is not null);
  end loop;
end $$;
