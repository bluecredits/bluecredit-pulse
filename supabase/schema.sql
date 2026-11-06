-- =====================================================================
-- Pulse (by BlueCredit) — Supabase schema
-- Run in Supabase: SQL Editor → New query → paste this file → Run.
-- Safe to re-run: it only creates what is missing and replaces functions.
-- An older single-company install is upgraded in place: its data becomes the first workspace.
--
-- Security model
--   * Each company is a WORKSPACE. Every row of business data carries a workspace_id, and
--     row-level security only shows a signed-in person the rows of the workspace they belong to.
--   * Anyone can create a login, but a login sees NOTHING until it either creates a workspace
--     (create_workspace — they become its admin) or joins one with its company code
--     (join_company — they become a member). One login belongs to one workspace.
--   * Admins see and rotate their workspace's code, manage members, edit the workspace's
--     lists and branding, and can delete the workspace with all its data.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- workspaces + team
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  join_code text not null,
  logo_url text,
  template text not null default 'general',
  config jsonb not null default '{}',
  plan text not null default 'free',
  created_by uuid,
  created_at timestamptz not null default now()
);
create unique index if not exists ux_workspaces_code on public.workspaces (upper(join_code));

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  display_name text not null,
  email text,
  role text not null default 'member' check (role in ('admin', 'member')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.profiles add column if not exists workspace_id uuid references public.workspaces (id) on delete cascade;
create index if not exists ix_profiles_workspace on public.profiles (workspace_id);
create table if not exists public.join_attempts (uid uuid, ts timestamptz default now());

-- Codes look like ACME-7KQ2-XR9D: up to 4 letters of the company name, then 8 random characters.
create or replace function public.new_company_code(p_name text default null) returns text
language plpgsql volatile as $$
declare
  a text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  pre text := left(regexp_replace(upper(coalesce(p_name, '')), '[^A-Z]', '', 'g'), 4);
  v text;
begin
  if length(pre) < 2 then pre := 'TEAM'; end if;
  loop
    select pre || '-' || string_agg(substr(a, 1 + floor(random() * 32)::int, 1), '') filter (where g <= 4) || '-' ||
           string_agg(substr(a, 1 + floor(random() * 32)::int, 1), '') filter (where g > 4)
      into v from generate_series(1, 8) g;
    exit when not exists (select 1 from workspaces where upper(join_code) = v);
  end loop;
  return v;
end $$;

-- Upgrade from the single-company version: everyone already on the team, and all existing data,
-- move into one workspace that keeps the old company code.
do $$
declare v_ws uuid; v_code text; v_name text;
begin
  if exists (select 1 from public.profiles where workspace_id is null) then
    if to_regclass('public.settings') is not null then
      execute $q$select max(value) filter (where key = 'company_code'), max(value) filter (where key = 'company_name') from public.settings$q$
        into v_code, v_name;
    end if;
    insert into public.workspaces (name, join_code, template, created_by)
    values (coalesce(v_name, 'My company'), coalesce(v_code, public.new_company_code(v_name)), 'general',
            (select id from public.profiles where role = 'admin' order by created_at limit 1))
    returning id into v_ws;
    update public.profiles set workspace_id = v_ws where workspace_id is null;
  end if;
end $$;
alter table public.profiles alter column workspace_id set not null;

-- The signed-in person's workspace (null if they haven't joined one, or were turned off)
create or replace function public.ws() returns uuid
language sql stable security definer set search_path = public as $$
  select workspace_id from profiles where id = auth.uid() and active
$$;
-- Column default for workspace_id: the signer's workspace; for loader scripts using the
-- service key (no signed-in user) the workspace set with: set pulse.workspace = '<uuid>'
create or replace function public.ws_default() returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(ws(), case when auth.uid() is null then nullif(current_setting('pulse.workspace', true), '')::uuid end)
$$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select ws() is not null
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

create or replace function public.check_join_rate() returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if (select count(*) from join_attempts where uid = auth.uid() and ts > now() - interval '1 hour') >= 8 then
    raise exception 'Too many tries. Wait an hour, or ask your admin for the code.';
  end if;
  insert into join_attempts (uid) values (auth.uid());
end $$;

create or replace function public.check_new_member(p_name text) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_ws text;
begin
  if coalesce(trim(p_name), '') = '' then raise exception 'Enter your name.'; end if;
  select w.name into v_ws from profiles p join workspaces w on w.id = p.workspace_id where p.id = auth.uid();
  if v_ws is not null then
    raise exception 'This login already belongs to the % workspace. Sign up with another email to use a second workspace.', v_ws;
  end if;
  return (select email from auth.users where id = auth.uid());
end $$;

-- Start a new company workspace; the caller becomes its admin. Returns the new company code.
create or replace function public.create_workspace(p_company text, p_name text, p_template text default 'general') returns text
language plpgsql volatile security definer set search_path = public as $$
declare v_email text; v_ws uuid; v_code text; v_company text := trim(coalesce(p_company, ''));
begin
  perform check_join_rate();
  if v_company = '' then raise exception 'Enter your company name.'; end if;
  if length(v_company) > 80 then raise exception 'Keep the company name under 80 characters.'; end if;
  v_email := check_new_member(p_name);
  v_code := new_company_code(v_company);
  insert into workspaces (name, join_code, template, created_by)
  values (v_company, v_code, case when p_template in ('general', 'govcon', 'fundraising') then p_template else 'general' end, auth.uid())
  returning id into v_ws;
  insert into profiles (id, workspace_id, display_name, email, role) values (auth.uid(), v_ws, trim(p_name), v_email, 'admin');
  insert into activity (workspace_id, user_name, entity, action, summary)
    values (v_ws, split_part(trim(p_name), ' ', 1), 'team', 'create', trim(p_name) || ' started the ' || v_company || ' workspace');
  return v_code;
end $$;

-- Join an existing workspace with its company code. Returns the role ('member', or the existing role on re-join).
create or replace function public.join_company(p_code text, p_name text) returns text
language plpgsql volatile security definer set search_path = public as $$
declare v_ws uuid; v_email text; p profiles;
begin
  perform check_join_rate();
  select id into v_ws from workspaces where upper(join_code) = upper(trim(coalesce(p_code, '')));
  if v_ws is null then raise exception 'That company code isn''t valid. Check it with your admin.'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Enter your name.'; end if;
  select * into p from profiles where id = auth.uid();
  if found then
    if p.workspace_id <> v_ws then perform check_new_member(p_name); end if;
    if not p.active then raise exception 'This account is turned off. Ask an admin to turn it back on.'; end if;
    update profiles set display_name = trim(p_name) where id = auth.uid();
    return p.role;
  end if;
  select email into v_email from auth.users where id = auth.uid();
  insert into profiles (id, workspace_id, display_name, email, role) values (auth.uid(), v_ws, trim(p_name), v_email, 'member');
  insert into activity (workspace_id, user_name, entity, action, summary)
    values (v_ws, split_part(trim(p_name), ' ', 1), 'team', 'create', trim(p_name) || ' joined the team');
  return 'member';
end $$;

create or replace function public.get_company_code() returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Only admins can see the company code.'; end if;
  return (select join_code from workspaces where id = ws());
end $$;

create or replace function public.rotate_company_code(p_code text default null) returns text
language plpgsql volatile security definer set search_path = public as $$
declare v text := upper(trim(coalesce(p_code, '')));
begin
  if not is_admin() then raise exception 'Only admins can change the company code.'; end if;
  if v = '' then v := new_company_code((select name from workspaces where id = ws())); end if;
  if length(v) < 8 then raise exception 'Use at least 8 characters.'; end if;
  if exists (select 1 from workspaces where upper(join_code) = v and id <> ws()) then raise exception 'That code is taken. Try another.'; end if;
  update workspaces set join_code = v where id = ws();
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
  update profiles set role = p_role, active = p_active where id = p_id and workspace_id = ws() returning display_name into v_name;
  if v_name is null then raise exception 'That person isn''t on your team.'; end if;
  insert into activity (user_name, entity, action, summary)
    values (member_name(), 'team', 'update', v_name || ': ' || p_role || case when p_active then '' else ', turned off' end);
end $$;

-- Admin: rename the workspace, set its logo, and edit its lists (stored in config)
create or replace function public.update_workspace(p jsonb) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Only admins can change workspace settings.'; end if;
  if p ? 'name' and coalesce(trim(p ->> 'name'), '') = '' then raise exception 'The workspace needs a name.'; end if;
  if p ? 'logo_url' and nullif(trim(p ->> 'logo_url'), '') is not null and p ->> 'logo_url' !~* '^https://' then
    raise exception 'The logo link must start with https://';
  end if;
  if p ? 'config' and (jsonb_typeof(p -> 'config') <> 'object' or length((p -> 'config')::text) > 50000) then
    raise exception 'Those settings are too large.';
  end if;
  update workspaces set
    name = case when p ? 'name' then left(trim(p ->> 'name'), 80) else name end,
    logo_url = case when p ? 'logo_url' then nullif(trim(p ->> 'logo_url'), '') else logo_url end,
    config = case when p ? 'config' then p -> 'config' else config end,
    template = case when p ->> 'template' in ('general', 'govcon', 'fundraising') then p ->> 'template' else template end
  where id = ws();
  insert into activity (user_name, entity, action, summary) values (member_name(), 'team', 'update', 'Changed workspace settings');
end $$;

-- Admin: permanently delete the workspace and everything in it. p_confirm must be the workspace name.
create or replace function public.delete_workspace(p_confirm text) returns void
language plpgsql volatile security definer set search_path = public as $$
declare w workspaces;
begin
  if not is_admin() then raise exception 'Only admins can delete the workspace.'; end if;
  select * into w from workspaces where id = ws();
  if trim(coalesce(p_confirm, '')) <> w.name then raise exception 'Type the workspace name exactly to confirm.'; end if;
  perform set_config('pulse.bulk', 'on', true);   -- don't write activity lines for rows being deleted
  delete from workspaces where id = w.id;   -- cascades to members and every record
end $$;

-- ---------------------------------------------------------------- workspace wall for every data table
-- Adds workspace_id (filled in automatically on insert), moves rows from an older single-company
-- install into the first workspace, and indexes it.
create or replace function public.add_workspace_wall(p_table text) returns void
language plpgsql volatile as $$
declare v_first uuid := (select id from public.workspaces order by created_at limit 1);
begin
  execute format('alter table public.%I add column if not exists workspace_id uuid references public.workspaces (id) on delete cascade', p_table);
  if v_first is not null then
    execute format('update public.%I set workspace_id = %L where workspace_id is null', p_table, v_first);
  end if;
  execute format('alter table public.%I alter column workspace_id set default public.ws_default()', p_table);
  execute format('alter table public.%I alter column workspace_id set not null', p_table);
  execute format('create index if not exists %I on public.%I (workspace_id)', 'ix_' || p_table || '_ws', p_table);
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

select public.add_workspace_wall(t) from unnest(array['opportunities', 'funding', 'contacts', 'resources', 'reviews', 'actions', 'activity']) t;

create index if not exists ix_opp_deadline on public.opportunities (deadline);
create index if not exists ix_opp_stage on public.opportunities (stage);
create index if not exists ix_fund_deadline on public.funding (deadline);
create index if not exists ix_fund_status on public.funding (status);
create index if not exists ix_contacts_email on public.contacts (workspace_id, lower(email));
create index if not exists ix_contacts_category on public.contacts (category);
create index if not exists ix_contacts_next on public.contacts (next_step_date);
create index if not exists ix_actions_status on public.actions (status, due_date);
create index if not exists ix_actions_review on public.actions (review_id);
create index if not exists ix_actions_linked on public.actions (linked_type, linked_id);
create index if not exists ix_activity_ts on public.activity (workspace_id, ts desc);
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
    insert into activity (workspace_id, user_name, entity, entity_id, action, old_value, summary)
      values ((o ->> 'workspace_id')::uuid, nm, tg_table_name, (o ->> 'id')::bigint, 'delete', left(o::text, 4000),
              'Deleted ' || noun || ': ' || coalesce(o ->> tcol, o ->> 'organization', ''));
    return null;
  end if;
  n := to_jsonb(new);
  title := coalesce(nullif(n ->> tcol, ''), n ->> 'organization', '');
  if tg_op = 'INSERT' then
    insert into activity (workspace_id, user_name, entity, entity_id, action, summary)
      values ((n ->> 'workspace_id')::uuid, nm, tg_table_name, (n ->> 'id')::bigint, 'create', 'Added ' || noun || ': ' || title);
    if scol is not null and tg_table_name in ('opportunities', 'funding') and n ->> scol is not null then
      insert into activity (workspace_id, user_name, entity, entity_id, action, field, new_value, summary)
        values ((n ->> 'workspace_id')::uuid, nm, tg_table_name, (n ->> 'id')::bigint, 'update', scol, n ->> scol, title || ': ' || scol || ' → ' || (n ->> scol));
    end if;
    return null;
  end if;
  o := to_jsonb(old);
  if scol is not null and (o ->> scol) is distinct from (n ->> scol) then
    insert into activity (workspace_id, user_name, entity, entity_id, action, field, old_value, new_value, summary)
      values ((n ->> 'workspace_id')::uuid, nm, tg_table_name, (n ->> 'id')::bigint, 'update', scol, o ->> scol, n ->> scol,
              title || ': ' || scol || ' ' || coalesce(o ->> scol, '—') || ' → ' || coalesce(n ->> scol, '—'));
  end if;
  select string_agg(k, ', ' order by k) into changed
    from jsonb_object_keys(n) k
   where k not in ('updated_at', 'updated_by', 'created_at', 'meta', 'workspace_id', coalesce(scol, ''))
     and (n -> k) is distinct from (o -> k);
  if changed is not null then
    insert into activity (workspace_id, user_name, entity, entity_id, action, summary)
      values ((n ->> 'workspace_id')::uuid, nm, tg_table_name, (n ->> 'id')::bigint, 'update', title || ': edited ' || changed);
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
alter table public.workspaces enable row level security;
alter table public.profiles enable row level security;
alter table public.join_attempts enable row level security;
alter table public.activity enable row level security;

-- members read their own workspace, but never its company code (admins get it from get_company_code)
drop policy if exists members_read on public.workspaces;
create policy members_read on public.workspaces for select to authenticated using (id = ws());
revoke all on public.workspaces from authenticated, anon;
grant select (id, name, logo_url, template, config, plan, created_at) on public.workspaces to authenticated;

drop policy if exists members_read on public.profiles;
create policy members_read on public.profiles for select to authenticated using (workspace_id = ws() or id = auth.uid());
drop policy if exists own_name on public.profiles;
create policy own_name on public.profiles for update to authenticated using (id = auth.uid() and is_member()) with check (id = auth.uid());
revoke insert, update, delete on public.profiles from authenticated, anon;
grant update (display_name) on public.profiles to authenticated;
revoke all on public.join_attempts from authenticated, anon;
do $$ begin
  if to_regclass('public.settings') is not null then
    execute 'alter table public.settings enable row level security';
    execute 'revoke all on public.settings from authenticated, anon';
  end if;
end $$;

drop policy if exists members_read on public.activity;
create policy members_read on public.activity for select to authenticated using (workspace_id = ws());
revoke insert, update, delete on public.activity from authenticated, anon;

do $$
declare t text;
begin
  foreach t in array array['opportunities', 'funding', 'contacts', 'resources', 'reviews', 'actions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists members_all on public.%I', t);
    execute format('create policy members_all on public.%I for all to authenticated using (workspace_id = ws()) with check (workspace_id = ws())', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

revoke execute on function public.join_company(text, text), public.create_workspace(text, text, text), public.get_company_code(),
  public.rotate_company_code(text), public.set_member(uuid, text, boolean), public.update_workspace(jsonb),
  public.delete_workspace(text), public.check_join_rate(), public.check_new_member(text), public.add_workspace_wall(text) from anon, public;
grant execute on function public.join_company(text, text), public.create_workspace(text, text, text), public.get_company_code(),
  public.rotate_company_code(text), public.set_member(uuid, text, boolean), public.update_workspace(jsonb),
  public.delete_workspace(text) to authenticated;

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
drop function if exists public.import_contacts(jsonb, text, text);
create or replace function public.import_contacts(p_rows jsonb, p_label text default null, p_by text default null, p_workspace uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_ws uuid := case when auth.uid() is null then p_workspace else ws() end;
  r jsonb; v_id bigint; v_email text; v_name text; v_org text; v_notes text; v_tags text;
  n_new int := 0; n_merged int := 0; n_skipped int := 0;
  who text := case when auth.uid() is null then coalesce(nullif(trim(p_by), ''), 'system') else member_name() end;
  lbl text := nullif(trim(p_label), '');
begin
  if auth.uid() is not null and not is_member() then raise exception 'Only team members can import contacts.'; end if;
  if v_ws is null then raise exception 'Pass p_workspace (the workspace id) when importing with the service key.'; end if;
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
       where workspace_id = v_ws and lower(email) = v_email and (organization is null or organization = '' or v_org is null or lower(organization) = lower(v_org))
       order by id limit 1;
    else
      select id into v_id from contacts
       where workspace_id = v_ws and lower(coalesce(name, '')) = lower(coalesce(v_name, '')) and lower(coalesce(organization, '')) = lower(coalesce(v_org, ''))
       order by id limit 1;
    end if;
    if v_id is null then
      insert into contacts (workspace_id, name, organization, role, email, phone, category, status, owner, location, linkedin, tags, notes, source, updated_by)
      values (v_ws, v_name, v_org, nullif(trim(r ->> 'role'), ''), v_email, nullif(trim(r ->> 'phone'), ''),
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
      where c.id = v_id and c.workspace_id = v_ws;
      n_merged := n_merged + 1;
    end if;
  end loop;
  perform set_config('pulse.bulk', 'off', true);
  insert into activity (workspace_id, user_name, entity, action, summary)
    values (v_ws, who, 'contacts', 'import', format('Imported %s: %s new contact%s, %s matched existing contact%s',
            coalesce(lbl, 'a contact list'), n_new, case when n_new = 1 then '' else 's' end,
            n_merged, case when n_merged = 1 then '' else 's' end));
  return jsonb_build_object('added', n_new, 'merged', n_merged, 'skipped', n_skipped);
end $$;
revoke execute on function public.import_contacts(jsonb, text, text, uuid) from anon, public;
grant execute on function public.import_contacts(jsonb, text, text, uuid) to authenticated;

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

-- =====================================================================
-- Service desk: requests (tickets), approvals and company assets
--   * Requests are private: visible only to the requester, the approver, the person
--     fulfilling it, and admins. They are NOT written to the team-wide activity log;
--     each request keeps its own timeline in ticket_events.
--   * Every change to a request goes through the desk_* functions below, which check
--     who is allowed to do what. Direct writes to these tables are blocked.
--   * Assets: members see the assets assigned to them; admins see and manage all.
-- =====================================================================
create table if not exists public.assets (
  id bigint generated by default as identity primary key,
  tag text, name text not null, category text, make_model text, serial text,
  status text not null default 'Available',
  assigned_to uuid references public.profiles (id) on delete set null,
  assigned_since date, location text, purchase_date date, cost numeric, vendor text, warranty_end date, notes text,
  created_at timestamptz default now(), updated_at timestamptz default now(), updated_by text
);
create table if not exists public.tickets (
  id bigint generated by default as identity primary key,
  type text not null, title text not null, description text,
  status text not null, priority text not null default 'Normal',
  requester_id uuid not null references public.profiles (id),
  approver_id uuid references public.profiles (id),
  assignee_id uuid references public.profiles (id),
  asset_id bigint references public.assets (id) on delete set null, asset_label text,
  amount numeric, start_date date, end_date date, reference text, needed_by date,
  decided_at timestamptz, decision_note text, resolved_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.ticket_events (
  id bigint generated by default as identity primary key,
  ticket_id bigint not null references public.tickets (id) on delete cascade,
  ts timestamptz not null default now(), user_id uuid, user_name text,
  kind text not null, body text, from_status text, to_status text
);
select public.add_workspace_wall(t) from unnest(array['assets', 'tickets', 'ticket_events']) t;
-- request numbers count up per workspace (REQ-0001, REQ-0002 …); older requests keep their id as the number
alter table public.tickets add column if not exists number int;
update public.tickets set number = id where number is null;
create unique index if not exists ux_tickets_number on public.tickets (workspace_id, number);
create index if not exists ix_tickets_requester on public.tickets (requester_id, status);
create index if not exists ix_tickets_approver on public.tickets (approver_id, status);
create index if not exists ix_tickets_assignee on public.tickets (assignee_id, status);
create index if not exists ix_ticket_events_ticket on public.ticket_events (ticket_id, ts);
create index if not exists ix_assets_assigned on public.assets (assigned_to);

alter table public.tickets enable row level security;
alter table public.ticket_events enable row level security;
alter table public.assets enable row level security;
drop policy if exists desk_read on public.tickets;
create policy desk_read on public.tickets for select to authenticated using (
  workspace_id = ws() and (requester_id = auth.uid() or approver_id = auth.uid() or assignee_id = auth.uid() or is_admin()));
drop policy if exists desk_read on public.ticket_events;
create policy desk_read on public.ticket_events for select to authenticated using (
  exists (select 1 from public.tickets t where t.id = ticket_id));
drop policy if exists assets_read on public.assets;
create policy assets_read on public.assets for select to authenticated using (workspace_id = ws() and (is_admin() or assigned_to = auth.uid()));
drop policy if exists assets_admin_insert on public.assets;
create policy assets_admin_insert on public.assets for insert to authenticated with check (is_admin() and workspace_id = ws());
drop policy if exists assets_admin_update on public.assets;
create policy assets_admin_update on public.assets for update to authenticated using (is_admin() and workspace_id = ws()) with check (is_admin() and workspace_id = ws());
drop policy if exists assets_admin_delete on public.assets;
create policy assets_admin_delete on public.assets for delete to authenticated using (is_admin() and workspace_id = ws());
revoke all on public.tickets, public.ticket_events, public.assets from anon;
revoke insert, update, delete on public.tickets, public.ticket_events from authenticated;
grant select on public.tickets, public.ticket_events to authenticated;
grant select, insert, update, delete on public.assets to authenticated;

-- assets: stamp who changed it; keep status and "assigned since" in step with the assignment
create or replace function public.asset_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.assigned_to is not null and not exists (select 1 from profiles where id = new.assigned_to and workspace_id = new.workspace_id) then
    raise exception 'Assign assets to someone on your own team.';
  end if;
  if tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to then
    new.assigned_since := case when new.assigned_to is null then null else coalesce(
      case when tg_op = 'INSERT' then new.assigned_since end, current_date) end;
    if new.assigned_to is not null and new.status = 'Available' then new.status := 'In use'; end if;
    if new.assigned_to is null and new.status = 'In use' then new.status := 'Available'; end if;
  end if;
  return new;
end $$;
drop trigger if exists stamp on public.assets;
create trigger stamp before insert or update on public.assets for each row execute function public.stamp_row();
drop trigger if exists sync on public.assets;
create trigger sync before insert or update on public.assets for each row execute function public.asset_sync();

create or replace function public.desk_types() returns text[] language sql immutable as $$
  select array['IT support', 'New equipment', 'Purchase or expense', 'Time off', 'Travel', 'Access or account',
               'Asset problem', 'Return an asset', 'Other'] $$;
create or replace function public.desk_needs_approval(p_type text) returns boolean language sql immutable as $$
  select p_type in ('New equipment', 'Purchase or expense', 'Time off', 'Travel', 'Access or account') $$;

create or replace function public.desk_log(p_ticket bigint, p_kind text, p_body text default null,
                                           p_from text default null, p_to text default null) returns void
language sql security definer set search_path = public as $$
  insert into ticket_events (ticket_id, user_id, user_name, kind, body, from_status, to_status)
  values (p_ticket, auth.uid(), member_name(), p_kind, nullif(trim(p_body), ''), p_from, p_to) $$;

-- Who approves: the person the requester picks, otherwise the first admin who isn't the requester.
-- Nobody approves their own request, except an admin when there is no other admin to ask.
create or replace function public.desk_pick_approver(p_requester uuid, p_choice uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v uuid; other_admin boolean;
begin
  other_admin := exists (select 1 from profiles where workspace_id = ws() and active and role = 'admin' and id <> p_requester);
  if p_choice is not null then
    if not exists (select 1 from profiles where id = p_choice and active and workspace_id = ws()) then
      raise exception 'The approver you picked isn''t an active team member.';
    end if;
    if p_choice = p_requester and (other_admin or not exists (select 1 from profiles where id = p_requester and role = 'admin')) then
      raise exception 'Pick someone else to approve your request.';
    end if;
    return p_choice;
  end if;
  select id into v from profiles where workspace_id = ws() and active and role = 'admin' and id <> p_requester order by created_at limit 1;
  if v is null and exists (select 1 from profiles where id = p_requester and role = 'admin') then v := p_requester; end if;
  if v is null then raise exception 'There''s no admin to approve this yet. Ask an admin to join first.'; end if;
  return v;
end $$;

create or replace function public.desk_submit(p jsonb) returns bigint
language plpgsql volatile security definer set search_path = public as $$
declare
  v_type text := trim(p ->> 'type'); v_title text := nullif(trim(p ->> 'title'), '');
  v_needs boolean; v_appr uuid; v_asset bigint := nullif(p ->> 'asset_id', '')::bigint; v_label text;
  v_start date := nullif(p ->> 'start_date', '')::date; v_end date := nullif(p ->> 'end_date', '')::date;
  v_amount numeric := nullif(regexp_replace(coalesce(p ->> 'amount', ''), '[$,\s]', '', 'g'), '')::numeric;
  v_status text; v_id bigint;
begin
  if not is_member() then raise exception 'Join the team before making requests.'; end if;
  if v_type is null or not v_type = any (desk_types()) then raise exception 'Pick a request type.'; end if;
  if v_title is null then raise exception 'Add a short title.'; end if;
  if v_type in ('Asset problem', 'Return an asset') and v_asset is null then raise exception 'Pick the asset this is about.'; end if;
  if v_asset is not null then
    select coalesce(nullif(tag, '') || ' · ', '') || name into v_label from assets
     where id = v_asset and workspace_id = ws() and (assigned_to = auth.uid() or is_admin());
    if v_label is null then raise exception 'That asset isn''t assigned to you.'; end if;
  end if;
  if v_type in ('Time off', 'Travel') and v_start is null then raise exception 'Add the start date.'; end if;
  if v_end is not null and v_start is not null and v_end < v_start then raise exception 'The end date is before the start date.'; end if;
  if v_type = 'Purchase or expense' and coalesce(v_amount, 0) <= 0 then raise exception 'Add the amount.'; end if;
  v_needs := desk_needs_approval(v_type) or (v_type = 'Other' and nullif(p ->> 'approver_id', '') is not null);
  if v_needs then v_appr := desk_pick_approver(auth.uid(), nullif(p ->> 'approver_id', '')::uuid); end if;
  v_status := case when v_needs then 'Pending approval' else 'Open' end;
  perform pg_advisory_xact_lock(hashtext('tickets:' || ws()::text));
  insert into tickets (number, type, title, description, status, priority, requester_id, approver_id, asset_id, asset_label,
                       amount, start_date, end_date, reference, needed_by)
  values ((select coalesce(max(number), 0) + 1 from tickets where workspace_id = ws()),
          v_type, v_title, nullif(trim(p ->> 'description'), ''), v_status,
          coalesce(nullif(p ->> 'priority', ''), 'Normal'), auth.uid(), v_appr, v_asset, v_label,
          v_amount, v_start, v_end, nullif(trim(p ->> 'reference'), ''), nullif(p ->> 'needed_by', '')::date)
  returning id into v_id;
  perform desk_log(v_id, 'created', null, null, v_status);
  return v_id;
end $$;

-- Requester edits while nothing has been decided yet; admins can also reassign the approver.
create or replace function public.desk_update(p_id bigint, p jsonb) returns void
language plpgsql volatile security definer set search_path = public as $$
declare t tickets; changed text[] := '{}'; v_appr uuid;
begin
  select * into t from tickets where id = p_id and workspace_id = ws();
  if not found then raise exception 'Request not found.'; end if;
  if not coalesce(t.requester_id = auth.uid() or is_admin(), false) then raise exception 'Only the requester or an admin can edit this.'; end if;
  if t.status not in ('Pending approval', 'Open') then raise exception 'This request can''t be edited any more. Add a comment instead.'; end if;
  if p ? 'title' and nullif(trim(p ->> 'title'), '') is distinct from t.title then
    if nullif(trim(p ->> 'title'), '') is null then raise exception 'Add a short title.'; end if;
    changed := changed || 'title'; t.title := trim(p ->> 'title'); end if;
  if p ? 'description' and nullif(trim(p ->> 'description'), '') is distinct from t.description then
    changed := changed || 'details'; t.description := nullif(trim(p ->> 'description'), ''); end if;
  if p ? 'priority' and coalesce(nullif(p ->> 'priority', ''), 'Normal') is distinct from t.priority then
    changed := changed || 'priority'; t.priority := coalesce(nullif(p ->> 'priority', ''), 'Normal'); end if;
  if p ? 'amount' and nullif(regexp_replace(coalesce(p ->> 'amount', ''), '[$,\s]', '', 'g'), '')::numeric is distinct from t.amount then
    changed := changed || 'amount'; t.amount := nullif(regexp_replace(coalesce(p ->> 'amount', ''), '[$,\s]', '', 'g'), '')::numeric; end if;
  if p ? 'start_date' and nullif(p ->> 'start_date', '')::date is distinct from t.start_date then
    changed := changed || 'dates'; t.start_date := nullif(p ->> 'start_date', '')::date; end if;
  if p ? 'end_date' and nullif(p ->> 'end_date', '')::date is distinct from t.end_date then
    if not 'dates' = any (changed) then changed := changed || 'dates'; end if; t.end_date := nullif(p ->> 'end_date', '')::date; end if;
  if t.end_date is not null and t.start_date is not null and t.end_date < t.start_date then raise exception 'The end date is before the start date.'; end if;
  if p ? 'reference' and nullif(trim(p ->> 'reference'), '') is distinct from t.reference then
    changed := changed || 'reference'; t.reference := nullif(trim(p ->> 'reference'), ''); end if;
  if p ? 'needed_by' and nullif(p ->> 'needed_by', '')::date is distinct from t.needed_by then
    changed := changed || 'needed-by date'; t.needed_by := nullif(p ->> 'needed_by', '')::date; end if;
  if p ? 'approver_id' and t.status = 'Pending approval' and nullif(p ->> 'approver_id', '')::uuid is distinct from t.approver_id then
    v_appr := desk_pick_approver(t.requester_id, nullif(p ->> 'approver_id', '')::uuid);
    if v_appr is distinct from t.approver_id then
      t.approver_id := v_appr;
      perform desk_log(p_id, 'approver', (select display_name from profiles where id = v_appr));
    end if;
  end if;
  update tickets set title = t.title, description = t.description, priority = t.priority, amount = t.amount,
         start_date = t.start_date, end_date = t.end_date, reference = t.reference, needed_by = t.needed_by,
         approver_id = t.approver_id, updated_at = now()
   where id = p_id;
  if array_length(changed, 1) > 0 then perform desk_log(p_id, 'edited', 'Changed ' || array_to_string(changed, ', ')); end if;
end $$;

create or replace function public.desk_decide(p_id bigint, p_approve boolean, p_note text default null) returns void
language plpgsql volatile security definer set search_path = public as $$
declare t tickets; v_to text := case when p_approve then 'Approved' else 'Rejected' end;
begin
  select * into t from tickets where id = p_id and workspace_id = ws() for update;
  if not found then raise exception 'Request not found.'; end if;
  if t.approver_id is distinct from auth.uid() or not is_member() then raise exception 'Only the approver can decide on this request.'; end if;
  if t.status <> 'Pending approval' then raise exception 'This request has already been decided.'; end if;
  if not p_approve and nullif(trim(p_note), '') is null then raise exception 'Add a reason so the requester knows why.'; end if;
  update tickets set status = v_to, decided_at = now(), decision_note = nullif(trim(p_note), ''), updated_at = now() where id = p_id;
  perform desk_log(p_id, lower(v_to), p_note, t.status, v_to);
end $$;

-- Work the request: admins or the assigned person start and finish it; the requester can cancel it.
create or replace function public.desk_set_status(p_id bigint, p_status text, p_note text default null) returns void
language plpgsql volatile security definer set search_path = public as $$
declare t tickets; v_to text := p_status; v_worker boolean;
begin
  select * into t from tickets where id = p_id and workspace_id = ws() for update;
  if not found then raise exception 'Request not found.'; end if;
  v_worker := is_admin() or coalesce(t.assignee_id = auth.uid(), false);
  if p_status = 'Cancelled' then
    if not coalesce(t.requester_id = auth.uid() or is_admin(), false) then raise exception 'Only the requester or an admin can cancel this.'; end if;
    if t.status in ('Done', 'Rejected', 'Cancelled') then raise exception 'This request is already closed.'; end if;
  elsif p_status in ('In progress', 'Done') then
    if not v_worker then raise exception 'Only an admin or the person assigned can update this.'; end if;
    if t.status not in ('Open', 'Approved', 'In progress') then
      raise exception '%', case when t.status = 'Pending approval' then 'This request is still waiting for approval.' else 'This request is already closed.' end;
    end if;
  elsif p_status = 'Reopen' then
    if not v_worker then raise exception 'Only an admin or the person assigned can reopen this.'; end if;
    if t.status not in ('Done', 'Cancelled') then raise exception 'Only finished or cancelled requests can be reopened.'; end if;
    v_to := case when t.decided_at is not null then 'Approved' when desk_needs_approval(t.type) then 'Pending approval' else 'Open' end;
  else
    raise exception 'Unknown status %', p_status;
  end if;
  if v_to = t.status then return; end if;
  update tickets set status = v_to, updated_at = now(),
         resolved_at = case when v_to in ('Done', 'Cancelled') then now() else null end where id = p_id;
  perform desk_log(p_id, 'status', p_note, t.status, v_to);
  -- keep the asset register in step
  if t.asset_id is not null then
    if t.type = 'Return an asset' and v_to = 'Done' then
      update assets set assigned_to = null, status = 'Available', updated_at = now() where id = t.asset_id;
      perform desk_log(p_id, 'note', 'Asset returned to the register as Available');
    elsif t.type = 'Asset problem' and v_to = 'In progress' then
      update assets set status = 'In repair' where id = t.asset_id and status in ('In use', 'Available');
    elsif t.type = 'Asset problem' and v_to = 'Done' then
      update assets set status = case when assigned_to is null then 'Available' else 'In use' end where id = t.asset_id and status = 'In repair';
    end if;
  end if;
end $$;

create or replace function public.desk_assign(p_id bigint, p_assignee uuid) returns void
language plpgsql volatile security definer set search_path = public as $$
declare t tickets;
begin
  if not is_admin() then raise exception 'Only admins can assign requests.'; end if;
  select * into t from tickets where id = p_id and workspace_id = ws();
  if not found then raise exception 'Request not found.'; end if;
  if p_assignee is not null and not exists (select 1 from profiles where id = p_assignee and active and workspace_id = ws()) then
    raise exception 'Pick an active team member.';
  end if;
  if p_assignee is not distinct from t.assignee_id then return; end if;
  update tickets set assignee_id = p_assignee, updated_at = now() where id = p_id;
  perform desk_log(p_id, 'assigned', coalesce((select display_name from profiles where id = p_assignee), 'nobody'));
end $$;

create or replace function public.desk_comment(p_id bigint, p_body text) returns void
language plpgsql volatile security definer set search_path = public as $$
declare t tickets;
begin
  if nullif(trim(p_body), '') is null then raise exception 'Write a comment first.'; end if;
  select * into t from tickets where id = p_id and workspace_id = ws();
  if not found or not is_member() or not coalesce(t.requester_id = auth.uid() or t.approver_id = auth.uid()
     or t.assignee_id = auth.uid() or is_admin(), false) then raise exception 'Request not found.'; end if;
  perform desk_log(p_id, 'comment', p_body);
  update tickets set updated_at = now() where id = p_id;
end $$;

-- Badge counts for the sidebar and dashboard
create or replace function public.desk_counts() returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'approvals', (select count(*) from tickets where approver_id = auth.uid() and status = 'Pending approval'),
    'my_open', (select count(*) from tickets where requester_id = auth.uid() and status not in ('Done', 'Rejected', 'Cancelled')),
    'to_work', (select count(*) from tickets where status in ('Open', 'Approved', 'In progress')
                 and (assignee_id = auth.uid() or (assignee_id is null and is_admin()))),
    'my_assets', (select count(*) from assets where assigned_to = auth.uid())) $$;

revoke execute on function public.desk_submit(jsonb), public.desk_update(bigint, jsonb), public.desk_decide(bigint, boolean, text),
  public.desk_set_status(bigint, text, text), public.desk_assign(bigint, uuid), public.desk_comment(bigint, text),
  public.desk_counts(), public.desk_log(bigint, text, text, text, text), public.desk_pick_approver(uuid, uuid) from anon, public;
grant execute on function public.desk_submit(jsonb), public.desk_update(bigint, jsonb), public.desk_decide(bigint, boolean, text),
  public.desk_set_status(bigint, text, text), public.desk_assign(bigint, uuid), public.desk_comment(bigint, text),
  public.desk_counts() to authenticated;
