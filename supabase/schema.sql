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

-- Hashing and tokens use only built-in functions (no pgcrypto): Supabase keeps pgcrypto in the "extensions" schema,
-- which functions with search_path = public can't see.
create or replace function public.pulse_sha256(p text) returns text language sql immutable set search_path = pg_catalog as $$
  select encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex') $$;
create or replace function public.pulse_token() returns text language sql volatile set search_path = pg_catalog as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') $$;

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
  role text not null default 'member' check (role in ('admin', 'member', 'contractor')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.profiles add column if not exists workspace_id uuid references public.workspaces (id) on delete cascade;
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('admin', 'member', 'contractor'));
-- contractors and consultants join with a separate code and only see Timecards, Onboarding, Tickets and Scheduler
alter table public.workspaces add column if not exists contractor_code text;
create unique index if not exists ux_workspaces_ccode on public.workspaces (upper(contractor_code));
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
    exit when not exists (select 1 from workspaces where upper(join_code) = v or upper(contractor_code) = v);
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
update public.workspaces set contractor_code = public.new_company_code(name) where contractor_code is null;
alter table public.workspaces alter column contractor_code set not null;

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

-- Staff (admins and members) see the business records; contractors don't.
create or replace function public.staff_ws() returns uuid
language sql stable security definer set search_path = public as $$
  select workspace_id from profiles where id = auth.uid() and active and role in ('admin', 'member')
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
  insert into workspaces (name, join_code, contractor_code, template, created_by)
  values (v_company, v_code, new_company_code(v_company), case when p_template in ('general', 'govcon', 'fundraising') then p_template else 'general' end, auth.uid())
  returning id into v_ws;
  insert into profiles (id, workspace_id, display_name, email, role) values (auth.uid(), v_ws, trim(p_name), v_email, 'admin');
  insert into activity (workspace_id, user_name, entity, action, summary)
    values (v_ws, split_part(trim(p_name), ' ', 1), 'team', 'create', trim(p_name) || ' started the ' || v_company || ' workspace');
  return v_code;
end $$;

-- Join an existing workspace with its company code. Returns the role ('member', or the existing role on re-join).
create or replace function public.join_company(p_code text, p_name text) returns text
language plpgsql volatile security definer set search_path = public as $$
declare v_ws uuid; v_email text; p profiles; v_role text;
begin
  perform check_join_rate();
  select id, case when upper(join_code) = upper(trim(coalesce(p_code, ''))) then 'member' else 'contractor' end into v_ws, v_role
    from workspaces where upper(trim(coalesce(p_code, ''))) in (upper(join_code), upper(contractor_code));
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
  insert into profiles (id, workspace_id, display_name, email, role) values (auth.uid(), v_ws, trim(p_name), v_email, v_role);
  insert into activity (workspace_id, user_name, entity, action, summary)
    values (v_ws, split_part(trim(p_name), ' ', 1), 'team', 'create', trim(p_name) || case when v_role = 'contractor' then ' joined as a contractor' else ' joined the team' end);
  -- link them to their onboarding record, if an admin set one up with this email
  update onboardings set user_id = auth.uid(), status = case when status = 'Planned' then 'In progress' else status end
   where workspace_id = v_ws and user_id is null and lower(email) = lower(v_email);
  return v_role;
end $$;

create or replace function public.get_company_code() returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Only admins can see the company code.'; end if;
  return (select join_code from workspaces where id = ws());
end $$;
create or replace function public.get_contractor_code() returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Only admins can see the contractor code.'; end if;
  return (select contractor_code from workspaces where id = ws());
end $$;

drop function if exists public.rotate_company_code(text);
create or replace function public.rotate_company_code(p_code text default null, p_kind text default 'team') returns text
language plpgsql volatile security definer set search_path = public as $$
declare v text := upper(trim(coalesce(p_code, '')));
begin
  if not is_admin() then raise exception 'Only admins can change the company code.'; end if;
  if v = '' then v := new_company_code((select name from workspaces where id = ws())); end if;
  if length(v) < 8 then raise exception 'Use at least 8 characters.'; end if;
  if exists (select 1 from workspaces where (upper(join_code) = v or upper(contractor_code) = v) and id <> ws())
     or v = upper((select case when p_kind = 'contractor' then join_code else contractor_code end from workspaces where id = ws())) then
    raise exception 'That code is taken. Try another.';
  end if;
  if p_kind = 'contractor' then update workspaces set contractor_code = v where id = ws();
  else update workspaces set join_code = v where id = ws(); end if;
  insert into activity (user_name, entity, action, summary)
    values (member_name(), 'team', 'update', case when p_kind = 'contractor' then 'Changed the contractor code' else 'Changed the company code' end);
  return v;
end $$;

create or replace function public.set_member(p_id uuid, p_role text, p_active boolean) returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_name text;
begin
  if not is_admin() then raise exception 'Only admins can change team members.'; end if;
  if p_role not in ('admin', 'member', 'contractor') then raise exception 'Unknown role %', p_role; end if;
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
create policy members_read on public.activity for select to authenticated using (workspace_id = staff_ws());
revoke insert, update, delete on public.activity from authenticated, anon;

do $$
declare t text;
begin
  foreach t in array array['opportunities', 'funding', 'contacts', 'resources', 'reviews', 'actions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists members_all on public.%I', t);
    execute format('create policy members_all on public.%I for all to authenticated using (workspace_id = staff_ws()) with check (workspace_id = staff_ws())', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

revoke execute on function public.join_company(text, text), public.create_workspace(text, text, text), public.get_company_code(),
  public.get_contractor_code(), public.rotate_company_code(text, text), public.set_member(uuid, text, boolean), public.update_workspace(jsonb),
  public.delete_workspace(text), public.check_join_rate(), public.check_new_member(text), public.add_workspace_wall(text) from anon, public;
grant execute on function public.join_company(text, text), public.create_workspace(text, text, text), public.get_company_code(),
  public.get_contractor_code(), public.rotate_company_code(text, text), public.set_member(uuid, text, boolean), public.update_workspace(jsonb),
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
  v_ws uuid := case when auth.uid() is null then p_workspace else staff_ws() end;
  r jsonb; v_id bigint; v_email text; v_name text; v_org text; v_notes text; v_tags text;
  n_new int := 0; n_merged int := 0; n_skipped int := 0;
  who text := case when auth.uid() is null then coalesce(nullif(trim(p_by), ''), 'system') else member_name() end;
  lbl text := nullif(trim(p_label), '');
begin
  if auth.uid() is not null and staff_ws() is null then raise exception 'Only team members can import contacts.'; end if;
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
    if not exists (select 1 from profiles where id = p_choice and active and workspace_id = ws() and role <> 'contractor') then
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

-- =====================================================================
-- Timecards: projects, daily hours, weekly timesheets that are submitted and approved
--   * Everyone logs their own hours. Contractors only see the projects they're assigned to;
--     staff see every project unless it is limited to its assigned people.
--   * A week is Draft → Submitted → Approved (or Rejected, which reopens it for edits).
--     Hours can't change while a week is Submitted or Approved.
--   * Admins approve timesheets, and so does a project's approver for weeks with hours on it.
-- =====================================================================
create table if not exists public.projects (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  name text not null, code text, client text,
  billable boolean not null default true, rate numeric, budget_hours numeric,
  status text not null default 'Active' check (status in ('Active', 'Paused', 'Closed')),
  limited boolean not null default false,          -- true: only assigned people can log time
  approver_id uuid references public.profiles (id) on delete set null,
  opportunity_id bigint, notes text,
  created_at timestamptz default now(), updated_at timestamptz default now(), updated_by text
);
create table if not exists public.project_people (
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  project_id bigint not null references public.projects (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  rate numeric,
  primary key (project_id, user_id)
);
create table if not exists public.timesheets (
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  week_start date not null check (extract(isodow from week_start) = 1),
  status text not null default 'Draft' check (status in ('Draft', 'Submitted', 'Approved', 'Rejected')),
  note text, submitted_at timestamptz, decided_by uuid, decided_at timestamptz, decision_note text,
  primary key (user_id, week_start)
);
create table if not exists public.time_entries (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  project_id bigint not null references public.projects (id) on delete cascade,
  work_date date not null,
  hours numeric(5, 2) not null check (hours > 0 and hours <= 24),
  note text,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  unique (user_id, project_id, work_date)
);
create index if not exists ix_projects_ws on public.projects (workspace_id, status);
create index if not exists ix_time_user on public.time_entries (user_id, work_date);
create index if not exists ix_time_project on public.time_entries (project_id, work_date);
create index if not exists ix_timesheets_ws on public.timesheets (workspace_id, status, week_start);

create or replace function public.week_of(d date) returns date language sql immutable as $$
  select d - (extract(isodow from d)::int - 1) $$;

-- small checks used by the security rules (run as owner so the rules don't loop through each other)
create or replace function public.on_project(p_project bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from project_people where project_id = p_project and user_id = auth.uid()) $$;
create or replace function public.approves_project(p_project bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from projects where id = p_project and approver_id = auth.uid() and workspace_id = ws()) $$;
create or replace function public.in_my_ws(p_user uuid, p_project bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = p_user and workspace_id = ws())
     and exists (select 1 from projects where id = p_project and workspace_id = ws()) $$;

-- can the signed-in person log time on this project?
create or replace function public.can_log(p_project bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from projects p where p.id = p_project and p.workspace_id = ws() and p.status = 'Active'
                 and ((not p.limited and staff_ws() is not null)
                      or exists (select 1 from project_people pp where pp.project_id = p.id and pp.user_id = auth.uid())))
$$;
create or replace function public.can_approve_week(p_user uuid, p_week date) returns boolean
language sql stable security definer set search_path = public as $$
  select is_admin() or exists (select 1 from time_entries e join projects p on p.id = e.project_id
      where e.user_id = p_user and week_of(e.work_date) = p_week and p.approver_id = auth.uid() and p.workspace_id = ws())
$$;

-- hours can only change in your own Draft or Rejected weeks, on projects you can log to
create or replace function public.time_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare r time_entries := case when tg_op = 'DELETE' then old else new end; st text;
begin
  if auth.uid() is null then return r; end if;   -- loader scripts
  if r.user_id <> auth.uid() then raise exception 'You can only change your own hours.'; end if;
  select status into st from timesheets where user_id = r.user_id and week_start = week_of(r.work_date);
  if st in ('Submitted', 'Approved') then raise exception 'That week is %. Ask an approver to reopen it.', lower(st); end if;
  if tg_op = 'UPDATE' and week_of(old.work_date) <> week_of(new.work_date) then raise exception 'Move hours within the same week.'; end if;
  if tg_op <> 'DELETE' then
    if not can_log(r.project_id) then raise exception 'You aren''t on that project, or it''s closed.'; end if;
    new.updated_at := now();
  end if;
  return r;
end $$;
drop trigger if exists guard on public.time_entries;
create trigger guard before insert or update or delete on public.time_entries for each row execute function public.time_guard();
drop trigger if exists stamp on public.projects;
create trigger stamp before insert or update on public.projects for each row execute function public.stamp_row();

alter table public.projects enable row level security;
alter table public.project_people enable row level security;
alter table public.timesheets enable row level security;
alter table public.time_entries enable row level security;
drop policy if exists tc_read on public.projects;
create policy tc_read on public.projects for select to authenticated using (workspace_id = ws() and (staff_ws() is not null or on_project(id)));
drop policy if exists tc_admin on public.projects;
create policy tc_admin on public.projects for all to authenticated using (is_admin() and workspace_id = ws()) with check (is_admin() and workspace_id = ws());
drop policy if exists tc_read on public.project_people;
create policy tc_read on public.project_people for select to authenticated using (workspace_id = ws() and (staff_ws() is not null or user_id = auth.uid()));
drop policy if exists tc_admin on public.project_people;
create policy tc_admin on public.project_people for all to authenticated using (is_admin() and workspace_id = ws())
  with check (is_admin() and workspace_id = ws() and in_my_ws(user_id, project_id));
drop policy if exists tc_read on public.timesheets;
create policy tc_read on public.timesheets for select to authenticated using (workspace_id = ws() and (user_id = auth.uid() or can_approve_week(user_id, week_start)));
drop policy if exists tc_read on public.time_entries;
create policy tc_read on public.time_entries for select to authenticated using (workspace_id = ws() and (user_id = auth.uid() or is_admin()
  or approves_project(project_id)));
drop policy if exists tc_own on public.time_entries;
create policy tc_own on public.time_entries for all to authenticated using (workspace_id = ws() and user_id = auth.uid())
  with check (workspace_id = ws() and user_id = auth.uid());
revoke all on public.projects, public.project_people, public.timesheets, public.time_entries from anon;
revoke insert, update, delete on public.timesheets from authenticated;
grant select on public.timesheets to authenticated;
grant select, insert, update, delete on public.projects, public.project_people, public.time_entries to authenticated;

create or replace function public.ts_submit(p_week date, p_note text default null) returns void
language plpgsql volatile security definer set search_path = public as $$
declare st text;
begin
  if ws() is null then raise exception 'Join a workspace first.'; end if;
  if extract(isodow from p_week) <> 1 then raise exception 'Weeks start on Monday.'; end if;
  if not exists (select 1 from time_entries where user_id = auth.uid() and week_of(work_date) = p_week) then
    raise exception 'Add some hours before submitting.';
  end if;
  select status into st from timesheets where user_id = auth.uid() and week_start = p_week;
  if st in ('Submitted', 'Approved') then raise exception 'This week is already %.', lower(st); end if;
  insert into timesheets (workspace_id, user_id, week_start, status, note, submitted_at)
  values (ws(), auth.uid(), p_week, 'Submitted', nullif(trim(p_note), ''), now())
  on conflict (user_id, week_start) do update set status = 'Submitted', note = excluded.note, submitted_at = now(),
    decided_by = null, decided_at = null, decision_note = null;
end $$;

create or replace function public.ts_decide(p_user uuid, p_week date, p_approve boolean, p_note text default null) returns void
language plpgsql volatile security definer set search_path = public as $$
declare t timesheets;
begin
  select * into t from timesheets where user_id = p_user and week_start = p_week and workspace_id = ws() for update;
  if not found then raise exception 'Timesheet not found.'; end if;
  if not can_approve_week(p_user, p_week) then raise exception 'You can''t approve this timesheet.'; end if;
  if p_user = auth.uid() and exists (select 1 from profiles where workspace_id = ws() and role = 'admin' and active and id <> auth.uid()) then
    raise exception 'Ask another admin to approve your own timesheet.';
  end if;
  if t.status <> 'Submitted' then raise exception 'This timesheet isn''t waiting for approval.'; end if;
  if not p_approve and nullif(trim(p_note), '') is null then raise exception 'Add a reason so they know what to fix.'; end if;
  update timesheets set status = case when p_approve then 'Approved' else 'Rejected' end, decided_by = auth.uid(),
         decided_at = now(), decision_note = nullif(trim(p_note), '') where user_id = p_user and week_start = p_week;
end $$;

-- approvers (or the person, while it's only Submitted) can pull a week back to Draft
create or replace function public.ts_reopen(p_user uuid, p_week date) returns void
language plpgsql volatile security definer set search_path = public as $$
declare t timesheets;
begin
  select * into t from timesheets where user_id = p_user and week_start = p_week and workspace_id = ws();
  if not found then raise exception 'Timesheet not found.'; end if;
  if not (can_approve_week(p_user, p_week) or (p_user = auth.uid() and t.status = 'Submitted')) then
    raise exception 'Only an approver can reopen this week.';
  end if;
  update timesheets set status = 'Draft', decided_by = null, decided_at = null, decision_note = null
   where user_id = p_user and week_start = p_week;
end $$;

-- hours by project and person between two dates (what the caller is allowed to see)
create or replace function public.ts_report(p_from date, p_to date) returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(x order by x.project, x.person), '[]') from (
    select p.id project_id, p.name project, p.client, p.billable, coalesce(pp.rate, p.rate) rate, pr.id user_id, pr.display_name person,
           sum(e.hours) hours, sum(e.hours) filter (where ts.status = 'Approved') approved_hours,
           sum(e.hours) * coalesce(pp.rate, p.rate) amount
      from time_entries e join projects p on p.id = e.project_id join profiles pr on pr.id = e.user_id
      left join project_people pp on pp.project_id = p.id and pp.user_id = e.user_id
      left join timesheets ts on ts.user_id = e.user_id and ts.week_start = week_of(e.work_date)
     where e.work_date between p_from and p_to
     group by p.id, p.name, p.client, p.billable, coalesce(pp.rate, p.rate), pr.id, pr.display_name) x $$;

revoke execute on function public.ts_submit(date, text), public.ts_decide(uuid, date, boolean, text), public.ts_reopen(uuid, date),
  public.ts_report(date, date), public.can_log(bigint), public.can_approve_week(uuid, date),
  public.on_project(bigint), public.approves_project(bigint), public.in_my_ws(uuid, bigint) from anon, public;
grant execute on function public.ts_submit(date, text), public.ts_decide(uuid, date, boolean, text), public.ts_reopen(uuid, date),
  public.ts_report(date, date), public.can_log(bigint), public.can_approve_week(uuid, date),
  public.on_project(bigint), public.approves_project(bigint), public.in_my_ws(uuid, bigint) to authenticated;

-- =====================================================================
-- Onboarding: contractors, consultants and new hires, each with a checklist
--   * Staff see everyone being onboarded; admins and the record's owner make changes.
--   * The person themselves sees their own record once they join with the contractor code
--     (matched by email) and can tick off the items marked for them.
-- =====================================================================
create table if not exists public.onboardings (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  name text not null, email text, phone text,
  kind text not null default 'Contractor' check (kind in ('Contractor', 'Consultant', 'Employee', 'Intern', 'Advisor')),
  firm text, role_title text,
  start_date date, end_date date, rate numeric, rate_unit text default 'hour' check (rate_unit in ('hour', 'day', 'month', 'fixed', 'year')),
  status text not null default 'Planned' check (status in ('Planned', 'In progress', 'Active', 'Offboarding', 'Offboarded')),
  owner_id uuid references public.profiles (id) on delete set null,
  user_id uuid references public.profiles (id) on delete set null,
  checklist jsonb not null default '[]',   -- [{id, text, who: 'us'|'them', done, done_at, done_by, link}]
  notes text,
  created_at timestamptz default now(), updated_at timestamptz default now(), updated_by text
);
create index if not exists ix_onb_ws on public.onboardings (workspace_id, status);
create unique index if not exists ux_onb_email on public.onboardings (workspace_id, lower(email)) where email is not null and status <> 'Offboarded';
drop trigger if exists stamp on public.onboardings;
create trigger stamp before insert or update on public.onboardings for each row execute function public.stamp_row();
alter table public.onboardings enable row level security;
drop policy if exists onb_read on public.onboardings;
create policy onb_read on public.onboardings for select to authenticated using (workspace_id = ws() and (staff_ws() is not null or user_id = auth.uid()));
drop policy if exists onb_write on public.onboardings;
create policy onb_write on public.onboardings for insert to authenticated with check (workspace_id = staff_ws());
drop policy if exists onb_update on public.onboardings;
create policy onb_update on public.onboardings for update to authenticated
  using (workspace_id = ws() and (is_admin() or owner_id = auth.uid())) with check (workspace_id = ws());
drop policy if exists onb_delete on public.onboardings;
create policy onb_delete on public.onboardings for delete to authenticated using (workspace_id = ws() and is_admin());
revoke all on public.onboardings from anon;
grant select, insert, update, delete on public.onboardings to authenticated;

-- the person being onboarded ticks their own items
create or replace function public.onb_tick(p_id bigint, p_item text, p_done boolean) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare o onboardings; v jsonb;
begin
  select * into o from onboardings where id = p_id and workspace_id = ws();
  if not found then raise exception 'Not found.'; end if;
  if not (is_admin() or o.owner_id = auth.uid() or (o.user_id = auth.uid() and exists (
      select 1 from jsonb_array_elements(o.checklist) i where i ->> 'id' = p_item and i ->> 'who' = 'them'))) then
    raise exception 'Only the owner or an admin can tick this item.';
  end if;
  select jsonb_agg(case when i ->> 'id' = p_item then i || jsonb_build_object('done', p_done,
           'done_at', case when p_done then now() end, 'done_by', case when p_done then member_name() end) else i end)
    into v from jsonb_array_elements(o.checklist) i;
  update onboardings set checklist = coalesce(v, '[]') where id = p_id;
  return v;
end $$;
revoke execute on function public.onb_tick(bigint, text, boolean) from anon, public;
grant execute on function public.onb_tick(bigint, text, boolean) to authenticated;

-- =====================================================================
-- Scheduler: each person connects their Google or Outlook calendar; the team sees free/busy
--   * Calendar tokens live in calendar_accounts and are NEVER readable from the browser:
--     only the server function (supabase/functions/calendar, service key) reads or writes them.
--   * busy_blocks hold start/end times only (no titles), refreshed by the function, so teammates
--     can find a time without seeing each other's meeting details.
--   * meetings booked through Pulse are visible to the organizer and the invited teammates.
-- =====================================================================
create table if not exists public.calendar_accounts (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  email text, status text not null default 'connected' check (status in ('connected', 'needs_reconnect')),
  refresh_token text, access_token text, token_expires_at timestamptz,
  last_sync_at timestamptz, last_error text,
  created_at timestamptz not null default now(),
  unique (user_id, provider)
);
create table if not exists public.busy_blocks (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  provider text not null, start_at timestamptz not null, end_at timestamptz not null
);
create index if not exists ix_busy_user on public.busy_blocks (user_id, start_at);
create index if not exists ix_busy_ws on public.busy_blocks (workspace_id, start_at);
create table if not exists public.meetings (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  organizer_id uuid not null references public.profiles (id) on delete cascade,
  title text not null, description text, start_at timestamptz not null, end_at timestamptz not null,
  attendee_ids uuid[] not null default '{}', guest_emails text[] not null default '{}',
  provider text, provider_event_id text, join_url text,
  status text not null default 'Booked' check (status in ('Booked', 'Cancelled')),
  created_at timestamptz not null default now()
);
create index if not exists ix_meetings_ws on public.meetings (workspace_id, start_at);
alter table public.calendar_accounts enable row level security;
alter table public.busy_blocks enable row level security;
alter table public.meetings enable row level security;
drop policy if exists own_read on public.calendar_accounts;
create policy own_read on public.calendar_accounts for select to authenticated using (workspace_id = ws() and (user_id = auth.uid() or is_admin()));
revoke all on public.calendar_accounts from anon, authenticated;
grant select (id, workspace_id, user_id, provider, email, status, last_sync_at, last_error, created_at) on public.calendar_accounts to authenticated;
drop policy if exists team_read on public.busy_blocks;
create policy team_read on public.busy_blocks for select to authenticated using (workspace_id = ws());
revoke all on public.busy_blocks from anon, authenticated;
grant select on public.busy_blocks to authenticated;
drop policy if exists mtg_read on public.meetings;
create policy mtg_read on public.meetings for select to authenticated using (workspace_id = ws() and (organizer_id = auth.uid() or auth.uid() = any (attendee_ids) or is_admin()));
revoke all on public.meetings from anon, authenticated;
grant select on public.meetings to authenticated;

-- who is connected (no tokens): the team calendar shows who has a calendar linked
create or replace function public.calendar_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('user_id', user_id, 'provider', provider, 'status', status, 'last_sync_at', last_sync_at)), '[]')
    from calendar_accounts where workspace_id = ws() $$;
revoke execute on function public.calendar_status() from anon, public;
grant execute on function public.calendar_status() to authenticated;

-- =====================================================================
-- Chief of Staff: an AI assistant (Claude) that reads what the signed-in person can see and
-- recommends what to do. The server function (supabase/functions/chief) calls chief_context()
-- AS THE PERSON, so row-level security limits it to their own workspace and permissions.
-- Suggestions only happen when the person clicks to accept them.
-- =====================================================================
create table if not exists public.reminders (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  text text not null, remind_at timestamptz not null, link text,
  done boolean not null default false, from_chief boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists ix_reminders_user on public.reminders (user_id, done, remind_at);
create table if not exists public.chief_briefs (
  user_id uuid not null references public.profiles (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  brief_date date not null, content jsonb not null, created_at timestamptz not null default now(),
  primary key (user_id, brief_date)
);
create table if not exists public.chief_usage (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  day date not null default current_date, calls int not null default 0,
  primary key (workspace_id, day)
);
alter table public.reminders enable row level security;
alter table public.chief_briefs enable row level security;
alter table public.chief_usage enable row level security;
drop policy if exists own_all on public.reminders;
create policy own_all on public.reminders for all to authenticated using (workspace_id = ws() and user_id = auth.uid())
  with check (workspace_id = ws() and user_id = auth.uid());
drop policy if exists own_read on public.chief_briefs;
create policy own_read on public.chief_briefs for select to authenticated using (user_id = auth.uid() and workspace_id = ws());
revoke all on public.reminders, public.chief_briefs, public.chief_usage from anon;
revoke insert, update, delete on public.chief_briefs, public.chief_usage from authenticated;
revoke select on public.chief_usage from authenticated;
grant select, insert, update, delete on public.reminders to authenticated;
grant select on public.chief_briefs to authenticated;

-- Everything the assistant needs for one person's day, limited to what that person may see.
create or replace function public.chief_context(p_tz text default 'America/New_York') returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  t date := (now() at time zone coalesce(nullif(p_tz, ''), 'UTC'))::date;
  me text := member_name(); wk date := week_of(t); staff boolean := staff_ws() is not null;
begin
  if ws() is null then raise exception 'Join a workspace first.'; end if;
  return jsonb_build_object(
    'today', t, 'weekday', to_char(t, 'FMDay'), 'timezone', p_tz,
    'me', (select jsonb_build_object('name', display_name, 'first_name', me, 'role', role) from profiles where id = auth.uid()),
    'workspace', (select name from workspaces where id = ws()),
    'team', (select coalesce(jsonb_agg(jsonb_build_object('name', display_name, 'role', role) order by display_name), '[]') from profiles where workspace_id = ws() and active),
    'my_actions', case when staff then coalesce((select jsonb_agg(jsonb_build_object('id', id, 'text', text, 'due', due_date, 'linked', linked_type) order by due_date nulls last)
        from actions where status = 'Open' and lower(coalesce(owner, '')) = lower(me)), '[]') end,
    'team_overdue_actions', case when staff then coalesce((select jsonb_agg(jsonb_build_object('text', text, 'owner', owner, 'due', due_date) order by due_date)
        from (select * from actions where status = 'Open' and due_date < t order by due_date limit 15) a), '[]') end,
    'deadlines_14d', case when staff then coalesce((select jsonb_agg(x order by x.deadline) from (
        select 'opportunity' kind, id, title name, agency org, deadline, stage status, owner, priority from opportunities
         where stage in ('Identified', 'Qualifying', 'Pursuing', 'Submitted') and deadline between t and t + 14
        union all select 'funding', id, name, organization, deadline, status, owner, null from funding
         where status in ('Identified', 'Pursuing', 'Submitted') and deadline between t and t + 14) x), '[]') end,
    'stale_pipeline', case when staff then (select count(*) from opportunities where stage in ('Identified', 'Qualifying', 'Pursuing') and deadline < t) end,
    'my_followups', case when staff then coalesce((select jsonb_agg(x order by x.next_step_date) from (
        select id, name, organization, next_step, next_step_date from contacts where next_step_date <= t + 3
           and lower(coalesce(owner, '')) = lower(me) and coalesce(status, '') not in ('Do Not Contact', 'Dormant')
         order by next_step_date limit 25) x), '[]') end,
    'approvals_waiting', jsonb_build_object(
        'requests', coalesce((select jsonb_agg(jsonb_build_object('number', number, 'type', type, 'title', title, 'since', created_at::date))
            from tickets where approver_id = auth.uid() and status = 'Pending approval'), '[]'),
        'timesheets', (select count(*) from timesheets where status = 'Submitted' and user_id <> auth.uid())),
    'my_open_requests', coalesce((select jsonb_agg(jsonb_build_object('number', number, 'title', title, 'status', status))
        from tickets where requester_id = auth.uid() and status not in ('Done', 'Rejected', 'Cancelled')), '[]'),
    'my_time', jsonb_build_object(
        'hours_this_week', (select coalesce(sum(hours), 0) from time_entries where user_id = auth.uid() and work_date >= wk),
        'last_week_status', coalesce((select status from timesheets where user_id = auth.uid() and week_start = wk - 7), 'Not submitted'),
        'logs_time', exists (select 1 from time_entries where user_id = auth.uid() and work_date >= wk - 35)),
    'onboarding', case when staff then coalesce((select jsonb_agg(jsonb_build_object('name', name, 'kind', kind, 'start', start_date, 'status', status,
          'my_open_items', (select count(*) from jsonb_array_elements(checklist) i where not coalesce((i ->> 'done')::boolean, false) and i ->> 'who' = 'us')))
        from onboardings where status in ('Planned', 'In progress', 'Offboarding') and (owner_id = auth.uid() or is_admin())), '[]')
      else coalesce((select jsonb_agg(i ->> 'text') from onboardings o, jsonb_array_elements(o.checklist) i
        where o.user_id = auth.uid() and i ->> 'who' = 'them' and not coalesce((i ->> 'done')::boolean, false)), '[]') end,
    'meetings_next_2_days', coalesce((select jsonb_agg(jsonb_build_object('title', title, 'start', start_at, 'end', end_at,
          'with', (select string_agg(display_name, ', ') from profiles where id = any (m.attendee_ids))) order by start_at)
        from meetings m where status = 'Booked' and start_at >= now() - interval '1 hour' and start_at < (t + 2)::timestamp at time zone p_tz
          and (organizer_id = auth.uid() or auth.uid() = any (attendee_ids))), '[]'),
    'busy_today', coalesce((select jsonb_agg(jsonb_build_object('start', start_at, 'end', end_at) order by start_at) from busy_blocks
        where user_id = auth.uid() and start_at < (t + 1)::timestamp at time zone p_tz and end_at > t::timestamp at time zone p_tz), '[]'),
    'my_project_tasks', my_tasks(),
    'projects_needing_attention', case when staff then coalesce((select jsonb_agg(jsonb_build_object('name', name, 'health', health, 'end', end_date)) from projects
        where status = 'Active' and (health <> 'On track' or end_date < t)), '[]') end,
    'agreements', case when staff then jsonb_build_object(
        'awaiting_signature', (select count(*) from agreements where status = 'Out for signature'),
        'ending_60_days', coalesce((select jsonb_agg(jsonb_build_object('title', title, 'ends', end_date)) from agreements where status = 'Active' and end_date between t and t + 60), '[]'),
        'to_close_out', (select count(*) from agreements where status in ('Expired', 'Terminated'))) end,
    'calendar_connected', exists (select 1 from calendar_accounts where user_id = auth.uid()),
    'reminders_due', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'text', text, 'at', remind_at) order by remind_at)
        from reminders where user_id = auth.uid() and not done and remind_at < (t + 2)::timestamp at time zone p_tz), '[]'),
    'reviews', case when staff then coalesce((select jsonb_object_agg(cadence, last) from (select cadence, max(review_date) last from reviews group by cadence) r), '{}') end,
    'recent_activity', case when staff then coalesce((select jsonb_agg(a.summary order by a.ts desc) from (select summary, ts from activity
        where ts > now() - interval '2 days' order by ts desc limit 15) a), '[]') end);
end $$;
revoke execute on function public.chief_context(text) from anon, public;
grant execute on function public.chief_context(text) to authenticated;

-- =====================================================================
-- Agreements: generate contracts from templates, sign them (Pulse e-sign or an uploaded signed copy),
-- and manage them to close-out.
--   Draft → Out for signature → Active (executed) → [Amended] → Expired / Terminated → Closed out
--   (or Voided / Declined before execution).
--   * The text is locked and fingerprinted (SHA-256) when it is sent; it can't change afterwards. To change an
--     executed agreement, create an Amendment linked to it.
--   * Each signer gets a private link. Only a hash of the link's token is stored. Signing records the typed or
--     drawn signature, consent to sign electronically, time, IP address and browser, in an audit trail.
--   * Staff see the workspace's agreements; a contractor sees only agreements they are a signer on.
-- =====================================================================
create table if not exists public.agreement_templates (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  key text not null, kind text not null default 'other', name text not null, blurb text,
  body text not null, fields jsonb not null default '[]', signers jsonb not null default '[]', checklist jsonb not null default '[]',
  based_on text, active boolean not null default true,
  created_at timestamptz default now(), updated_at timestamptz default now(), updated_by text
);
create table if not exists public.agreements (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  number int,
  template_key text not null, template_name text not null, kind text not null default 'other',
  title text not null, party_name text, party_email text,
  onboarding_id bigint references public.onboardings (id) on delete set null,
  contact_id bigint references public.contacts (id) on delete set null,
  project_id bigint references public.projects (id) on delete set null,
  opportunity_id bigint references public.opportunities (id) on delete set null,
  parent_id bigint references public.agreements (id) on delete set null,   -- amendments point at the agreement they amend
  fields jsonb not null default '{}',
  body_html text, doc_hash text,
  status text not null default 'Draft' check (status in ('Draft', 'Out for signature', 'Active', 'Expired', 'Terminated', 'Closed out', 'Voided', 'Declined')),
  value numeric, currency text, start_date date, end_date date,
  owner_id uuid references public.profiles (id) on delete set null,
  sent_at timestamptz, executed_at timestamptz, executed_via text, ended_at timestamptz, end_reason text,
  closeout jsonb not null default '[]', closed_at timestamptz, closeout_note text,
  created_by uuid default auth.uid(), created_at timestamptz default now(), updated_at timestamptz default now(), updated_by text
);
create unique index if not exists ux_agreements_number on public.agreements (workspace_id, number);
create index if not exists ix_agreements_ws on public.agreements (workspace_id, status);
create index if not exists ix_agreements_onb on public.agreements (onboarding_id);
create table if not exists public.agreement_signers (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  agreement_id bigint not null references public.agreements (id) on delete cascade,
  role text not null, label text, sign_order int not null default 1,
  name text, email text, title text, user_id uuid references public.profiles (id) on delete set null,
  token_hash text unique, token_expires_at timestamptz,
  status text not null default 'Waiting' check (status in ('Waiting', 'Viewed', 'Signed', 'Declined')),
  viewed_at timestamptz, consent_at timestamptz, signed_at timestamptz,
  signature_kind text check (signature_kind in ('typed', 'drawn')), signature_data text,
  ip text, user_agent text, decline_reason text
);
create index if not exists ix_agr_signers on public.agreement_signers (agreement_id);
create table if not exists public.agreement_events (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  agreement_id bigint not null references public.agreements (id) on delete cascade,
  ts timestamptz not null default now(), actor text, kind text not null, detail text, ip text
);
create index if not exists ix_agr_events on public.agreement_events (agreement_id, ts);
create table if not exists public.agreement_files (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  agreement_id bigint not null references public.agreements (id) on delete cascade,
  name text not null, mime text, size int, sha256 text, data_b64 text not null,   -- up to ~10 MB; move to Storage later if needed
  uploaded_by text, created_at timestamptz not null default now()
);
drop trigger if exists stamp on public.agreement_templates;
create trigger stamp before insert or update on public.agreement_templates for each row execute function public.stamp_row();

alter table public.agreement_templates enable row level security;
alter table public.agreements enable row level security;
alter table public.agreement_signers enable row level security;
alter table public.agreement_events enable row level security;
alter table public.agreement_files enable row level security;
drop policy if exists tpl_read on public.agreement_templates;
create policy tpl_read on public.agreement_templates for select to authenticated using (workspace_id = staff_ws());
drop policy if exists tpl_admin on public.agreement_templates;
create policy tpl_admin on public.agreement_templates for all to authenticated using (is_admin() and workspace_id = ws()) with check (is_admin() and workspace_id = ws());

create or replace function public.agr_is_signer(p_agreement bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from agreement_signers where agreement_id = p_agreement and user_id = auth.uid()) $$;
drop policy if exists agr_read on public.agreements;
create policy agr_read on public.agreements for select to authenticated using (workspace_id = ws() and (staff_ws() is not null or agr_is_signer(id)));
drop policy if exists agr_read on public.agreement_signers;
create policy agr_read on public.agreement_signers for select to authenticated using (workspace_id = ws() and (staff_ws() is not null or agr_is_signer(agreement_id)));
drop policy if exists agr_read on public.agreement_events;
create policy agr_read on public.agreement_events for select to authenticated using (workspace_id = staff_ws());
drop policy if exists agr_read on public.agreement_files;
create policy agr_read on public.agreement_files for select to authenticated using (workspace_id = ws() and (staff_ws() is not null or agr_is_signer(agreement_id)));
revoke all on public.agreement_templates, public.agreements, public.agreement_signers, public.agreement_events, public.agreement_files from anon;
revoke insert, update, delete on public.agreements, public.agreement_signers, public.agreement_events, public.agreement_files from authenticated;
revoke all on public.agreement_signers from authenticated;   -- then grant every column except token_hash
grant select on public.agreements, public.agreement_events, public.agreement_files to authenticated;
grant select (id, workspace_id, agreement_id, role, label, sign_order, name, email, title, user_id, token_expires_at, status, viewed_at, consent_at,
  signed_at, signature_kind, signature_data, ip, user_agent, decline_reason) on public.agreement_signers to authenticated;
grant select, insert, update, delete on public.agreement_templates to authenticated;

create or replace function public.agr_request_ip() returns text language sql stable as $$
  select nullif(split_part(coalesce(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ''), ',', 1), '') $$;
create or replace function public.agr_log(p_agreement bigint, p_kind text, p_detail text default null, p_actor text default null) returns void
language sql security definer set search_path = public as $$
  insert into agreement_events (workspace_id, agreement_id, actor, kind, detail, ip)
  select workspace_id, id, coalesce(p_actor, member_name()), p_kind, p_detail, agr_request_ip() from agreements where id = p_agreement $$;
create or replace function public.agr_get(p_id bigint) returns agreements
language plpgsql stable security definer set search_path = public as $$
declare a agreements;
begin
  select * into a from agreements where id = p_id and workspace_id = staff_ws();
  if not found then raise exception 'Agreement not found.'; end if;
  return a;
end $$;

-- save a draft (new or existing). p: {id?, template_key, template_name, kind, title, party_name, party_email, fields, body_html,
--   onboarding_id, contact_id, project_id, opportunity_id, parent_id, value, currency, start_date, end_date}
create or replace function public.agr_save(p jsonb) returns bigint
language plpgsql volatile security definer set search_path = public as $$
declare a agreements; v_id bigint := nullif(p ->> 'id', '')::bigint;
begin
  if staff_ws() is null then raise exception 'Only team members can prepare agreements.'; end if;
  if coalesce(trim(p ->> 'title'), '') = '' then raise exception 'Give the agreement a title.'; end if;
  if v_id is not null then
    a := agr_get(v_id);
    if a.status <> 'Draft' then raise exception 'This agreement was already sent, so its text is locked. Void it or create an amendment.'; end if;
  end if;
  if nullif(p ->> 'onboarding_id', '') is not null and not exists (select 1 from onboardings where id = (p ->> 'onboarding_id')::bigint and workspace_id = staff_ws()) then raise exception 'Onboarding record not found.'; end if;
  if nullif(p ->> 'parent_id', '') is not null and not exists (select 1 from agreements where id = (p ->> 'parent_id')::bigint and workspace_id = staff_ws()) then raise exception 'Original agreement not found.'; end if;
  if v_id is null then
    perform pg_advisory_xact_lock(hashtext('agreements:' || staff_ws()::text));
    insert into agreements (workspace_id, number, template_key, template_name, kind, title, owner_id)
    values (staff_ws(), (select coalesce(max(number), 0) + 1 from agreements where workspace_id = staff_ws()),
            p ->> 'template_key', coalesce(p ->> 'template_name', 'Agreement'), coalesce(p ->> 'kind', 'other'), trim(p ->> 'title'), auth.uid())
    returning id into v_id;
    perform agr_log(v_id, 'created', trim(p ->> 'title'));
  end if;
  update agreements set
    template_key = coalesce(p ->> 'template_key', template_key), template_name = coalesce(p ->> 'template_name', template_name),
    kind = coalesce(p ->> 'kind', kind), title = trim(p ->> 'title'),
    party_name = nullif(trim(p ->> 'party_name'), ''), party_email = lower(nullif(trim(p ->> 'party_email'), '')),
    fields = coalesce(p -> 'fields', '{}'), body_html = p ->> 'body_html',
    onboarding_id = nullif(p ->> 'onboarding_id', '')::bigint, contact_id = nullif(p ->> 'contact_id', '')::bigint,
    project_id = nullif(p ->> 'project_id', '')::bigint, opportunity_id = nullif(p ->> 'opportunity_id', '')::bigint,
    parent_id = nullif(p ->> 'parent_id', '')::bigint,
    value = nullif(p ->> 'value', '')::numeric, currency = nullif(p ->> 'currency', ''),
    start_date = nullif(p ->> 'start_date', '')::date, end_date = nullif(p ->> 'end_date', '')::date,
    updated_at = now(), updated_by = member_name()
  where id = v_id;
  return v_id;
end $$;

-- lock the text and create signing links. p_signers: [{role, label, name, email, title, user_id?, sign_order}]
-- Returns [{role, name, email, token}] — the only time the tokens are shown.
create or replace function public.agr_send(p_id bigint, p_signers jsonb, p_days int default 30) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare a agreements; s jsonb; tok text; out jsonb := '[]'; v_uid uuid;
begin
  a := agr_get(p_id);
  if a.status <> 'Draft' then raise exception 'Only drafts can be sent.'; end if;
  if coalesce(a.body_html, '') = '' then raise exception 'The agreement has no text yet.'; end if;
  if a.body_html ~ 'agr-blank' then raise exception 'Fill in every blank before sending (look for the [highlighted] gaps).'; end if;
  if jsonb_typeof(p_signers) <> 'array' or jsonb_array_length(p_signers) = 0 then raise exception 'Add at least one signer.'; end if;
  delete from agreement_signers where agreement_id = p_id;
  for s in select value from jsonb_array_elements(p_signers) loop
    if coalesce(trim(s ->> 'name'), '') = '' then raise exception 'Every signer needs a name.'; end if;
    if coalesce(s ->> 'email', '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Every signer needs a valid email (%).', s ->> 'name'; end if;
    v_uid := nullif(s ->> 'user_id', '')::uuid;
    if v_uid is null then select id into v_uid from profiles where workspace_id = a.workspace_id and lower(email) = lower(s ->> 'email') and active limit 1; end if;
    tok := pulse_token();
    insert into agreement_signers (workspace_id, agreement_id, role, label, sign_order, name, email, title, user_id, token_hash, token_expires_at)
    values (a.workspace_id, p_id, coalesce(s ->> 'role', 'party'), s ->> 'label', coalesce((s ->> 'sign_order')::int, 1), trim(s ->> 'name'),
            lower(trim(s ->> 'email')), nullif(trim(s ->> 'title'), ''), v_uid, pulse_sha256(tok), now() + make_interval(days => greatest(1, least(p_days, 90))));
    out := out || jsonb_build_object('role', coalesce(s ->> 'role', 'party'), 'name', trim(s ->> 'name'), 'email', lower(trim(s ->> 'email')), 'token', tok);
  end loop;
  update agreements set status = 'Out for signature', sent_at = now(), doc_hash = pulse_sha256(body_html), updated_at = now() where id = p_id;
  perform agr_log(p_id, 'sent', 'Sent for signature to ' || (select string_agg(name, ', ' order by sign_order) from agreement_signers where agreement_id = p_id)
    || '. Document fingerprint ' || left((select doc_hash from agreements where id = p_id), 16) || '…');
  return out;
end $$;

-- new link for one signer (old link stops working)
create or replace function public.agr_new_link(p_signer bigint) returns text
language plpgsql volatile security definer set search_path = public as $$
declare s agreement_signers; a agreements; tok text := pulse_token();
begin
  select * into s from agreement_signers where id = p_signer; a := agr_get(s.agreement_id);
  if a.status <> 'Out for signature' or s.status in ('Signed', 'Declined') then raise exception 'This signer can''t get a new link.'; end if;
  update agreement_signers set token_hash = pulse_sha256(tok), token_expires_at = now() + interval '30 days' where id = p_signer;
  perform agr_log(a.id, 'link', 'New signing link for ' || s.name);
  return tok;
end $$;

-- what happens when the last signer signs: Active, executed copy facts, onboarding checklist ticks
create or replace function public.agr_maybe_execute(p_id bigint) returns void
language plpgsql volatile security definer set search_path = public as $$
declare a agreements;
begin
  select * into a from agreements where id = p_id;
  if a.status <> 'Out for signature' or exists (select 1 from agreement_signers where agreement_id = p_id and status <> 'Signed') then return; end if;
  update agreements set status = 'Active', executed_at = now(), executed_via = 'Pulse e-sign', updated_at = now() where id = p_id;
  perform agr_log(p_id, 'executed', 'All parties signed. Agreement is in effect.', 'Pulse');
  if a.onboarding_id is not null then perform agr_tick_onboarding(p_id); end if;
end $$;

-- ---------------- public signing (no Pulse login needed; the link's token is the key)
create or replace function public.sign_lookup(p_token text) returns agreement_signers
language plpgsql stable security definer set search_path = public as $$
declare s agreement_signers;
begin
  select * into s from agreement_signers where token_hash = pulse_sha256(coalesce(p_token, ''));
  if not found then raise exception 'This signing link isn''t valid. Ask the sender for a new one.'; end if;
  if s.token_expires_at < now() and s.status not in ('Signed', 'Declined') then raise exception 'This signing link has expired. Ask the sender for a new one.'; end if;
  return s;
end $$;
create or replace function public.sign_view(p_token text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare s agreement_signers; a agreements; w workspaces;
begin
  s := sign_lookup(p_token);
  select * into a from agreements where id = s.agreement_id;
  select * into w from workspaces where id = a.workspace_id;
  if s.status = 'Waiting' and a.status = 'Out for signature' then
    update agreement_signers set status = 'Viewed', viewed_at = now(), ip = agr_request_ip() where id = s.id;
    perform agr_log(a.id, 'viewed', s.name || ' opened the signing link', s.name);
  end if;
  return jsonb_build_object('title', a.title, 'number', a.number, 'status', a.status, 'body_html', a.body_html, 'doc_hash', a.doc_hash, 'sent_at', a.sent_at,
    'executed_at', a.executed_at, 'company', w.name, 'logo_url', w.logo_url, 'fields', a.fields, 'template_key', a.template_key,
    'me', jsonb_build_object('id', s.id, 'role', s.role, 'label', s.label, 'name', s.name, 'title', s.title, 'email', s.email, 'status', s.status, 'signed_at', s.signed_at),
    'signers', (select jsonb_agg(jsonb_build_object('role', role, 'label', label, 'name', name, 'title', title, 'status', status, 'signed_at', signed_at,
        'signature_kind', case when status = 'Signed' then signature_kind end, 'signature_data', case when status = 'Signed' then signature_data end) order by sign_order, id)
      from agreement_signers where agreement_id = a.id));
end $$;
create or replace function public.sign_submit(p_token text, p_name text, p_title text, p_kind text, p_data text, p_consent boolean, p_user_agent text default null) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare s agreement_signers; a agreements;
begin
  s := sign_lookup(p_token);
  select * into a from agreements where id = s.agreement_id for update;
  if a.status <> 'Out for signature' then raise exception 'This agreement is no longer open for signature (%).', a.status; end if;
  if s.status in ('Signed', 'Declined') then raise exception 'You have already responded to this agreement.'; end if;
  if not coalesce(p_consent, false) then raise exception 'Please agree to sign electronically first.'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Type your full name.'; end if;
  if p_kind not in ('typed', 'drawn') then raise exception 'Choose to type or draw your signature.'; end if;
  if p_kind = 'drawn' and (coalesce(p_data, '') !~ '^data:image/png;base64,[A-Za-z0-9+/=]+$' or length(p_data) > 400000) then raise exception 'Draw your signature again.'; end if;
  if p_kind = 'typed' and coalesce(trim(p_data), '') = '' then raise exception 'Type your signature.'; end if;
  if pulse_sha256(a.body_html) <> a.doc_hash then raise exception 'The document changed after it was sent. Ask the sender to send it again.'; end if;
  update agreement_signers set status = 'Signed', name = trim(p_name), title = coalesce(nullif(trim(p_title), ''), title), signed_at = now(), consent_at = now(),
    signature_kind = p_kind, signature_data = case when p_kind = 'typed' then left(trim(p_data), 120) else p_data end,
    ip = coalesce(agr_request_ip(), ip), user_agent = left(p_user_agent, 300)
  where id = s.id;
  perform agr_log(a.id, 'signed', trim(p_name) || ' signed (' || p_kind || ' signature) and agreed to sign electronically', trim(p_name));
  perform agr_maybe_execute(a.id);
  return sign_view(p_token);
end $$;
create or replace function public.sign_decline(p_token text, p_reason text) returns void
language plpgsql volatile security definer set search_path = public as $$
declare s agreement_signers;
begin
  s := sign_lookup(p_token);
  if s.status in ('Signed', 'Declined') then raise exception 'You have already responded to this agreement.'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Tell the sender why, so they can fix it.'; end if;
  update agreement_signers set status = 'Declined', decline_reason = left(trim(p_reason), 1000) where id = s.id;
  update agreements set status = 'Declined', updated_at = now() where id = s.agreement_id and status = 'Out for signature';
  perform agr_log(s.agreement_id, 'declined', s.name || ' declined: ' || left(trim(p_reason), 300), s.name);
end $$;

-- ---------------- lifecycle actions (staff)
create or replace function public.agr_void(p_id bigint, p_reason text) returns void
language plpgsql volatile security definer set search_path = public as $$
declare a agreements;
begin
  a := agr_get(p_id);
  if a.status not in ('Draft', 'Out for signature', 'Declined') then raise exception 'Only unsigned agreements can be voided. End an active one instead.'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Add a reason.'; end if;
  update agreements set status = 'Voided', end_reason = trim(p_reason), ended_at = now(), updated_at = now() where id = p_id;
  update agreement_signers set token_hash = null where agreement_id = p_id;   -- links stop working
  perform agr_log(p_id, 'voided', trim(p_reason));
end $$;
-- signed somewhere else (wet ink, DocuSign, Adobe): attach the PDF and mark it executed
create or replace function public.agr_upload_signed(p_id bigint, p_name text, p_mime text, p_b64 text, p_executed date default null) returns void
language plpgsql volatile security definer set search_path = public as $$
declare a agreements;
begin
  a := agr_get(p_id);
  if a.status in ('Voided', 'Closed out') then raise exception 'This agreement is %.', lower(a.status); end if;
  if length(coalesce(p_b64, '')) > 14000000 then raise exception 'Files up to 10 MB, please.'; end if;
  insert into agreement_files (workspace_id, agreement_id, name, mime, size, sha256, data_b64, uploaded_by)
  values (a.workspace_id, p_id, left(coalesce(p_name, 'signed.pdf'), 200), p_mime, (length(p_b64) * 3 / 4), pulse_sha256(p_b64), p_b64, member_name());
  if a.status in ('Draft', 'Out for signature', 'Declined') then
    update agreements set status = 'Active', executed_at = coalesce(p_executed::timestamptz, now()), executed_via = 'Signed copy uploaded',
      doc_hash = coalesce(doc_hash, pulse_sha256(coalesce(body_html, ''))), updated_at = now() where id = p_id;
    update agreement_signers set token_hash = null where agreement_id = p_id and status <> 'Signed';
    perform agr_log(p_id, 'executed', 'Signed copy uploaded: ' || coalesce(p_name, 'file'));
    if a.onboarding_id is not null then perform agr_tick_onboarding(p_id); end if;
  else
    perform agr_log(p_id, 'file', 'Added file: ' || coalesce(p_name, 'file'));
  end if;
end $$;
create or replace function public.agr_tick_onboarding(p_id bigint) returns void
language plpgsql volatile security definer set search_path = public as $$
declare a agreements; items text[];
begin
  select * into a from agreements where id = p_id;
  items := case a.kind when 'confidentiality' then array['nda'] when 'consulting' then array['sign', 'agreement'] else array[]::text[] end;
  update onboardings set checklist = (select coalesce(jsonb_agg(case when i ->> 'id' = any (items) and not coalesce((i ->> 'done')::boolean, false)
      then i || jsonb_build_object('done', true, 'done_at', now(), 'done_by', 'Signed agreement') else i end), '[]') from jsonb_array_elements(checklist) i)
   where id = a.onboarding_id;
end $$;
-- company signer signs inside Pulse (no link needed)
create or replace function public.agr_sign_member(p_id bigint, p_name text, p_title text, p_kind text, p_data text, p_consent boolean, p_user_agent text default null) returns void
language plpgsql volatile security definer set search_path = public as $$
declare s agreement_signers; tok text := pulse_token();
begin
  select * into s from agreement_signers where agreement_id = p_id and user_id = auth.uid() and status not in ('Signed', 'Declined') order by sign_order limit 1;
  if not found then raise exception 'You aren''t waiting to sign this agreement.'; end if;
  update agreement_signers set token_hash = pulse_sha256(tok), token_expires_at = now() + interval '1 hour' where id = s.id;
  perform sign_submit(tok, p_name, p_title, p_kind, p_data, p_consent, p_user_agent);
end $$;
-- end an active agreement: it reached its end date, or one side terminated it
create or replace function public.agr_end(p_id bigint, p_status text, p_reason text, p_date date default current_date) returns void
language plpgsql volatile security definer set search_path = public as $$
declare a agreements;
begin
  a := agr_get(p_id);
  if a.status <> 'Active' then raise exception 'Only active agreements can be ended.'; end if;
  if p_status not in ('Expired', 'Terminated') then raise exception 'Choose Expired or Terminated.'; end if;
  if p_status = 'Terminated' and coalesce(trim(p_reason), '') = '' then raise exception 'Add the reason for termination.'; end if;
  update agreements set status = p_status, ended_at = coalesce(p_date::timestamptz, now()), end_reason = nullif(trim(p_reason), ''),
    closeout = case when jsonb_array_length(closeout) = 0 then '[
      {"id":"deliverables","text":"Final deliverables received and accepted","done":false},
      {"id":"invoice","text":"Final invoice received and paid (or credit issued)","done":false},
      {"id":"timesheets","text":"All timesheets approved","done":false},
      {"id":"property","text":"Equipment, access and confidential materials returned","done":false},
      {"id":"ip","text":"IP assignments and records collected","done":false},
      {"id":"evaluation","text":"Performance evaluation recorded","done":false},
      {"id":"archive","text":"Agreement, amendments and correspondence archived","done":false}]'::jsonb else closeout end,
    updated_at = now() where id = p_id;
  perform agr_log(p_id, lower(p_status), coalesce(nullif(trim(p_reason), ''), p_status));
end $$;
create or replace function public.agr_closeout(p_id bigint, p_items jsonb, p_note text, p_close boolean) returns void
language plpgsql volatile security definer set search_path = public as $$
declare a agreements;
begin
  a := agr_get(p_id);
  if a.status not in ('Expired', 'Terminated', 'Active') then raise exception 'Close-out applies to active, expired or terminated agreements.'; end if;
  if jsonb_typeof(p_items) <> 'array' then raise exception 'Bad checklist.'; end if;
  if p_close then
    if a.status = 'Active' then raise exception 'End the agreement (expired or terminated) before closing it out.'; end if;
    if exists (select 1 from jsonb_array_elements(p_items) i where not coalesce((i ->> 'done')::boolean, false) and not coalesce((i ->> 'na')::boolean, false)) then
      raise exception 'Tick or mark N/A every close-out item first.';
    end if;
  end if;
  update agreements set closeout = p_items, closeout_note = nullif(trim(p_note), ''),
    status = case when p_close then 'Closed out' else status end, closed_at = case when p_close then now() else closed_at end, updated_at = now() where id = p_id;
  perform agr_log(p_id, case when p_close then 'closed' else 'closeout' end, case when p_close then 'Closed out' || coalesce(': ' || nullif(trim(p_note), ''), '') else 'Close-out checklist updated' end);
end $$;
-- reopen a draft from a declined/voided agreement: copies it as a new draft
create or replace function public.agr_copy(p_id bigint) returns bigint
language plpgsql volatile security definer set search_path = public as $$
declare a agreements; v_id bigint;
begin
  a := agr_get(p_id);
  v_id := agr_save(jsonb_build_object('template_key', a.template_key, 'template_name', a.template_name, 'kind', a.kind, 'title', a.title,
    'party_name', a.party_name, 'party_email', a.party_email, 'fields', a.fields, 'body_html', a.body_html, 'onboarding_id', a.onboarding_id,
    'contact_id', a.contact_id, 'project_id', a.project_id, 'opportunity_id', a.opportunity_id, 'parent_id', a.parent_id, 'value', a.value,
    'currency', a.currency, 'start_date', a.start_date, 'end_date', a.end_date));
  perform agr_log(v_id, 'created', 'Copied from AGR-' || lpad(a.number::text, 4, '0'));
  return v_id;
end $$;

revoke execute on function public.agr_save(jsonb), public.agr_send(bigint, jsonb, int), public.agr_new_link(bigint), public.agr_void(bigint, text),
  public.agr_upload_signed(bigint, text, text, text, date), public.agr_sign_member(bigint, text, text, text, text, boolean, text),
  public.agr_end(bigint, text, text, date), public.agr_closeout(bigint, jsonb, text, boolean), public.agr_copy(bigint),
  public.agr_get(bigint), public.agr_log(bigint, text, text, text), public.agr_maybe_execute(bigint), public.agr_tick_onboarding(bigint),
  public.sign_lookup(text), public.agr_is_signer(bigint) from anon, public;
grant execute on function public.agr_save(jsonb), public.agr_send(bigint, jsonb, int), public.agr_new_link(bigint), public.agr_void(bigint, text),
  public.agr_upload_signed(bigint, text, text, text, date), public.agr_sign_member(bigint, text, text, text, text, boolean, text),
  public.agr_end(bigint, text, text, date), public.agr_closeout(bigint, jsonb, text, boolean), public.agr_copy(bigint), public.agr_is_signer(bigint) to authenticated;
-- the three signing calls are the ONLY things a visitor without a Pulse login can run
revoke execute on function public.sign_view(text), public.sign_submit(text, text, text, text, text, boolean, text), public.sign_decline(text, text) from public;
grant execute on function public.sign_view(text), public.sign_submit(text, text, text, text, text, boolean, text), public.sign_decline(text, text) to anon, authenticated;

-- =====================================================================
-- Projects (execution): the Timecards projects table grows into full projects with a manager, dates, budget,
-- milestones, a task board, costs, risks/issues and status reports. Labor actuals come from Timecards.
--   * Staff see every project; project managers (and admins) edit their projects.
--   * Contractors see only projects they're assigned to: milestones and tasks, and they can move their own tasks.
--     Budgets, costs, risks and status reports stay staff-only.
-- =====================================================================
alter table public.projects add column if not exists description text;
alter table public.projects add column if not exists manager_id uuid references public.profiles (id) on delete set null;
alter table public.projects add column if not exists start_date date;
alter table public.projects add column if not exists end_date date;
alter table public.projects add column if not exists budget_amount numeric;
alter table public.projects add column if not exists contract_value numeric;
alter table public.projects add column if not exists health text default 'On track';
alter table public.projects add column if not exists closed_at timestamptz;
alter table public.projects add column if not exists close_note text;
alter table public.projects drop constraint if exists projects_status_check;
alter table public.projects add constraint projects_status_check check (status in ('Planned', 'Active', 'Paused', 'Complete', 'Closed'));
alter table public.projects drop constraint if exists projects_health_check;
alter table public.projects add constraint projects_health_check check (health in ('On track', 'At risk', 'Off track'));
drop policy if exists pm_insert on public.projects;
create policy pm_insert on public.projects for insert to authenticated with check (workspace_id = staff_ws());
drop policy if exists pm_update on public.projects;
create policy pm_update on public.projects for update to authenticated using (workspace_id = staff_ws() and (is_admin() or manager_id = auth.uid()))
  with check (workspace_id = staff_ws());

create or replace function public.can_manage_project(p_project bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from projects where id = p_project and workspace_id = staff_ws() and (is_admin() or manager_id = auth.uid() or manager_id is null)) $$;
create or replace function public.can_see_project(p_project bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from projects where id = p_project and workspace_id = ws() and (staff_ws() is not null or on_project(p_project))) $$;

create table if not exists public.project_milestones (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  project_id bigint not null references public.projects (id) on delete cascade,
  name text not null, start_date date, due_date date, done_at date, deliverable boolean not null default false,
  notes text, sort int not null default 0, created_at timestamptz default now()
);
create table if not exists public.project_tasks (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  project_id bigint not null references public.projects (id) on delete cascade,
  milestone_id bigint references public.project_milestones (id) on delete set null,
  title text not null, description text,
  status text not null default 'To do' check (status in ('To do', 'Doing', 'Blocked', 'Done')),
  priority text not null default 'Normal' check (priority in ('Low', 'Normal', 'High', 'Urgent')),
  assignee_id uuid references public.profiles (id) on delete set null,
  due_date date, estimate_hours numeric, sort double precision not null default 0,
  done_at timestamptz, created_by uuid default auth.uid(), created_at timestamptz default now(), updated_at timestamptz default now()
);
create table if not exists public.project_costs (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  project_id bigint not null references public.projects (id) on delete cascade,
  cost_date date not null default current_date, category text not null default 'Other', vendor text, description text,
  amount numeric not null, agreement_id bigint references public.agreements (id) on delete set null,
  created_by uuid default auth.uid(), created_at timestamptz default now()
);
create table if not exists public.project_risks (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  project_id bigint not null references public.projects (id) on delete cascade,
  kind text not null default 'Risk' check (kind in ('Risk', 'Issue', 'Decision', 'Change')),
  title text not null, detail text, impact text default 'Medium' check (impact in ('Low', 'Medium', 'High')),
  owner_id uuid references public.profiles (id) on delete set null, due_date date,
  status text not null default 'Open' check (status in ('Open', 'Closed')), resolution text,
  created_by uuid default auth.uid(), created_at timestamptz default now()
);
create table if not exists public.project_updates (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  project_id bigint not null references public.projects (id) on delete cascade,
  period_end date not null default current_date, health text not null default 'On track' check (health in ('On track', 'At risk', 'Off track')),
  summary text, done text, next text, blockers text,
  created_by uuid default auth.uid(), author text default public.member_name(), created_at timestamptz default now()
);
create index if not exists ix_ms_project on public.project_milestones (project_id, due_date);
create index if not exists ix_tasks_project on public.project_tasks (project_id, status, sort);
create index if not exists ix_tasks_assignee on public.project_tasks (assignee_id, status);
create index if not exists ix_costs_project on public.project_costs (project_id, cost_date);
create index if not exists ix_risks_project on public.project_risks (project_id, status);
create index if not exists ix_updates_project on public.project_updates (project_id, period_end desc);

create or replace function public.task_stamp() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if new.status = 'Done' and (tg_op = 'INSERT' or old.status <> 'Done') then new.done_at := now(); end if;
  if new.status <> 'Done' then new.done_at := null; end if;
  if new.assignee_id is not null and not exists (select 1 from profiles where id = new.assignee_id and workspace_id = new.workspace_id) then
    raise exception 'Assign tasks to someone on your own team.';
  end if;
  return new;
end $$;
drop trigger if exists stamp on public.project_tasks;
create trigger stamp before insert or update on public.project_tasks for each row execute function public.task_stamp();

alter table public.project_milestones enable row level security;
alter table public.project_tasks enable row level security;
alter table public.project_costs enable row level security;
alter table public.project_risks enable row level security;
alter table public.project_updates enable row level security;
drop policy if exists ms_read on public.project_milestones;
create policy ms_read on public.project_milestones for select to authenticated using (workspace_id = ws() and can_see_project(project_id));
drop policy if exists ms_write on public.project_milestones;
create policy ms_write on public.project_milestones for all to authenticated using (workspace_id = staff_ws() and can_manage_project(project_id))
  with check (workspace_id = staff_ws() and can_manage_project(project_id));
drop policy if exists task_read on public.project_tasks;
create policy task_read on public.project_tasks for select to authenticated using (workspace_id = ws() and can_see_project(project_id));
drop policy if exists task_staff on public.project_tasks;
create policy task_staff on public.project_tasks for all to authenticated using (workspace_id = staff_ws() and can_see_project(project_id))
  with check (workspace_id = staff_ws() and can_see_project(project_id));
drop policy if exists task_mine on public.project_tasks;
create policy task_mine on public.project_tasks for update to authenticated using (workspace_id = ws() and assignee_id = auth.uid())
  with check (workspace_id = ws() and assignee_id = auth.uid());
do $$ declare t text; begin
  foreach t in array array['project_costs', 'project_risks', 'project_updates'] loop
    execute format('drop policy if exists staff_read on public.%I', t);
    execute format('create policy staff_read on public.%I for select to authenticated using (workspace_id = staff_ws())', t);
    execute format('drop policy if exists pm_write on public.%I', t);
    execute format('create policy pm_write on public.%I for all to authenticated using (workspace_id = staff_ws() and can_see_project(project_id)) with check (workspace_id = staff_ws() and can_see_project(project_id))', t);
  end loop;
end $$;
revoke all on public.project_milestones, public.project_tasks, public.project_costs, public.project_risks, public.project_updates from anon;
grant select, insert, update, delete on public.project_milestones, public.project_tasks, public.project_costs, public.project_risks, public.project_updates to authenticated;

-- one row per project the caller can see: progress, money, schedule and the latest status (row-level security applies)
create or replace function public.project_rollup(p_id bigint default null) returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(x order by x.status_rank, x.name), '[]') from (
    select p.id, p.name, p.client, p.code, p.status, p.health, p.manager_id, p.start_date, p.end_date, p.budget_amount, p.contract_value, p.budget_hours,
      case p.status when 'Active' then 1 when 'Planned' then 2 when 'Paused' then 3 when 'Complete' then 4 else 5 end status_rank,
      (select count(*) from project_tasks t where t.project_id = p.id) tasks,
      (select count(*) from project_tasks t where t.project_id = p.id and t.status = 'Done') tasks_done,
      (select count(*) from project_tasks t where t.project_id = p.id and t.status <> 'Done' and t.due_date < current_date) tasks_late,
      (select count(*) from project_milestones m where m.project_id = p.id) milestones,
      (select count(*) from project_milestones m where m.project_id = p.id and m.done_at is not null) milestones_done,
      (select jsonb_build_object('name', m.name, 'due', m.due_date) from project_milestones m where m.project_id = p.id and m.done_at is null order by m.due_date nulls last limit 1) next_milestone,
      (select coalesce(sum(e.hours), 0) from time_entries e where e.project_id = p.id) hours,
      (select coalesce(sum(e.hours * coalesce(pp.rate, p.rate, 0)), 0) from time_entries e left join project_people pp on pp.project_id = p.id and pp.user_id = e.user_id where e.project_id = p.id) labor,
      case when staff_ws() is not null then (select coalesce(sum(c.amount), 0) from project_costs c where c.project_id = p.id) end costs,
      case when staff_ws() is not null then (select count(*) from project_risks r where r.project_id = p.id and r.status = 'Open') end open_risks,
      case when staff_ws() is not null then (select jsonb_build_object('date', u.period_end, 'health', u.health, 'summary', u.summary) from project_updates u where u.project_id = p.id order by u.period_end desc, u.id desc limit 1) end last_update
    from projects p where (p_id is null or p.id = p_id)) x $$;
grant execute on function public.project_rollup(bigint) to authenticated;
revoke execute on function public.project_rollup(bigint), public.can_manage_project(bigint), public.can_see_project(bigint) from anon, public;
grant execute on function public.can_manage_project(bigint), public.can_see_project(bigint) to authenticated;

-- my open tasks for the assistant and the landing page
create or replace function public.my_tasks() returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status, 'priority', t.priority, 'due', t.due_date, 'project', p.name) order by t.due_date nulls last), '[]')
    from project_tasks t join projects p on p.id = t.project_id where t.assignee_id = auth.uid() and t.status <> 'Done' $$;
grant execute on function public.my_tasks() to authenticated;
