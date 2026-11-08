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

-- ---------------------------------------------------------------- plans and billing
-- Starter ($3), Pro ($6), Enterprise ($10) per staff user per month; contractors are free.
--   plan          = the plan the company pays for (or was given: comped)
--   paid_until    = end of the paid period (Stripe sets it; an operator sets it for invoiced companies)
--   trial_ends_at = new workspaces get 14 days of Pro
-- The effective plan decides which apps work (ws_has_app); it is checked in the database, not only on screen.
alter table public.workspaces add column if not exists trial_ends_at timestamptz;
alter table public.workspaces add column if not exists paid_until timestamptz;
alter table public.workspaces add column if not exists comped boolean not null default false;
alter table public.workspaces add column if not exists billing_cycle text not null default 'month';
alter table public.workspaces add column if not exists billing_email text;
alter table public.workspaces add column if not exists stripe_customer_id text;
alter table public.workspaces add column if not exists stripe_subscription_id text;
alter table public.workspaces add column if not exists plan_note text;
update public.workspaces set plan = 'starter' where plan not in ('starter', 'pro', 'enterprise');
alter table public.workspaces alter column plan set default 'starter';
alter table public.workspaces alter column trial_ends_at set default (now() + interval '14 days');
alter table public.workspaces drop constraint if exists workspaces_plan_check;
alter table public.workspaces add constraint workspaces_plan_check check (plan in ('starter', 'pro', 'enterprise'));
alter table public.workspaces drop constraint if exists workspaces_cycle_check;
alter table public.workspaces add constraint workspaces_cycle_check check (billing_cycle in ('month', 'year'));

-- Pulse operators (BlueCredit staff who run the service) can set any company's plan
create table if not exists public.pulse_operators (email text primary key);
alter table public.pulse_operators enable row level security;
revoke all on public.pulse_operators from anon, authenticated;
insert into public.pulse_operators (email) values ('barasa@bluecredits.org') on conflict do nothing;
-- existing companies: 14 days of Pro from today; the operators' own company (BlueCredit) is on Enterprise, comped
update public.workspaces set trial_ends_at = now() + interval '14 days' where trial_ends_at is null;
update public.workspaces set plan = 'enterprise', comped = true, plan_note = coalesce(plan_note, 'Operator company (comped)')
 where not comped and id in (select p.workspace_id from public.profiles p join public.pulse_operators o on lower(o.email) = lower(p.email));
create or replace function public.is_operator() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from pulse_operators o join profiles p on lower(p.email) = lower(o.email) where p.id = auth.uid() and p.active) $$;

create or replace function public.plan_rank(p text) returns int language sql immutable as $$
  select case p when 'enterprise' then 3 when 'pro' then 2 else 1 end $$;
-- which plan each app needs (anything not listed is in Starter)
create or replace function public.app_plan(p_app text) returns text language sql immutable as $$
  select case when p_app in ('opportunities', 'projects', 'agreements', 'hiring', 'invoices') then 'pro'
              when p_app in ('chief', 'scheduler') then 'enterprise' else 'starter' end $$;
create or replace function public.ws_plan_for(p_ws uuid) returns text
language sql stable security definer set search_path = public as $$
  select case when w.comped then w.plan
              when plan_rank(case when w.paid_until > now() then w.plan else 'starter' end) >= plan_rank(case when w.trial_ends_at > now() then 'pro' else 'starter' end)
                then case when w.paid_until > now() then w.plan else 'starter' end
              else 'pro' end
    from workspaces w where w.id = p_ws $$;
create or replace function public.ws_has_app_for(p_ws uuid, p_app text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(plan_rank(ws_plan_for(p_ws)) >= plan_rank(app_plan(p_app)), false) $$;
create or replace function public.ws_has_app(p_app text) returns boolean
language sql stable security definer set search_path = public as $$
  select ws_has_app_for(ws(), p_app) $$;
create or replace function public.plan_require(p_app text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not ws_has_app(p_app) then
    raise exception 'This app is part of the % plan. An admin can upgrade in Admin → Billing.', initcap(app_plan(p_app));
  end if;
end $$;

-- what the Billing page and the app locks show
create or replace function public.billing_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'plan', w.plan, 'effective', ws_plan_for(w.id), 'comped', w.comped, 'paid_until', w.paid_until,
    'trial_ends_at', w.trial_ends_at, 'trial_days_left', greatest(0, ceil(extract(epoch from (w.trial_ends_at - now())) / 86400))::int,
    'cycle', w.billing_cycle, 'billing_email', w.billing_email, 'has_stripe', w.stripe_customer_id is not null, 'note', w.plan_note,
    'seats', (select count(*) from profiles p where p.workspace_id = w.id and p.active and p.role in ('admin', 'member')),
    'contractors', (select count(*) from profiles p where p.workspace_id = w.id and p.active and p.role = 'contractor'),
    'operator', is_operator())
    from workspaces w where w.id = ws() $$;

-- operators: set a company's plan (invoiced, comped, or a trial extension)
create or replace function public.billing_set_plan(p_ws uuid, p_plan text, p_paid_until timestamptz default null,
    p_comped boolean default false, p_trial_ends timestamptz default null, p_note text default null) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if not is_operator() then raise exception 'Only Pulse operators can change a plan directly.'; end if;
  if p_plan not in ('starter', 'pro', 'enterprise') then raise exception 'Unknown plan %', p_plan; end if;
  update workspaces set plan = p_plan, paid_until = p_paid_until, comped = coalesce(p_comped, false),
      trial_ends_at = coalesce(p_trial_ends, trial_ends_at), plan_note = coalesce(p_note, plan_note) where id = p_ws;
  if not found then raise exception 'Workspace not found.'; end if;
end $$;
-- operators: every company and its plan
create or replace function public.billing_workspaces() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when is_operator() then coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'plan', w.plan, 'effective', ws_plan_for(w.id),
    'comped', w.comped, 'paid_until', w.paid_until, 'trial_ends_at', w.trial_ends_at, 'note', w.plan_note, 'created_at', w.created_at,
    'seats', (select count(*) from profiles p where p.workspace_id = w.id and p.active and p.role in ('admin', 'member'))) order by w.created_at), '[]') end
    from workspaces w $$;
-- admins: billing email and cycle (the plan itself changes through payment or an operator)
create or replace function public.billing_contact(p_email text, p_cycle text) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Only admins can change billing details.'; end if;
  if p_email is not null and p_email !~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' then raise exception 'Please enter a valid billing email.'; end if;
  update workspaces set billing_email = nullif(trim(p_email), ''), billing_cycle = case when p_cycle in ('month', 'year') then p_cycle else billing_cycle end where id = ws();
end $$;
revoke execute on function public.billing_set_plan(uuid, text, timestamptz, boolean, timestamptz, text), public.billing_workspaces(),
  public.billing_contact(text, text), public.billing_status(), public.plan_require(text), public.ws_has_app(text),
  public.ws_has_app_for(uuid, text), public.ws_plan_for(uuid), public.is_operator() from public, anon;
grant execute on function public.billing_set_plan(uuid, text, timestamptz, boolean, timestamptz, text), public.billing_workspaces(),
  public.billing_contact(text, text), public.billing_status(), public.plan_require(text), public.ws_has_app(text), public.is_operator() to authenticated;
grant execute on function public.ws_has_app_for(uuid, text), public.ws_plan_for(uuid) to anon, authenticated;


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

  -- new leads from Opportunities (SAM.gov, Grants.gov, MyBidMatch) found in this period and not yet reviewed
  if to_regclass('public.fed_notices') is not null then
    snap := snap || jsonb_build_object('leads', coalesce((select jsonb_object_agg(src, obj) from (
      select n.source src, jsonb_build_object(
          'new', count(*) filter (where n.status = 'New'), 'saved', count(*) filter (where n.status = 'Saved'),
          'due_soon', count(*) filter (where n.response_deadline::date between t and until),
          'items', coalesce(jsonb_agg(jsonb_build_object('id', n.notice_id, 'title', n.title, 'agency', coalesce(n.subtier, n.agency), 'due', n.response_deadline,
                      'status', n.status, 'level', n.level, 'naics', n.naics, 'url', n.ui_link)
                    order by n.response_deadline nulls last, n.posted_date desc) filter (where n.rk <= 12), '[]')) obj
        from (select f.*, row_number() over (partition by f.source order by f.response_deadline nulls last, f.posted_date desc) rk
                from fed_notices f
               where f.status in ('New', 'Saved') and f.first_seen::date >= since and f.first_seen::date <= t
                 and (f.response_deadline is null or f.response_deadline >= t)
                 and (f.source = 'BidMatch' or f.status = 'Saved' or exists (select 1 from fed_matches m where m.workspace_id = f.workspace_id and m.notice_id = f.notice_id))) n
       group by n.source) z), '{}'));
  end if;

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
-- Hiring (People app): openings, candidates, interviews and scorecards
--   * Openings: every staff member can read them (they're job descriptions); admins and the
--     hiring manager change them. Each opening has a public apply link (apply_token).
--   * Candidates, resumes, interviews: admins, the opening's hiring manager, the candidate's owner
--     and the interviewers assigned to that candidate only (hire_can). Contractors never.
--   * Scorecards are blind: an interviewer sees other scores for a candidate only after submitting
--     their own (admins and the hiring manager always see them).
--   * Applicants use the public link without signing in: hire_opening_public / hire_apply only.
-- =====================================================================
create table if not exists public.hire_openings (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  title text not null,
  kind text not null default 'Employee' check (kind in ('Employee', 'Contractor', 'Consultant', 'Intern')),
  location text, remote text not null default 'Remote' check (remote in ('Remote', 'Hybrid', 'On-site')),
  hiring_manager uuid references public.profiles (id) on delete set null,
  status text not null default 'Draft' check (status in ('Draft', 'Open', 'On hold', 'Filled', 'Closed')),
  description text, must_haves text, pay text,
  criteria jsonb not null default '["Technical skill", "Problem solving", "Communication", "Ownership", "Fit with our mission"]',
  work_sample boolean not null default true,
  apply_token text not null default public.pulse_token(),
  created_at timestamptz default now(), updated_at timestamptz default now(), updated_by text
);
create unique index if not exists ux_hire_open_token on public.hire_openings (apply_token);
-- any engagement, from contractor to full-time employee
alter table public.hire_openings add column if not exists schedule text not null default 'Full-time';
alter table public.hire_openings drop constraint if exists hire_openings_kind_check;
alter table public.hire_openings add constraint hire_openings_kind_check check (kind in ('Employee', 'Contractor', 'Consultant', 'Intern', 'Advisor'));
alter table public.hire_openings drop constraint if exists hire_openings_schedule_check;
alter table public.hire_openings add constraint hire_openings_schedule_check check (schedule in ('Full-time', 'Part-time', 'As needed'));
create index if not exists ix_hire_open_ws on public.hire_openings (workspace_id, status);

create table if not exists public.hire_candidates (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  opening_id bigint not null references public.hire_openings (id) on delete cascade,
  name text not null, email text, phone text, location text,
  links jsonb not null default '{}',          -- {linkedin, github, portfolio}
  source text not null default 'Added by hand' check (source in ('Apply link', 'Referral', 'LinkedIn', 'Indeed', 'University', 'Added by hand', 'Other')),
  stage text not null default 'Applied' check (stage in ('Applied', 'Screen', 'Interview', 'Work sample', 'Final', 'Offer', 'Hired', 'Rejected', 'Withdrew')),
  stage_at timestamptz not null default now(),
  owner_id uuid references public.profiles (id) on delete set null,
  next_step text, next_date date,
  reject_reason text, cover_letter text, answers jsonb not null default '{}',
  notes text, onboarding_id bigint references public.onboardings (id) on delete set null,
  created_at timestamptz default now(), updated_at timestamptz default now(), updated_by text
);
create index if not exists ix_hire_cand_open on public.hire_candidates (opening_id, stage);
create unique index if not exists ux_hire_cand_email on public.hire_candidates (opening_id, lower(email)) where email is not null;

create table if not exists public.hire_files (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  candidate_id bigint not null references public.hire_candidates (id) on delete cascade,
  name text not null, mime text, size int, data_b64 text not null,
  uploaded_by text, created_at timestamptz not null default now()
);
create index if not exists ix_hire_files_cand on public.hire_files (candidate_id);

create table if not exists public.hire_interviews (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  candidate_id bigint not null references public.hire_candidates (id) on delete cascade,
  kind text not null default 'Interview' check (kind in ('Screen', 'Interview', 'Work sample review', 'Final', 'Reference check')),
  scheduled_at timestamptz, duration_min int not null default 45, place text,
  interviewer_ids uuid[] not null default '{}',
  status text not null default 'Scheduled' check (status in ('Scheduled', 'Done', 'Cancelled')),
  notes text,
  created_at timestamptz default now(), updated_at timestamptz default now(), updated_by text
);
create index if not exists ix_hire_int_cand on public.hire_interviews (candidate_id);
create index if not exists ix_hire_int_when on public.hire_interviews (workspace_id, scheduled_at);

create table if not exists public.hire_scores (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  interview_id bigint not null references public.hire_interviews (id) on delete cascade,
  candidate_id bigint not null references public.hire_candidates (id) on delete cascade,
  interviewer_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  ratings jsonb not null default '{}',           -- {criterion: 1..5}
  recommendation text check (recommendation in ('Strong yes', 'Yes', 'No', 'Strong no')),
  notes text, submitted_at timestamptz,
  created_at timestamptz default now(), updated_at timestamptz default now(), updated_by text,
  unique (interview_id, interviewer_id)
);

create table if not exists public.hire_events (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  candidate_id bigint not null references public.hire_candidates (id) on delete cascade,
  ts timestamptz not null default now(), who text, text text not null
);
create index if not exists ix_hire_ev_cand on public.hire_events (candidate_id, ts);

do $$ declare t text; begin
  foreach t in array array['hire_openings', 'hire_candidates', 'hire_interviews', 'hire_scores'] loop
    execute format('drop trigger if exists stamp on public.%I', t);
    execute format('create trigger stamp before insert or update on public.%I for each row execute function public.stamp_row()', t);
  end loop;
end $$;

-- who may see a candidate: admin, the opening's hiring manager, the candidate's owner, or an assigned interviewer
create or replace function public.hire_lead(p_candidate bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from hire_candidates c join hire_openings o on o.id = c.opening_id
                  where c.id = p_candidate and c.workspace_id = staff_ws()
                    and (is_admin() or o.hiring_manager = auth.uid() or c.owner_id = auth.uid())) $$;
create or replace function public.hire_can(p_candidate bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select hire_lead(p_candidate) or exists (select 1 from hire_interviews i join hire_candidates c on c.id = i.candidate_id
                  where i.candidate_id = p_candidate and c.workspace_id = staff_ws() and auth.uid() = any (i.interviewer_ids)) $$;

alter table public.hire_openings enable row level security;
alter table public.hire_candidates enable row level security;
alter table public.hire_files enable row level security;
alter table public.hire_interviews enable row level security;
alter table public.hire_scores enable row level security;
alter table public.hire_events enable row level security;

drop policy if exists ho_read on public.hire_openings;
create policy ho_read on public.hire_openings for select to authenticated using (workspace_id = staff_ws());
drop policy if exists ho_ins on public.hire_openings;
create policy ho_ins on public.hire_openings for insert to authenticated with check (workspace_id = staff_ws() and is_admin());
drop policy if exists ho_upd on public.hire_openings;
create policy ho_upd on public.hire_openings for update to authenticated
  using (workspace_id = staff_ws() and (is_admin() or hiring_manager = auth.uid())) with check (workspace_id = staff_ws());
drop policy if exists ho_del on public.hire_openings;
create policy ho_del on public.hire_openings for delete to authenticated using (workspace_id = staff_ws() and is_admin());

drop policy if exists hc_read on public.hire_candidates;
create policy hc_read on public.hire_candidates for select to authenticated using (hire_can(id));
drop policy if exists hc_ins on public.hire_candidates;
create policy hc_ins on public.hire_candidates for insert to authenticated with check (workspace_id = staff_ws()
  and exists (select 1 from hire_openings o where o.id = opening_id and o.workspace_id = staff_ws() and (is_admin() or o.hiring_manager = auth.uid())));
drop policy if exists hc_upd on public.hire_candidates;
create policy hc_upd on public.hire_candidates for update to authenticated using (hire_lead(id)) with check (workspace_id = staff_ws());
drop policy if exists hc_del on public.hire_candidates;
create policy hc_del on public.hire_candidates for delete to authenticated using (workspace_id = staff_ws() and is_admin());

drop policy if exists hf_read on public.hire_files;
create policy hf_read on public.hire_files for select to authenticated using (hire_can(candidate_id));
drop policy if exists hf_del on public.hire_files;
create policy hf_del on public.hire_files for delete to authenticated using (hire_lead(candidate_id));

drop policy if exists hi_read on public.hire_interviews;
create policy hi_read on public.hire_interviews for select to authenticated using (hire_can(candidate_id));
drop policy if exists hi_ins on public.hire_interviews;
create policy hi_ins on public.hire_interviews for insert to authenticated with check (workspace_id = staff_ws() and hire_lead(candidate_id));
drop policy if exists hi_upd on public.hire_interviews;
create policy hi_upd on public.hire_interviews for update to authenticated using (hire_lead(candidate_id)) with check (workspace_id = staff_ws());
drop policy if exists hi_del on public.hire_interviews;
create policy hi_del on public.hire_interviews for delete to authenticated using (hire_lead(candidate_id));

-- blind scorecards: have I submitted mine for this candidate?
create or replace function public.hire_scored(p_candidate bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from hire_scores where candidate_id = p_candidate and interviewer_id = auth.uid() and submitted_at is not null) $$;
drop policy if exists hs_read on public.hire_scores;
create policy hs_read on public.hire_scores for select to authenticated using (
  hire_can(candidate_id) and (interviewer_id = auth.uid() or exists (select 1 from hire_candidates c join hire_openings o on o.id = c.opening_id
      where c.id = candidate_id and (is_admin() or o.hiring_manager = auth.uid()))
    or (submitted_at is not null and hire_scored(candidate_id))));
drop policy if exists hs_ins on public.hire_scores;
create policy hs_ins on public.hire_scores for insert to authenticated with check (interviewer_id = auth.uid() and workspace_id = staff_ws()
  and exists (select 1 from hire_interviews i where i.id = interview_id and i.candidate_id = hire_scores.candidate_id and auth.uid() = any (i.interviewer_ids)));
drop policy if exists hs_upd on public.hire_scores;
create policy hs_upd on public.hire_scores for update to authenticated using (interviewer_id = auth.uid()) with check (interviewer_id = auth.uid());

drop policy if exists he_read on public.hire_events;
create policy he_read on public.hire_events for select to authenticated using (hire_can(candidate_id));

revoke all on public.hire_openings, public.hire_candidates, public.hire_files, public.hire_interviews, public.hire_scores, public.hire_events from anon;
grant select, insert, update, delete on public.hire_openings, public.hire_candidates, public.hire_interviews, public.hire_scores to authenticated;
grant select, delete on public.hire_files to authenticated;
grant select on public.hire_events to authenticated;

-- stage changes and other history, written by the database
create or replace function public.hire_log() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into hire_events (workspace_id, candidate_id, who, text) values (new.workspace_id, new.id, coalesce(new.updated_by, 'Apply link'),
      case when new.source = 'Apply link' then 'Applied through the apply link' else 'Added (' || new.source || ')' end);
  elsif new.stage is distinct from old.stage then
    new.stage_at := now();
    insert into hire_events (workspace_id, candidate_id, who, text) values (new.workspace_id, new.id, member_name(),
      'Moved to ' || new.stage || coalesce(' (' || nullif(new.reject_reason, '') || ')', ''));
  end if;
  return new;
end $$;
drop trigger if exists hlog_ins on public.hire_candidates;
create trigger hlog_ins after insert on public.hire_candidates for each row execute function public.hire_log();
drop trigger if exists hlog_upd on public.hire_candidates;
create trigger hlog_upd before update on public.hire_candidates for each row execute function public.hire_log();

-- resume / file upload by the team
create or replace function public.hire_upload(p_candidate bigint, p_name text, p_mime text, p_b64 text) returns bigint
language plpgsql volatile security definer set search_path = public as $$
declare fid bigint; w uuid;
begin
  perform plan_require('hiring');
  if not hire_lead(p_candidate) then raise exception 'Only the hiring manager, the owner or an admin can add files.'; end if;
  if length(p_b64) > 10000000 then raise exception 'That file is too big (7 MB at most).'; end if;
  select workspace_id into w from hire_candidates where id = p_candidate;
  insert into hire_files (workspace_id, candidate_id, name, mime, size, data_b64, uploaded_by)
  values (w, p_candidate, left(p_name, 200), left(p_mime, 100), (length(p_b64) * 3 / 4)::int, p_b64, member_name()) returning id into fid;
  insert into hire_events (workspace_id, candidate_id, who, text) values (w, p_candidate, member_name(), 'Added file ' || left(p_name, 200));
  return fid;
end $$;

-- the public apply page: what the opening says (no sign-in)
create or replace function public.hire_opening_public(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('title', o.title, 'kind', o.kind, 'schedule', o.schedule, 'location', o.location, 'remote', o.remote, 'description', o.description,
           'must_haves', o.must_haves, 'pay', o.pay, 'company', w.name, 'open', o.status = 'Open' and ws_has_app_for(o.workspace_id, 'hiring'))
    from hire_openings o join workspaces w on w.id = o.workspace_id
   where o.apply_token = p_token and length(coalesce(p_token, '')) >= 32 and o.status in ('Open', 'On hold', 'Filled', 'Closed') $$;

-- the public apply page: send an application (no sign-in)
create or replace function public.hire_apply(p_token text, p_name text, p_email text, p_phone text, p_location text, p_links jsonb,
    p_cover text, p_file_name text, p_file_mime text, p_file_b64 text) returns text
language plpgsql volatile security definer set search_path = public as $$
declare o hire_openings; cid bigint;
begin
  select * into o from hire_openings where apply_token = p_token and length(coalesce(p_token, '')) >= 32;
  if not found or o.status <> 'Open' or not ws_has_app_for(o.workspace_id, 'hiring') then raise exception 'This position is not taking applications right now.'; end if;
  if coalesce(trim(p_name), '') = '' or coalesce(p_email, '') !~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' then raise exception 'Please enter your name and a valid email address.'; end if;
  if coalesce(p_file_b64, '') = '' then raise exception 'Please attach your resume.'; end if;
  if length(p_file_b64) > 7000000 then raise exception 'Your resume is too big (5 MB at most).'; end if;
  if coalesce(lower(p_file_name), '') !~ '\.(pdf|docx?|rtf|txt|odt)$' then raise exception 'Please attach your resume as a PDF or Word file.'; end if;
  if (select count(*) from hire_candidates where opening_id = o.id and created_at > now() - interval '1 day') >= 300 then
    raise exception 'We are receiving a lot of applications right now. Please try again tomorrow.'; end if;
  if exists (select 1 from hire_candidates where opening_id = o.id and lower(email) = lower(trim(p_email))) then
    raise exception 'You have already applied for this position with this email address. Thank you!'; end if;
  insert into hire_candidates (workspace_id, opening_id, name, email, phone, location, links, source, cover_letter, owner_id, updated_by)
  values (o.workspace_id, o.id, left(trim(p_name), 120), lower(trim(p_email)), left(p_phone, 40), left(p_location, 120),
    coalesce((select jsonb_object_agg(k, left(v, 300)) from jsonb_each_text(coalesce(p_links, '{}')) x(k, v)
               where k in ('linkedin', 'github', 'portfolio') and v ~* '^https?://'), '{}'),
    'Apply link', left(p_cover, 6000), o.hiring_manager, 'Apply link')
  returning id into cid;
  insert into hire_files (workspace_id, candidate_id, name, mime, size, data_b64, uploaded_by)
  values (o.workspace_id, cid, left(p_file_name, 200), left(p_file_mime, 100), (length(p_file_b64) * 3 / 4)::int, p_file_b64, 'Applicant');
  return 'Thank you, ' || split_part(trim(p_name), ' ', 1) || '. Your application for ' || o.title || ' has been received.';
end $$;

-- the offer was accepted: start their onboarding checklist and mark them hired
create or replace function public.hire_mark_hired(p_candidate bigint, p_start date, p_checklist jsonb) returns bigint
language plpgsql volatile security definer set search_path = public as $$
declare c hire_candidates; o hire_openings; oid bigint;
begin
  perform plan_require('hiring');
  if not hire_lead(p_candidate) then raise exception 'Only the hiring manager, the owner or an admin can mark someone hired.'; end if;
  select * into c from hire_candidates where id = p_candidate;
  select * into o from hire_openings where id = c.opening_id;
  if c.onboarding_id is not null then return c.onboarding_id; end if;
  select id into oid from onboardings where workspace_id = c.workspace_id and lower(email) = lower(c.email) and status <> 'Offboarded';
  if oid is null then
    insert into onboardings (workspace_id, name, email, phone, kind, role_title, start_date, status, owner_id, checklist, notes)
    values (c.workspace_id, c.name, c.email, c.phone, o.kind, o.title, p_start, 'Planned', coalesce(o.hiring_manager, auth.uid()),
      coalesce(p_checklist, '[]'), 'Hired through ' || o.title || ' (People → Hiring)')
    returning id into oid;
  end if;
  update hire_candidates set stage = 'Hired', onboarding_id = oid, next_step = null, next_date = null where id = p_candidate;
  return oid;
end $$;

-- counts for the landing page and the People app
create or replace function public.hire_summary() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when not ws_has_app('hiring') then '{}'::jsonb else jsonb_build_object(
    'open_roles', (select count(*) from hire_openings where workspace_id = staff_ws() and status = 'Open'),
    'to_review', (select count(*) from hire_candidates c where c.workspace_id = staff_ws() and c.stage = 'Applied' and hire_can(c.id)),
    'in_process', (select count(*) from hire_candidates c where c.workspace_id = staff_ws() and c.stage in ('Screen', 'Interview', 'Work sample', 'Final', 'Offer') and hire_can(c.id)),
    'my_scorecards', (select count(*) from hire_interviews i where i.workspace_id = staff_ws() and auth.uid() = any (i.interviewer_ids) and i.status <> 'Cancelled'
        and coalesce(i.scheduled_at, now()) <= now() + interval '1 hour'
        and not exists (select 1 from hire_scores s where s.interview_id = i.id and s.interviewer_id = auth.uid() and s.submitted_at is not null)),
    'my_interviews', (select count(*) from hire_interviews i where i.workspace_id = staff_ws() and auth.uid() = any (i.interviewer_ids)
        and i.status = 'Scheduled' and i.scheduled_at between now() and now() + interval '7 days')) end $$;

revoke execute on function public.hire_scored(bigint) from public, anon;
grant execute on function public.hire_scored(bigint) to authenticated;
revoke execute on function public.hire_lead(bigint), public.hire_can(bigint), public.hire_upload(bigint, text, text, text),
  public.hire_mark_hired(bigint, date, jsonb), public.hire_summary(), public.hire_opening_public(text),
  public.hire_apply(text, text, text, text, text, jsonb, text, text, text, text) from public;
grant execute on function public.hire_lead(bigint), public.hire_can(bigint), public.hire_upload(bigint, text, text, text),
  public.hire_mark_hired(bigint, date, jsonb), public.hire_summary() to authenticated;
grant execute on function public.hire_opening_public(text), public.hire_apply(text, text, text, text, text, jsonb, text, text, text, text) to anon, authenticated;
revoke execute on function public.hire_log() from public, anon, authenticated;

-- ── Careers page: every open opening on one public page (careers/?c=<slug>), which a company can link to or embed on its own website ──
alter table public.workspaces add column if not exists careers_slug text;
alter table public.workspaces add column if not exists careers_on boolean not null default false;
create unique index if not exists ux_workspaces_careers on public.workspaces (lower(careers_slug)) where careers_slug is not null;

-- public (no sign-in): the company's open openings, or null if the careers page is off
create or replace function public.hire_careers_public(p_slug text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('company', w.name, 'logo_url', w.logo_url,
           'openings', coalesce((select jsonb_agg(jsonb_build_object('title', o.title, 'kind', o.kind, 'schedule', o.schedule, 'location', o.location,
                'remote', o.remote, 'pay', o.pay, 'token', o.apply_token, 'summary', left(regexp_replace(coalesce(o.description, ''), '\s+', ' ', 'g'), 220),
                'posted', o.created_at::date) order by o.created_at desc)
              from hire_openings o where o.workspace_id = w.id and o.status = 'Open'), '[]'::jsonb))
    from workspaces w
   where lower(w.careers_slug) = lower(trim(coalesce(p_slug, ''))) and w.careers_on and ws_has_app_for(w.id, 'hiring') $$;

-- admins: turn the careers page on or off and choose its address
create or replace function public.hire_careers_set(p_on boolean, p_slug text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare s text := lower(trim(coalesce(p_slug, '')));
begin
  perform plan_require('hiring');
  if not is_admin() then raise exception 'Only admins can change the careers page.'; end if;
  if s !~ '^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$' then raise exception 'Use 3 to 40 lowercase letters, numbers or dashes for the address, like acme-robotics.'; end if;
  if exists (select 1 from workspaces where lower(careers_slug) = s and id <> ws()) then raise exception 'That address is taken. Try another.'; end if;
  update workspaces set careers_slug = s, careers_on = coalesce(p_on, false) where id = ws();
  return jsonb_build_object('slug', s, 'on', coalesce(p_on, false));
end $$;
-- signed-in members: the careers page settings for their own workspace
create or replace function public.hire_careers_get() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('careers_slug', careers_slug, 'careers_on', careers_on) from workspaces where id = ws() $$;
revoke execute on function public.hire_careers_get() from public, anon;
grant execute on function public.hire_careers_get() to authenticated;
grant execute on function public.hire_careers_public(text) to anon, authenticated;
revoke execute on function public.hire_careers_set(boolean, text) from public, anon;
grant execute on function public.hire_careers_set(boolean, text) to authenticated;

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
  perform plan_require('chief');
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
  perform plan_require('agreements');
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
  perform plan_require('agreements');
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
  perform plan_require('agreements');
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
  perform plan_require('agreements');
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
  perform plan_require('agreements');
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
  items := case a.kind when 'confidentiality' then array['nda'] when 'consulting' then array['sign', 'agreement'] when 'employment' then array['sign', 'agreement'] else array[]::text[] end;
  update onboardings set checklist = (select coalesce(jsonb_agg(case when i ->> 'id' = any (items) and not coalesce((i ->> 'done')::boolean, false)
      then i || jsonb_build_object('done', true, 'done_at', now(), 'done_by', 'Signed agreement') else i end), '[]') from jsonb_array_elements(checklist) i)
   where id = a.onboarding_id;
end $$;
-- company signer signs inside Pulse (no link needed)
create or replace function public.agr_sign_member(p_id bigint, p_name text, p_title text, p_kind text, p_data text, p_consent boolean, p_user_agent text default null) returns void
language plpgsql volatile security definer set search_path = public as $$
declare s agreement_signers; tok text := pulse_token();
begin
  perform plan_require('agreements');
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
  perform plan_require('agreements');
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
  perform plan_require('agreements');
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
  perform plan_require('agreements');
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

-- ================================================================ Opportunities: federal contracts (SAM.gov) and grants (Grants.gov)
-- Pulse pulls new notices from the SAM.gov Get Opportunities API and open grants from the Grants.gov search2 API on a timer (pg_cron + pg_net, inside the database)
-- and matches every saved search against them locally, so the number of searches doesn't use up the API allowance.
-- Each workspace brings its own SAM.gov API key, kept encrypted in Supabase Vault; nobody can read it back.
do $$ begin create extension if not exists pg_net with schema extensions; exception when others then raise notice 'pg_net not available here (%). Federal fetching stays off until it is enabled.', sqlerrm; end $$;
do $$ begin create extension if not exists pg_cron with schema pg_catalog; exception when others then raise notice 'pg_cron not available here (%).', sqlerrm; end $$;

create table if not exists public.fed_config (
  workspace_id uuid primary key default public.ws_default() references public.workspaces (id) on delete cascade,
  enabled boolean not null default true,
  every_min int not null default 1440 check (every_min in (15, 30, 60, 120, 240, 720, 1440)),
  daily_budget int not null default 900 check (daily_budget between 1 and 10000),
  key_secret_id uuid, key_hint text,
  next_fetch_at timestamptz, last_fetch_at timestamptz, yesterday_done date,
  last_status text, last_error text, updated_at timestamptz default now(), updated_by text
);
create table if not exists public.fed_calls (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  request_id bigint, page_offset int not null default 0, posted_from date, posted_to date,
  status text not null default 'pending' check (status in ('pending', 'done', 'error')),
  http_status int, records int, total int, error text,
  created_at timestamptz not null default now(), done_at timestamptz
);
create index if not exists ix_fed_calls_ws on public.fed_calls (workspace_id, created_at desc);
create table if not exists public.fed_notices (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  notice_id text not null,
  source text not null default 'SAM.gov',
  title text, sol_number text, path_name text, agency text, subtier text, office text,
  notice_type text, base_type text, posted_date date, response_deadline timestamptz,
  naics text, naics_all text[] not null default '{}', psc text, set_aside_code text, set_aside text,
  state text, city text, ui_link text, award_amount numeric, awardee text, active boolean,
  status text not null default 'New' check (status in ('New', 'Saved', 'Dismissed', 'Added')),
  opportunity_id bigint references public.opportunities (id) on delete set null,
  first_seen timestamptz not null default now(), updated_at timestamptz not null default now(), status_by text,
  primary key (workspace_id, notice_id)
);
create index if not exists ix_fed_notices_ws on public.fed_notices (workspace_id, posted_date desc);
create table if not exists public.fed_searches (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  name text not null,
  naics text[] not null default '{}', agencies text[] not null default '{}',
  size text not null default 'any' check (size in ('any', 'small', 'unrestricted')),
  set_asides text[] not null default '{}', notice_types text[] not null default '{}',
  keywords text[] not null default '{}', exclude text[] not null default '{}',
  open_only boolean not null default true, active boolean not null default true,
  owner_id uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz default now(), updated_at timestamptz default now(), updated_by text
);
create table if not exists public.fed_matches (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  search_id bigint not null references public.fed_searches (id) on delete cascade,
  notice_id text not null,
  matched_at timestamptz not null default now(),
  primary key (search_id, notice_id),
  foreign key (workspace_id, notice_id) references public.fed_notices (workspace_id, notice_id) on delete cascade
);
create index if not exists ix_fed_matches_notice on public.fed_matches (workspace_id, notice_id);
-- grants (Grants.gov) share the same tables; source says where a row came from
alter table public.fed_config alter column every_min set default 1440;
alter table public.fed_config add column if not exists grants_fetch_at timestamptz;
-- SAM.gov refuses connections from the database network, so searches go through the sam-relay Edge Function
alter table public.fed_config add column if not exists sam_relay_url text;
alter table public.fed_config add column if not exists grants_error text;
alter table public.fed_config add column if not exists bidmatch_secret_id uuid;
alter table public.fed_config add column if not exists bidmatch_hint text;
alter table public.fed_config add column if not exists bidmatch_fetch_at timestamptz;
alter table public.fed_config add column if not exists bidmatch_error text;
alter table public.fed_calls add column if not exists ref text;
alter table public.fed_notices add column if not exists level text;
alter table public.fed_notices add column if not exists summary text;
alter table public.fed_notices add column if not exists bm_keywords text;
-- who to talk to: [{name, title, email, phone, type}] (SAM.gov point of contact, the BidMatch POC line, the Grants.gov agency contact)
alter table public.fed_notices add column if not exists contacts jsonb not null default '[]';
alter table public.fed_notices add column if not exists detail_at timestamptz;
create table if not exists public.fed_bm_docs (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  doc text not null, list_date date, articles int, created_at timestamptz not null default now(),
  primary key (workspace_id, doc)
);
alter table public.fed_bm_docs enable row level security;
alter table public.fed_calls add column if not exists source text not null default 'SAM.gov';
alter table public.fed_notices add column if not exists aln text[] not null default '{}';
alter table public.fed_notices add column if not exists funding_id bigint references public.funding (id) on delete set null;
alter table public.fed_searches add column if not exists source text not null default 'SAM.gov';
alter table public.fed_searches add column if not exists aln text[] not null default '{}';
-- one profile per workspace and source (your NAICS codes and keywords); a notice fits if it has ANY of your codes OR ANY of your keywords
alter table public.fed_searches add column if not exists is_profile boolean not null default false;
alter table public.fed_searches add column if not exists match_any boolean not null default false;
create unique index if not exists ux_fed_searches_profile on public.fed_searches (workspace_id, source) where is_profile;
do $$ begin
  alter table public.fed_searches add constraint fed_searches_source check (source in ('SAM.gov', 'Grants.gov'));
exception when duplicate_object then null; end $$;

alter table public.fed_config enable row level security;
alter table public.fed_calls enable row level security;
alter table public.fed_notices enable row level security;
alter table public.fed_searches enable row level security;
alter table public.fed_matches enable row level security;
do $$ declare t text; begin
  foreach t in array array['fed_config', 'fed_calls', 'fed_notices', 'fed_searches', 'fed_matches'] loop
    execute format('drop policy if exists staff_read on public.%I', t);
    execute format('create policy staff_read on public.%I for select to authenticated using (workspace_id = staff_ws())', t);
  end loop;
end $$;
drop policy if exists staff_write on public.fed_searches;
create policy staff_write on public.fed_searches for all to authenticated using (workspace_id = staff_ws()) with check (workspace_id = staff_ws());
revoke all on public.fed_config, public.fed_calls, public.fed_notices, public.fed_searches, public.fed_matches from anon, authenticated;
grant select on public.fed_calls, public.fed_notices, public.fed_matches to authenticated;
grant select (workspace_id, enabled, every_min, daily_budget, key_hint, next_fetch_at, last_fetch_at, last_status, last_error, grants_fetch_at, grants_error, bidmatch_hint, bidmatch_fetch_at, bidmatch_error, updated_at, updated_by) on public.fed_config to authenticated;
revoke all on public.fed_bm_docs from anon, authenticated;

grant select, insert, update, delete on public.fed_searches to authenticated;
drop trigger if exists stamp on public.fed_searches;
create trigger stamp before insert or update on public.fed_searches for each row execute function public.stamp_row();

-- does a notice fit a search?
-- "hydrological" also finds "hydrologic", "floods" finds "flood"
create or replace function public.fed_stem(k text) returns text language sql immutable as $$
  select case when length(regexp_replace(lower(trim(k)), '(ical|al|ing|ed|es|s)$', '')) >= 4
              then regexp_replace(lower(trim(k)), '(ical|al|ing|ed|es|s)$', '') else lower(trim(k)) end $$;
create or replace function public.fed_fits(n public.fed_notices, s public.fed_searches) returns boolean
language sql stable set search_path = public as $$
  with t as (select
      -- codes: NAICS for contracts, assistance listings for grants
      case when n.source = 'Grants.gov' then cardinality(s.aln) > 0 and exists (select 1 from unnest(s.aln) q, unnest(n.aln) c where c like trim(q) || '%')
           else cardinality(s.naics) > 0 and exists (select 1 from unnest(s.naics) q, unnest(n.naics_all) c where c like trim(q) || '%') end as code_hit,
      case when n.source = 'Grants.gov' then cardinality(s.aln) = 0 else cardinality(s.naics) = 0 end as no_codes,
      cardinality(s.keywords) > 0 and exists (select 1 from unnest(s.keywords) k where trim(k) <> ''
        and concat_ws(' ', n.title, n.sol_number, case when s.match_any then n.summary end) ilike '%' || fed_stem(k) || '%') as kw_hit)
  select n.source = s.source
     and (cardinality(s.agencies) = 0 or exists (select 1 from unnest(s.agencies) a where concat_ws(' ', n.path_name, n.agency, n.subtier) ilike '%' || trim(a) || '%'))
     and not exists (select 1 from unnest(s.exclude) k where trim(k) <> '' and n.title ilike '%' || trim(k) || '%')
     and (cardinality(s.notice_types) = 0 or n.notice_type = any (s.notice_types) or n.base_type = any (s.notice_types))
     and (not s.open_only or n.response_deadline is null or n.response_deadline >= now())
     and case when s.match_any then t.code_hit or t.kw_hit
              else (t.no_codes or t.code_hit) and (cardinality(s.keywords) = 0 or t.kw_hit) end
     and (n.source = 'Grants.gov' or (
           (s.size = 'any' or (s.size = 'small' and coalesce(n.set_aside_code, '') not in ('', 'NONE'))
                or (s.size = 'unrestricted' and coalesce(n.set_aside_code, '') in ('', 'NONE')))
           and (cardinality(s.set_asides) = 0 or n.set_aside_code = any (s.set_asides))))
    from t $$;

-- add matches for one search (or every active search) in a workspace; returns how many new matches
create or replace function public.fed_rematch(p_ws uuid, p_search bigint default null, p_since timestamptz default null) returns int
language plpgsql volatile security definer set search_path = public as $$
declare v int;
begin
  insert into fed_matches (workspace_id, search_id, notice_id)
  select p_ws, s.id, n.notice_id from fed_searches s join fed_notices n on n.workspace_id = s.workspace_id
   where s.workspace_id = p_ws and s.active and (p_search is null or s.id = p_search)
     and (p_since is null or n.updated_at >= p_since) and fed_fits(n, s)
  on conflict do nothing;
  get diagnostics v = row_count;
  return v;
end $$;

create or replace function public.fed_ts(p text) returns timestamptz language plpgsql immutable as $$
begin return nullif(p, '')::timestamptz; exception when others then return null; end $$;
create or replace function public.fed_num(p text) returns numeric language plpgsql immutable as $$
begin return nullif(regexp_replace(coalesce(p, ''), '[^0-9.\-]', '', 'g'), '')::numeric; exception when others then return null; end $$;

-- "DEPT OF THE ARMY" → "Dept of the Army"
create or replace function public.fed_name(p text) returns text language sql immutable as $$
  select nullif(array_to_string(array(
    select case when i > 1 and lower(w) in ('of', 'the', 'and', 'for', 'on', 'in', 'at', 'to') then lower(w)
                when w ~ '^[A-Z0-9]{2,5}$' and w ~ '[0-9]' then w else initcap(w) end
      from unnest(regexp_split_to_array(trim(coalesce(p, '')), '\s+')) with ordinality t(w, i) order by i), ' '), '') $$;
-- store one page of SAM.gov results
create or replace function public.fed_store(p_ws uuid, p_body jsonb) returns int
language plpgsql volatile security definer set search_path = public as $$
declare v int;
begin
  insert into fed_notices as f (workspace_id, notice_id, title, sol_number, path_name, agency, subtier, office, notice_type, base_type, posted_date,
      response_deadline, naics, naics_all, psc, set_aside_code, set_aside, state, city, ui_link, award_amount, awardee, active, contacts)
  select p_ws, o ->> 'noticeId', o ->> 'title', o ->> 'solicitationNumber', o ->> 'fullParentPathName',
      fed_name(split_part(o ->> 'fullParentPathName', '.', 1)), fed_name(nullif(split_part(o ->> 'fullParentPathName', '.', 2), '')),
      fed_name(nullif(regexp_replace(o ->> 'fullParentPathName', '^.*\.', ''), '')),
      o ->> 'type', o ->> 'baseType', fed_ts(o ->> 'postedDate')::date, fed_ts(o ->> 'responseDeadLine'),
      o ->> 'naicsCode',
      coalesce((select array_agg(distinct x) from (select jsonb_array_elements_text(case when jsonb_typeof(o -> 'naicsCodes') = 'array' then o -> 'naicsCodes' else '[]' end) x
                union select o ->> 'naicsCode') z where x is not null and x <> ''), '{}'),
      o ->> 'classificationCode', nullif(o ->> 'typeOfSetAside', ''), nullif(o ->> 'typeOfSetAsideDescription', ''),
      o #>> '{placeOfPerformance,state,code}', o #>> '{placeOfPerformance,city,name}', o ->> 'uiLink',
      fed_num(o #>> '{award,amount}'), o #>> '{award,awardee,name}', (o ->> 'active') = 'Yes',
      coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('name', fed_person(p ->> 'fullName'), 'title', nullif(trim(p ->> 'title'), ''),
          'email', nullif(lower(trim(p ->> 'email')), ''), 'phone', nullif(trim(p ->> 'phone'), ''), 'type', initcap(nullif(p ->> 'type', '')))))
        from jsonb_array_elements(case when jsonb_typeof(o -> 'pointOfContact') = 'array' then o -> 'pointOfContact' else '[]' end) p
       where coalesce(nullif(trim(p ->> 'fullName'), ''), nullif(trim(p ->> 'email'), '')) is not null), '[]')
    from jsonb_array_elements(case when jsonb_typeof(p_body -> 'opportunitiesData') = 'array' then p_body -> 'opportunitiesData' else '[]' end) o
   where coalesce(o ->> 'noticeId', '') <> ''
  on conflict (workspace_id, notice_id) do update set title = excluded.title, sol_number = excluded.sol_number, path_name = excluded.path_name,
      agency = excluded.agency, subtier = excluded.subtier, office = excluded.office, notice_type = excluded.notice_type, base_type = excluded.base_type,
      posted_date = excluded.posted_date, response_deadline = excluded.response_deadline, naics = excluded.naics, naics_all = excluded.naics_all,
      psc = excluded.psc, set_aside_code = excluded.set_aside_code, set_aside = excluded.set_aside, state = excluded.state, city = excluded.city,
      ui_link = excluded.ui_link, award_amount = excluded.award_amount, awardee = excluded.awardee, active = excluded.active, contacts = excluded.contacts, updated_at = now()
    where (f.title, f.response_deadline, f.active, f.set_aside_code, f.notice_type, f.contacts) is distinct from
          (excluded.title, excluded.response_deadline, excluded.active, excluded.set_aside_code, excluded.notice_type, excluded.contacts);
  get diagnostics v = row_count;
  return v;
end $$;

create or replace function public.fed_used_today(p_ws uuid) returns int language sql stable set search_path = public as $$
  select count(*)::int from fed_calls where workspace_id = p_ws and request_id is not null and source = 'SAM.gov'
     and (created_at at time zone 'America/New_York')::date = (now() at time zone 'America/New_York')::date $$;

-- ask SAM.gov for one page (async through pg_net); returns false when out of budget or not set up
create or replace function public.fed_request(p_ws uuid, p_from date, p_to date, p_offset int) returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare c fed_config; k text; rid bigint;
begin
  select * into c from fed_config where workspace_id = p_ws;
  if c.key_secret_id is null then update fed_config set last_status = 'No SAM.gov API key yet' where workspace_id = p_ws; return false; end if;
  if fed_used_today(p_ws) >= c.daily_budget then
    update fed_config set last_status = format('Paused: daily limit of %s requests reached; resumes after midnight Eastern', c.daily_budget) where workspace_id = p_ws;
    return false;
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where id = $1' into k using c.key_secret_id;
  if k is null then update fed_config set last_error = 'The saved API key could not be read. Save it again in Settings.' where workspace_id = p_ws; return false; end if;
  execute 'select net.http_get(url := $1, params := $2, timeout_milliseconds := 180000)' into rid
    using coalesce(nullif(c.sam_relay_url, ''), 'https://api.sam.gov/opportunities/v2/search'),
          jsonb_build_object('api_key', k, 'postedFrom', to_char(p_from, 'MM/DD/YYYY'), 'postedTo', to_char(p_to, 'MM/DD/YYYY'), 'limit', '200', 'offset', p_offset::text);
  insert into fed_calls (workspace_id, request_id, page_offset, posted_from, posted_to) values (p_ws, rid, p_offset, p_from, p_to);
  return true;
exception when undefined_function or invalid_schema_name or undefined_table then
  update fed_config set last_error = 'The database extensions for fetching (pg_net, Vault) are not turned on. See Settings.' where workspace_id = p_ws;
  return false;
end $$;


-- a person's name, tidied: "POWERS, Mr. FRANK M" -> "Frank M Powers"
create or replace function public.fed_person(p text) returns text language plpgsql immutable as $$
declare n text := trim(both ' ,;' from coalesce(p, ''));
begin
  n := regexp_replace(n, '\m(Mr|Ms|Mrs|Miss|Dr)\.?\s+', '', 'gi');
  if n ~ '^[^,]+,[^,]+$' then n := trim(split_part(n, ',', 2)) || ' ' || trim(split_part(n, ',', 1)); end if;
  n := regexp_replace(n, '\s+', ' ', 'g');
  if n = upper(n) then n := initcap(n); end if;
  return nullif(n, '');
end $$;

-- contacts in a MyBidMatch article: the "POC Name, email, tel:..." line on federal notices, otherwise the first email address
create or replace function public.fed_bm_contacts(p_body text) returns jsonb language plpgsql immutable as $$
declare seg text; em text[]; parts text[]; out jsonb := '[]'; i int; nm text; ph text;
  ere text := '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}';
begin
  if p_body is null then return out; end if;
  seg := substring(p_body from '\mPOC\s+(.{1,250}.{0,250})');
  if seg is not null then
    em := array(select m[1] from regexp_matches(seg, '(' || ere || ')', 'g') m);
    parts := regexp_split_to_array(seg, ere);
    for i in 1 .. least(coalesce(array_length(em, 1), 0), 3) loop
      nm := trim(both ' ,' from regexp_replace(parts[i], '^\s*,?\s*tel:\s*[0-9() .+-]*[0-9]', ''));
      -- past the POC line the text is the notice itself: stop at anything that doesn't look like a name
      exit when i > 1 and (length(nm) > 45 or nm !~ '^[A-Za-z][A-Za-z .,''-]*$' or array_length(regexp_split_to_array(trim(nm), '\s+'), 1) > 5);
      ph := substring(parts[i + 1] from '^\s*,\s*tel:\s*([0-9() .+-]*[0-9])');
      out := out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('name', case when length(nm) <= 45 and nm ~ '^[A-Za-z][A-Za-z .,''-]*$' then fed_person(nm) end,
               'email', lower(em[i]), 'phone', nullif(trim(ph), ''))));
    end loop;
  end if;
  if jsonb_array_length(out) = 0 then
    nm := substring(p_body from '(' || ere || ')');
    if nm is not null then out := jsonb_build_array(jsonb_build_object('email', lower(trim(trailing '.' from nm)))); end if;
  end if;
  return out;
end $$;

-- ----- MyBidMatch (Outreach Systems): the subscriber's daily match lists, read from their private link
-- Only the last 3 days of lists are read (older days are skipped).
create or replace function public.fed_unhtml(p text) returns text language sql immutable as $$
  select nullif(trim(regexp_replace(replace(replace(replace(replace(replace(replace(regexp_replace(coalesce(p, ''), '<[^>]+>', ' ', 'g'),
    '&nbsp;', ' '), '&quot;', '"'), '&#39;', ''''), '&lt;', '<'), '&gt;', '>'), '&amp;', '&'), '\s+', ' ', 'g')), '') $$;

-- Federal / State / Local / Education, from the buyer name and the notice text
create or replace function public.fed_level(p_source text, p_agency text, p_text text) returns text language plpgsql immutable as $$
declare a text := coalesce(p_agency, ''); rest text; t text := coalesce(p_text, '');
  edu text := '(school|universit|college|education|academy|board of ed|\misd\M|\musd\M|k-12)';
  loc text := '(city of|county|town of|village of|borough|township|parish|municipal|\mport of|authority|sanitation|sewer|water district|service district|transit|housing)';
begin
  if p_source = 'procure' or a ~* '^(dept|department) of|^(general services|national aeronautics|environmental protection|small business administration|social security|nuclear regulatory|agency for|u\.?s\.?\M|federal|national)' then
    return 'Federal';
  end if;
  if a ~ '^[A-Z][A-Za-z .]+ - ' then
    rest := regexp_replace(a, '^[A-Za-z .]+ - ', '');
    if rest ~* edu then return 'Education'; end if;
    if rest ~* loc then return 'Local'; end if;
    if rest ~* '(vbo|eva|business opportunities|procurement portal|bid board|bidnet|demandstar)' then
      if left(t, 400) ~* edu then return 'Education'; end if;
      if left(t, 400) ~* '(city of|county of|\mcounty\M|town of)' then return 'Local'; end if;
    end if;
    return 'State';
  end if;
  return case when p_source = 'bid' then 'State' else 'Other' end;
end $$;

create or replace function public.fed_request_bm(p_ws uuid, p_kind text, p_ref text default null, p_seq int default 0) returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare c fed_config; url text; rid bigint;
begin
  select * into c from fed_config where workspace_id = p_ws;
  if p_kind = 'sub' then
    if c.bidmatch_secret_id is null then return false; end if;
    execute 'select decrypted_secret from vault.decrypted_secrets where id = $1' into url using c.bidmatch_secret_id;
  elsif p_kind = 'doc' then url := 'https://mybidmatch.outreachsystems.com/go?doc=' || p_ref;
  else url := 'https://mybidmatch.outreachsystems.com/article?doc=' || p_ref || '&seq=' || p_seq;
  end if;
  if url is null or url !~ '^https://mybidmatch\.outreachsystems\.com/' then return false; end if;
  execute 'select net.http_get(url := $1, timeout_milliseconds := 60000)' into rid using url;
  insert into fed_calls (workspace_id, request_id, source, ref, page_offset) values (p_ws, rid, 'BidMatch', p_kind || ':' || coalesce(p_ref, ''), p_seq);
  return true;
exception when undefined_function or invalid_schema_name or undefined_table then
  update fed_config set bidmatch_error = 'The database extension for fetching (pg_net) is not turned on. See Settings.' where workspace_id = p_ws;
  return false;
end $$;

-- handle one MyBidMatch page: the subscriber page (list of days), a day's list, or one article
create or replace function public.fed_store_bm(p_ws uuid, p_kind text, p_ref text, p_seq int, p_html text) returns int
language plpgsql volatile security definer set search_path = public as $$
declare m text[]; n int := 0; d date; body text; h4 text; due text; sol text; ts timestamptz;
begin
  if p_kind = 'sub' then
    if p_html !~* 'mybidmatch' then raise exception 'That page is not a MyBidMatch list'; end if;
    for m in select regexp_matches(p_html, 'href="/go\?doc=([0-9A-Fa-f-]{36})"[^>]*>[A-Za-z]+, ([A-Za-z]{3} +[0-9]{1,2}, [0-9]{4})</a>\s*</td>\s*<td[^>]*>\s*([0-9]+)', 'g') loop
      d := to_date(regexp_replace(m[2], ' +', ' ', 'g'), 'Mon DD, YYYY');
      if d >= current_date - 3 and m[3]::int > 0 and not exists (select 1 from fed_bm_docs where workspace_id = p_ws and doc = upper(m[1])) then
        insert into fed_bm_docs (workspace_id, doc, list_date, articles) values (p_ws, upper(m[1]), d, m[3]::int);
        perform fed_request_bm(p_ws, 'doc', upper(m[1]));
        n := n + 1;
      end if;
    end loop;
  elsif p_kind = 'doc' then
    select list_date into d from fed_bm_docs where workspace_id = p_ws and doc = upper(p_ref);
    for m in select regexp_matches(p_html,
        '<tr>\s*<td[^>]*>\s*([0-9]+)\s*</td>\s*<td[^>]*>([^<]*)</td>\s*<td[^>]*>([^<]*)</td>\s*<td[^>]*>([^<]*)</td>\s*<td[^>]*>\s*<a href="/article\?doc=([0-9A-Fa-f-]{36})&(?:amp;)?seq=([0-9]+)"[^>]*>([^<]*)</a>\s*</td>\s*<td[^>]*>([^<]*)</td>', 'g') loop
      insert into fed_notices (workspace_id, notice_id, source, title, agency, path_name, base_type, notice_type, psc, posted_date, naics, naics_all, ui_link, level, state, active, bm_keywords)
      values (p_ws, 'B' || upper(m[5]) || '-' || m[6], 'BidMatch', fed_unhtml(m[7]),
        case when trim(m[2]) = 'procure' then fed_name(fed_unhtml(m[3])) else fed_unhtml(m[3]) end, fed_unhtml(m[3]), trim(m[2]),
        case trim(m[2]) when 'procure' then 'Federal notice' when 'bid' then 'Bid' else initcap(trim(m[2])) end, nullif(trim(m[4]), ''), d,
        substring(m[8] from 'naics!([0-9]+)'), coalesce(array(select x[1] from regexp_matches(m[8], 'naics!([0-9]+)', 'g') x), '{}'),
        'https://mybidmatch.outreachsystems.com/article?doc=' || upper(m[5]) || '&seq=' || m[6],
        fed_level(trim(m[2]), fed_unhtml(m[3]), null), nullif(substring(fed_unhtml(m[3]) from '^([A-Za-z .]+) - '), ''), true, fed_unhtml(m[8]))
      on conflict (workspace_id, notice_id) do nothing;
      if found then n := n + 1; perform fed_request_bm(p_ws, 'article', upper(m[5]), m[6]::int); end if;
    end loop;
  else
    h4 := fed_unhtml(substring(p_html from '<h4>(.*?)</h4>'));
    body := fed_unhtml(substring(p_html from '</h4>(.*?)<i>OutreachSystems'));
    m := regexp_match(body, '(?i)(?:due date|closing on|closing date|response date|responses? due|offers due|bids? due|deadline|\mdue\M)[^0-9]{0,30}([0-9]{1,2}/[0-9]{1,2}/[0-9]{2,4})(?:[ ,]*(?:at)?[ ]*([0-9]{1,2}:[0-9]{2}) *([AP]M))?');
    begin
      d := to_date(regexp_replace(m[1], '/([0-9]{2})$', '/20\1'), 'MM/DD/YYYY');
      ts := case when m[2] is not null then (d + to_timestamp(m[2] || ' ' || upper(m[3]), 'HH12:MI AM')::time) at time zone 'America/New_York'
                 when d is not null then (d + time '23:59') at time zone 'America/New_York' end;
    exception when others then ts := null; end;
    sol := trim(substring(body from '\mSOL\s+((?:(?:RFP|RFQ|IFB|ITB|RFI|RFB)\s+)?[A-Z0-9][A-Za-z0-9_./-]{2,})'));
    due := substring(body from '(?i)set-aside:\s*(.+?\))');
    update fed_notices set summary = left(body, 6000), contacts = fed_bm_contacts(body), sol_number = coalesce(sol, sol_number), response_deadline = coalesce(ts, response_deadline),
        set_aside = coalesce(due, set_aside), set_aside_code = coalesce(case when due ~* 'small business' then 'SB' end, set_aside_code),
        subtier = case when base_type = 'procure' then coalesce(fed_name(nullif(trim(split_part(h4, ',', 2)), '')), subtier) else subtier end,
        office = case when base_type = 'procure' then coalesce(fed_name(nullif(trim(split_part(h4, ',', 3)), '')), office) else office end,
        state = coalesce(state, substring(body from 'Place of Performance:[^,]*?\m([A-Z]{2})\M\s')),
        naics_all = (select coalesce(array_agg(distinct x), '{}') from (select unnest(naics_all) x union select (regexp_matches(body, '(?i)naics(?: code)?(?: is|:)?\s*([0-9]{6})', 'g'))[1]) z),
        naics = coalesce(naics, substring(body from '(?i)naics(?: code)?(?: is|:)?\s*([0-9]{6})')),
        level = fed_level(base_type, agency, coalesce(h4, '') || ' ' || coalesce(body, '')), updated_at = now()
     where workspace_id = p_ws and notice_id = 'B' || upper(p_ref) || '-' || p_seq;
    get diagnostics n = row_count;
  end if;
  return n;
end $$;

-- the timer: collect finished responses, store them, match, ask for the next page or the next scheduled fetch
-- store one page of Grants.gov search2 results (open and forecasted grants)
create or replace function public.fed_store_grants(p_ws uuid, p_body jsonb) returns int
language plpgsql volatile security definer set search_path = public as $$
declare v int;
begin
  insert into fed_notices as f (workspace_id, notice_id, source, title, sol_number, path_name, agency, subtier, notice_type, base_type, posted_date,
      response_deadline, aln, ui_link, active)
  select p_ws, 'G' || (o ->> 'id'), 'Grants.gov', o ->> 'title', o ->> 'number', concat_ws(' ', o ->> 'agencyName', o ->> 'agencyCode'),
      coalesce(nullif(o ->> 'agencyName', ''), o ->> 'agencyCode'), o ->> 'agencyCode', initcap(o ->> 'oppStatus'), o ->> 'docType',
      fed_date(o ->> 'openDate'), (fed_date(o ->> 'closeDate') + time '23:59') at time zone 'America/New_York',
      coalesce((select array_agg(x) from jsonb_array_elements_text(case when jsonb_typeof(o -> 'alnist') = 'array' then o -> 'alnist' else '[]' end) x where x <> ''), '{}'),
      'https://www.grants.gov/search-results-detail/' || (o ->> 'id'), true
    from jsonb_array_elements(case when jsonb_typeof(p_body #> '{data,oppHits}') = 'array' then p_body #> '{data,oppHits}' else '[]' end) o
   where coalesce(o ->> 'id', '') <> ''
  on conflict (workspace_id, notice_id) do update set title = excluded.title, sol_number = excluded.sol_number, path_name = excluded.path_name,
      agency = excluded.agency, subtier = excluded.subtier, notice_type = excluded.notice_type, base_type = excluded.base_type,
      posted_date = excluded.posted_date, response_deadline = excluded.response_deadline, aln = excluded.aln, ui_link = excluded.ui_link, updated_at = now()
    where (f.title, f.response_deadline, f.notice_type, f.aln) is distinct from (excluded.title, excluded.response_deadline, excluded.notice_type, excluded.aln);
  get diagnostics v = row_count;
  return v;
end $$;
create or replace function public.fed_date(p text) returns date language plpgsql immutable as $$
begin return to_date(nullif(trim(p), ''), 'MM/DD/YYYY'); exception when others then return null; end $$;


-- Grants.gov search results carry no contact, so each matched grant is looked up once (fetchOpportunity) for its agency contact and description
create or replace function public.fed_request_grant_detail(p_ws uuid, p_notice text) returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare rid bigint;
begin
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 60000)' into rid
    using 'https://api.grants.gov/v1/api/fetchOpportunity', jsonb_build_object('opportunityId', substring(p_notice from 2)::bigint),
          '{"Content-Type": "application/json"}'::jsonb;
  insert into fed_calls (workspace_id, request_id, source, ref) values (p_ws, rid, 'GrantDetail', p_notice);
  return true;
exception when undefined_function or invalid_schema_name or undefined_table or invalid_text_representation then return false;
end $$;
create or replace function public.fed_store_grant_detail(p_ws uuid, p_notice text, p_body jsonb) returns int
language plpgsql volatile security definer set search_path = public as $$
declare d jsonb := coalesce(p_body #> '{data,synopsis}', p_body #> '{data,forecast}', '{}'); ph text; n int;
begin
  ph := nullif(trim(d ->> 'agencyContactPhone'), ''); if ph !~ '[0-9]{3}' then ph := null; end if;
  update fed_notices set detail_at = now(),
      contacts = case when coalesce(nullif(trim(d ->> 'agencyContactName'), ''), nullif(trim(d ->> 'agencyContactEmail'), '')) is not null
        then jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('name', fed_person(d ->> 'agencyContactName'),
               'email', nullif(lower(trim(d ->> 'agencyContactEmail')), ''), 'phone', ph, 'type', 'Agency contact'))) else contacts end,
      summary = coalesce(summary, left(fed_unhtml(coalesce(d ->> 'synopsisDesc', d ->> 'forecastDesc')), 6000)),
      -- grants added by link start as a placeholder; fill them in from the full record
      title = case when title like 'Grants.gov opportunity %' then coalesce(nullif(p_body #>> '{data,opportunityTitle}', ''), title) else title end,
      sol_number = coalesce(sol_number, nullif(p_body #>> '{data,opportunityNumber}', '')),
      agency = coalesce(agency, nullif(d ->> 'agencyName', ''), nullif(p_body #>> '{data,owningAgencyCode}', '')),
      notice_type = coalesce(notice_type, case when p_body #> '{data,synopsis}' is not null then 'Posted' when p_body #> '{data,forecast}' is not null then 'Forecasted' end),
      posted_date = coalesce(posted_date, fed_anydate(coalesce(d ->> 'postingDate', d ->> 'postingDateStr'))),
      response_deadline = coalesce(response_deadline, (fed_anydate(coalesce(d ->> 'responseDate', d ->> 'responseDateStr', d ->> 'estApplicationResponseDate')) + time '23:59') at time zone 'America/New_York')
   where workspace_id = p_ws and notice_id = p_notice;
  get diagnostics n = row_count;
  return n;
end $$;

-- ask Grants.gov for one page of open and forecasted grants (no key needed)
create or replace function public.fed_request_grants(p_ws uuid, p_start int) returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare rid bigint;
begin
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 180000)' into rid
    using 'https://api.grants.gov/v1/api/search2', jsonb_build_object('oppStatuses', 'forecasted|posted', 'rows', 1000, 'startRecordNum', p_start),
          '{"Content-Type": "application/json"}'::jsonb;
  insert into fed_calls (workspace_id, request_id, page_offset, source) values (p_ws, rid, p_start, 'Grants.gov');
  return true;
exception when undefined_function or invalid_schema_name or undefined_table then
  update fed_config set grants_error = 'The database extension for fetching (pg_net) is not turned on. See Settings.' where workspace_id = p_ws;
  return false;
end $$;

-- the timer: collect finished responses, store them, match, ask for the next page or the next scheduled fetch
create or replace function public.fed_tick_ws(p_ws uuid, p_force boolean default false) returns void
language plpgsql volatile security definer set search_path = public as $$
declare c fed_config; cl fed_calls; r record; g record; ct text; body jsonb; n int; got int; hits int; sid bigint; started timestamptz := clock_timestamp();
  today date := (now() at time zone 'America/New_York')::date; stamp text := to_char(now() at time zone 'America/New_York', 'Mon DD, HH12:MI AM');
begin
  select * into c from fed_config where workspace_id = p_ws for update skip locked;
  if not found then return; end if;
  for cl in select * from fed_calls where workspace_id = p_ws and status = 'pending' order by id loop
    begin
      execute 'select status_code, content, timed_out, error_msg from net._http_response where id = $1' into r using cl.request_id;
    exception when others then r := null; end;
    if r is null then
      if cl.created_at < now() - interval '15 minutes' then update fed_calls set status = 'error', error = 'No response from ' || cl.source, done_at = now() where id = cl.id; end if;
      continue;
    end if;
    body := null;
    if coalesce(r.status_code, 0) = 200 then begin body := r.content::jsonb; exception when others then body := null; end; end if;
    if cl.source = 'BidMatch' then
      if coalesce(r.status_code, 0) = 200 then
        begin
          got := fed_store_bm(p_ws, split_part(cl.ref, ':', 1), nullif(split_part(cl.ref, ':', 2), ''), cl.page_offset, r.content);
          update fed_calls set status = 'done', http_status = 200, records = got, done_at = now() where id = cl.id;
          if split_part(cl.ref, ':', 1) = 'sub' then update fed_config set bidmatch_fetch_at = now(), bidmatch_error = null where workspace_id = p_ws; end if;
        exception when others then
          update fed_calls set status = 'error', http_status = 200, error = sqlerrm, done_at = now() where id = cl.id;
          if split_part(cl.ref, ':', 1) = 'sub' then update fed_config set bidmatch_error = 'Could not read the MyBidMatch page: ' || sqlerrm where workspace_id = p_ws; end if;
        end;
      else
        update fed_calls set status = 'error', http_status = r.status_code, error = coalesce(r.error_msg, left(r.content, 300)), done_at = now() where id = cl.id;
        if split_part(cl.ref, ':', 1) = 'sub' then
          update fed_config set bidmatch_error = format('MyBidMatch error %s: %s', coalesce(r.status_code::text, ''), left(coalesce(r.error_msg, ''), 200)) where workspace_id = p_ws;
        end if;
      end if;
      continue;
    end if;
    if cl.source = 'GrantDetail' then
      if body is not null then
        got := fed_store_grant_detail(p_ws, cl.ref, body);
        update fed_calls set status = 'done', http_status = 200, records = got, done_at = now() where id = cl.id;
      else
        update fed_calls set status = 'error', http_status = r.status_code, error = coalesce(r.error_msg, left(r.content, 300), 'Unreadable response'), done_at = now() where id = cl.id;
        update fed_notices set detail_at = now() where workspace_id = p_ws and notice_id = cl.ref;
      end if;
      continue;
    end if;
    -- a bid source (any website, feed or API)
    if cl.source = 'Source' then
      if coalesce(r.status_code, 0) between 200 and 299 then
        begin
          execute 'select coalesce(headers ->> ''Content-Type'', headers ->> ''content-type'') from net._http_response where id = $1' into ct using cl.request_id;
        exception when others then ct := null; end;
        got := src_store(cl.ref::bigint, r.content, coalesce(ct, ''));
        update fed_calls set status = 'done', http_status = r.status_code, records = got, done_at = now() where id = cl.id;
      else
        update fed_calls set status = 'error', http_status = r.status_code, error = coalesce(r.error_msg, left(r.content, 300)), done_at = now() where id = cl.id;
        update fed_sources set last_fetch_at = now(), last_status = null,
               last_error = case when r.status_code in (401, 403) then 'The site refused Pulse (error ' || r.status_code || '). It may block automated readers or need a sign-in; set it to "Check by hand".'
                                 when r.status_code = 404 then 'Page not found (404). Check the link.'
                                 when r.timed_out then 'The site did not answer in time.'
                                 else format('Error %s: %s', coalesce(r.status_code::text, ''), left(coalesce(r.error_msg, r.content, ''), 200)) end
         where id = cl.ref::bigint;
      end if;
      continue;
    end if;
    -- a single notice asked for by link (Add by link)
    if cl.source = 'SAM.gov' and coalesce(cl.ref, '') like 'link:%' then
      if body is not null then
        got := fed_store(p_ws, body);
        update fed_notices set status = 'Saved', status_by = coalesce(status_by, 'Added by link') where workspace_id = p_ws and notice_id = substring(cl.ref from 6) and status = 'New';
        n := (select count(*) from fed_notices where workspace_id = p_ws and notice_id = substring(cl.ref from 6));
        update fed_calls set status = case when n > 0 then 'done' else 'error' end, http_status = 200, records = jsonb_array_length(coalesce(body -> 'opportunitiesData', '[]')),
               error = case when n > 0 then null else 'SAM.gov has no notice with that ID posted in the last year' end, done_at = now() where id = cl.id;
      else
        update fed_calls set status = 'error', http_status = r.status_code, done_at = now(),
               error = case when r.status_code = 429 then 'SAM.gov''s daily limit for your API key is used up; try again tomorrow'
                            when r.status_code in (401, 403) then 'SAM.gov rejected the API key; save a current key in Settings'
                            else coalesce(r.error_msg, left(r.content, 300), 'Unreadable response') end where id = cl.id;
      end if;
      continue;
    end if;
    if body is null then
      update fed_calls set status = 'error', http_status = r.status_code, error = coalesce(r.error_msg, left(r.content, 300), 'Unreadable response'), done_at = now() where id = cl.id;
      if cl.source = 'Grants.gov' then
        update fed_config set grants_error = format('Grants.gov error %s: %s', coalesce(r.status_code::text, ''), left(coalesce(r.error_msg, r.content, ''), 200)) where workspace_id = p_ws;
      else
        update fed_config set last_error = case
            when r.status_code = 429 then 'SAM.gov says the daily request limit for this API key is used up. Fetching resumes tomorrow; consider a slower schedule.'
            when r.status_code in (401, 403) then 'SAM.gov rejected the API key. Check it is current (keys expire every 90 days) and save it again.'
            when (r.timed_out or coalesce(r.error_msg, '') ilike '%timeout%') and nullif(c.sam_relay_url, '') is null
              then 'SAM.gov never accepted the connection from the database. Deploy the sam-relay Edge Function and run the contacts + relay SQL to route SAM.gov through it.'
            when r.timed_out or coalesce(r.error_msg, '') ilike '%timeout%' then 'SAM.gov did not answer in time (through sam-relay). Pulse tries once more; if this keeps happening, SAM.gov may be down.'
            else format('SAM.gov error %s: %s', r.status_code, left(coalesce(r.error_msg, r.content, ''), 200)) end
          where workspace_id = p_ws;
        -- a slow page gets one retry
        if coalesce(r.timed_out, false) or coalesce(r.error_msg, '') ilike '%timeout%' then
          if (select count(*) from fed_calls x where x.workspace_id = p_ws and x.source = 'SAM.gov' and x.posted_from is not distinct from cl.posted_from
                and x.page_offset = cl.page_offset and x.created_at > now() - interval '1 hour') < 2 then
            perform fed_request(p_ws, cl.posted_from, cl.posted_to, cl.page_offset);
          end if;
        end if;
      end if;
      continue;
    end if;
    if cl.source = 'Grants.gov' then
      n := fed_store_grants(p_ws, body);
      got := jsonb_array_length(coalesce(body #> '{data,oppHits}', '[]')); hits := (body #>> '{data,hitCount}')::int;
      update fed_calls set status = 'done', http_status = 200, records = got, total = hits, done_at = now() where id = cl.id;
      if got > 0 and coalesce(hits, 0) > cl.page_offset + got then perform fed_request_grants(p_ws, cl.page_offset + got); end if;
      update fed_config set grants_fetch_at = now(), grants_error = null where workspace_id = p_ws;
    else
      n := fed_store(p_ws, body);
      update fed_calls set status = 'done', http_status = 200, records = jsonb_array_length(coalesce(body -> 'opportunitiesData', '[]')), total = (body ->> 'totalRecords')::int, done_at = now() where id = cl.id;
      if coalesce((body ->> 'totalRecords')::int, 0) > cl.page_offset + 200 then
        perform fed_request(p_ws, cl.posted_from, cl.posted_to, cl.page_offset + 200);
      elsif cl.posted_from < today then
        update fed_config set yesterday_done = today where workspace_id = p_ws;
      end if;
      update fed_config set last_fetch_at = now(), last_error = null, last_status = 'Checked SAM.gov ' || stamp where workspace_id = p_ws;
    end if;
  end loop;
  perform fed_rematch(p_ws, null, started - interval '1 minute');
  -- next scheduled fetch: SAM.gov today's notices (plus yesterday's once a day, for late postings); Grants.gov all open grants
  select * into c from fed_config where workspace_id = p_ws;
  if (c.enabled and (c.next_fetch_at is null or c.next_fetch_at <= now()) or p_force)
     and not exists (select 1 from fed_calls where workspace_id = p_ws and status = 'pending' and source in ('SAM.gov', 'Grants.gov')) then
    update fed_config set next_fetch_at = now() + make_interval(mins => c.every_min) where workspace_id = p_ws;
    if c.key_secret_id is not null then
      perform fed_request(p_ws, case when c.yesterday_done is distinct from today then today - 1 else today end, today, 0);
    end if;
    if exists (select 1 from fed_searches where workspace_id = p_ws and source = 'Grants.gov' and active) then
      perform fed_request_grants(p_ws, 0);
    end if;
    if c.bidmatch_secret_id is not null then perform fed_request_bm(p_ws, 'sub'); end if;
  end if;
  -- bid sources: each once a day at the workspace's hour (5 AM Eastern by default)
  for sid in select id from fed_sources where workspace_id = p_ws and active and kind <> 'manual' and (next_at is null or next_at <= now()) order by id limit 40 loop
    perform src_request(sid);
    update fed_sources set next_at = src_next(p_ws) where id = sid;
  end loop;
  -- contacts for matched grants, a few per tick
  for g in select f.notice_id from fed_notices f
            where f.workspace_id = p_ws and f.source = 'Grants.gov' and f.detail_at is null and f.status in ('New', 'Saved')
              and exists (select 1 from fed_matches m where m.workspace_id = f.workspace_id and m.notice_id = f.notice_id)
              and not exists (select 1 from fed_calls x where x.workspace_id = p_ws and x.source = 'GrantDetail' and x.ref = f.notice_id and x.created_at > now() - interval '1 day')
            order by f.response_deadline nulls last limit 25 loop
    perform fed_request_grant_detail(p_ws, g.notice_id);
  end loop;
  -- housekeeping
  delete from fed_bm_docs where workspace_id = p_ws and created_at < now() - interval '45 days';
  delete from fed_notices f where f.workspace_id = p_ws and f.status = 'New' and f.first_seen < now() - case when f.source = 'BidMatch' then interval '40 days' when f.source = 'Web' then interval '60 days' else interval '21 days' end
     and not exists (select 1 from fed_matches m where m.workspace_id = f.workspace_id and m.notice_id = f.notice_id);
  delete from fed_calls where workspace_id = p_ws and created_at < now() - interval '30 days';
end $$;

create or replace function public.fed_tick() returns void
language plpgsql volatile security definer set search_path = public as $$
declare w uuid;
begin
  for w in select workspace_id from fed_config where ws_has_app_for(workspace_id, 'opportunities')
              and (enabled or exists (select 1 from fed_calls x where x.workspace_id = fed_config.workspace_id and x.status = 'pending')
                   or exists (select 1 from fed_sources y where y.workspace_id = fed_config.workspace_id and y.active)) loop
    begin perform fed_tick_ws(w); exception when others then
      update fed_config set last_error = 'Internal error: ' || sqlerrm where workspace_id = w; end;
  end loop;
end $$;

-- ----- called from the app
create or replace function public.fed_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare w uuid := staff_ws(); c fed_config; has_net boolean; has_cron boolean; has_vault boolean; job boolean := false;
begin
  perform plan_require('opportunities');
  if w is null then raise exception 'Only team members can use Federal opportunities.'; end if;
  select * into c from fed_config where workspace_id = w;
  has_net := exists (select 1 from pg_extension where extname = 'pg_net');
  has_cron := exists (select 1 from pg_extension where extname = 'pg_cron');
  has_vault := exists (select 1 from pg_namespace where nspname = 'vault');
  if has_cron then begin execute 'select exists (select 1 from cron.job where jobname = ''pulse-federal'' and active)' into job; exception when others then job := false; end; end if;
  return jsonb_build_object('configured', c.workspace_id is not null, 'enabled', coalesce(c.enabled, true), 'every_min', coalesce(c.every_min, 60),
    'daily_budget', coalesce(c.daily_budget, 900), 'has_key', c.key_secret_id is not null, 'key_hint', c.key_hint,
    'last_fetch_at', c.last_fetch_at, 'next_fetch_at', c.next_fetch_at, 'last_status', c.last_status, 'last_error', c.last_error,
    'used_today', fed_used_today(w), 'pending', (select count(*) from fed_calls where workspace_id = w and status = 'pending'),
    'notices', (select count(*) from fed_notices where workspace_id = w and source = 'SAM.gov'),
    'has_net', has_net, 'has_cron', has_cron, 'has_vault', has_vault, 'timer', job, 'admin', is_admin(),
    'grants_fetch_at', c.grants_fetch_at, 'grants_error', c.grants_error,
    'has_bidmatch', c.bidmatch_secret_id is not null, 'bidmatch_hint', c.bidmatch_hint, 'bidmatch_fetch_at', c.bidmatch_fetch_at, 'bidmatch_error', c.bidmatch_error,
    'bidmatch', (select count(*) from fed_notices where workspace_id = w and source = 'BidMatch'),
    'grants', (select count(*) from fed_notices where workspace_id = w and source = 'Grants.gov'), 'sources_hour', coalesce(c.sources_hour, 5));
end $$;

create or replace function public.fed_save_config(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare w uuid := staff_ws();
begin
  perform plan_require('opportunities');
  if w is null or not is_admin() then raise exception 'Only admins can change Federal settings.'; end if;
  insert into fed_config (workspace_id) values (w) on conflict do nothing;
  update fed_config set enabled = coalesce((p ->> 'enabled')::boolean, enabled), every_min = coalesce((p ->> 'every_min')::int, every_min),
    daily_budget = coalesce((p ->> 'daily_budget')::int, daily_budget), sources_hour = coalesce((p ->> 'sources_hour')::int, sources_hour),
    next_fetch_at = case when p ?| array['enabled', 'every_min', 'daily_budget'] then null else next_fetch_at end, updated_at = now(), updated_by = member_name()
   where workspace_id = w;
  if p ? 'sources_hour' then update fed_sources set next_at = src_next(w) where workspace_id = w; end if;
  return fed_status();
end $$;

create or replace function public.fed_set_key(p_key text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare w uuid := staff_ws(); c fed_config; k text := trim(coalesce(p_key, '')); sid uuid;
begin
  perform plan_require('opportunities');
  if w is null or not is_admin() then raise exception 'Only admins can change the SAM.gov API key.'; end if;
  if k !~ '^SAM-[0-9A-Za-z-]{20,}$' then raise exception 'That doesn''t look like a SAM.gov public API key (it starts with SAM-).'; end if;
  insert into fed_config (workspace_id) values (w) on conflict do nothing;
  select * into c from fed_config where workspace_id = w;
  begin
    if c.key_secret_id is null then
      execute 'select vault.create_secret($1, $2, $3)' into sid using k, 'pulse-sam-api-key-' || w::text, 'SAM.gov public API key for a Pulse workspace';
    else
      execute 'select vault.update_secret($1, $2)' using c.key_secret_id, k; sid := c.key_secret_id;
    end if;
  exception when undefined_function or invalid_schema_name then
    raise exception 'Supabase Vault isn''t turned on for this database (Database → Extensions → supabase_vault).';
  end;
  update fed_config set key_secret_id = sid, key_hint = '…' || right(k, 4), last_error = null, next_fetch_at = null, updated_at = now(), updated_by = member_name() where workspace_id = w;
  return fed_status();
end $$;

create or replace function public.fed_set_bidmatch(p_link text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare w uuid := staff_ws(); c fed_config; k text := trim(coalesce(p_link, '')); sid uuid;
begin
  perform plan_require('opportunities');
  if w is null or not is_admin() then raise exception 'Only admins can change the MyBidMatch link.'; end if;
  insert into fed_config (workspace_id) values (w) on conflict do nothing;
  select * into c from fed_config where workspace_id = w;
  if k = '' then
    if c.bidmatch_secret_id is not null then begin execute 'delete from vault.secrets where id = $1' using c.bidmatch_secret_id; exception when others then null; end; end if;
    update fed_config set bidmatch_secret_id = null, bidmatch_hint = null where workspace_id = w;
    return fed_status();
  end if;
  k := regexp_replace(k, '^http://', 'https://');
  if k !~* '^https://mybidmatch\.outreachsystems\.com/go\?sub=[0-9a-f-]{36}$' then raise exception 'Paste the link from your MyBidMatch email; it looks like https://mybidmatch.outreachsystems.com/go?sub=…'; end if;
  begin
    if c.bidmatch_secret_id is null then
      execute 'select vault.create_secret($1, $2, $3)' into sid using k, 'pulse-bidmatch-' || w::text, 'MyBidMatch subscriber link for a Pulse workspace';
    else execute 'select vault.update_secret($1, $2)' using c.bidmatch_secret_id, k; sid := c.bidmatch_secret_id; end if;
  exception when undefined_function or invalid_schema_name then
    raise exception 'Supabase Vault isn''t turned on for this database (Database → Extensions → supabase_vault).';
  end;
  update fed_config set bidmatch_secret_id = sid, bidmatch_hint = '…' || right(k, 6), bidmatch_error = null, updated_at = now(), updated_by = member_name() where workspace_id = w;
  if not exists (select 1 from fed_calls where workspace_id = w and source = 'BidMatch' and status = 'pending') then perform fed_request_bm(w, 'sub'); end if;
  return fed_status();
end $$;

create or replace function public.fed_clear_key() returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare w uuid := staff_ws(); sid uuid;
begin
  perform plan_require('opportunities');
  if w is null or not is_admin() then raise exception 'Only admins can change the SAM.gov API key.'; end if;
  select key_secret_id into sid from fed_config where workspace_id = w;
  if sid is not null then begin execute 'delete from vault.secrets where id = $1' using sid; exception when others then null; end; end if;
  update fed_config set key_secret_id = null, key_hint = null, updated_at = now(), updated_by = member_name() where workspace_id = w;
  return fed_status();
end $$;

create or replace function public.fed_run_now() returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare w uuid := staff_ws();
begin
  perform plan_require('opportunities');
  if w is null then raise exception 'Only team members can use Federal opportunities.'; end if;
  if exists (select 1 from fed_calls where workspace_id = w and created_at > now() - interval '2 minutes' and request_id is not null) then
    raise exception 'A check started less than two minutes ago; results arrive within a few minutes.';
  end if;
  insert into fed_config (workspace_id) values (w) on conflict do nothing;
  perform fed_tick_ws(w, true);
  return fed_status();
end $$;

-- how many stored notices (last 21 days) a search would match right now, with a few examples
create or replace function public.fed_preview(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare w uuid := staff_ws(); s fed_searches;
begin
  perform plan_require('opportunities');
  if w is null then raise exception 'Only team members can use Federal opportunities.'; end if;
  s := jsonb_populate_record(null::fed_searches, p || jsonb_build_object('workspace_id', w, 'active', true));
  s.size := coalesce(s.size, 'any'); s.open_only := coalesce(s.open_only, true); s.source := coalesce(s.source, 'SAM.gov'); s.aln := coalesce(s.aln, '{}');
  s.naics := coalesce(s.naics, '{}'); s.agencies := coalesce(s.agencies, '{}'); s.set_asides := coalesce(s.set_asides, '{}');
  s.notice_types := coalesce(s.notice_types, '{}'); s.keywords := coalesce(s.keywords, '{}'); s.exclude := coalesce(s.exclude, '{}');
  return (select jsonb_build_object('count', count(*), 'sample', coalesce((select jsonb_agg(x) from (select n.title, n.agency, n.posted_date from fed_notices n
            where n.workspace_id = w and fed_fits(n, s) order by n.posted_date desc limit 5) x), '[]'))
    from fed_notices n where n.workspace_id = w and fed_fits(n, s));
end $$;

create or replace function public.fed_apply_search(p_id bigint) returns int
language plpgsql volatile security definer set search_path = public as $$
declare w uuid := staff_ws();
begin
  perform plan_require('opportunities');
  if w is null or not exists (select 1 from fed_searches where id = p_id and workspace_id = w) then raise exception 'Search not found.'; end if;
  insert into fed_config (workspace_id) values (w) on conflict do nothing;
  -- first grants search: fetch Grants.gov now instead of waiting for the next scheduled check
  if exists (select 1 from fed_searches where id = p_id and source = 'Grants.gov' and active)
     and not exists (select 1 from fed_notices where workspace_id = w and source = 'Grants.gov')
     and not exists (select 1 from fed_calls where workspace_id = w and source = 'Grants.gov' and created_at > now() - interval '10 minutes') then
    perform fed_request_grants(w, 0);
  end if;
  delete from fed_matches m using fed_searches s, fed_notices n
   where m.search_id = p_id and s.id = p_id and n.workspace_id = w and n.notice_id = m.notice_id and not fed_fits(n, s);
  return fed_rematch(w, p_id);
end $$;

create or replace function public.fed_set_status(p_notices text[], p_status text) returns void
language plpgsql volatile security definer set search_path = public as $$
declare w uuid := staff_ws();
begin
  perform plan_require('opportunities');
  if w is null then raise exception 'Only team members can use Federal opportunities.'; end if;
  if p_status not in ('New', 'Saved', 'Dismissed') then raise exception 'Unknown status.'; end if;
  update fed_notices set status = p_status, status_by = member_name() where workspace_id = w and notice_id = any (p_notices) and status <> 'Added';
end $$;


-- "Contact: Frank M Powers (Contracting Officer), frank.m.powers@uscg.mil, 757-555-0100" lines for record notes
create or replace function public.fed_contacts_text(p jsonb) returns text language sql immutable as $$
  select string_agg('Contact: ' || concat_ws(', ', nullif(concat_ws(' ', c ->> 'name', '(' || coalesce(c ->> 'title', c ->> 'type') || ')'), ''), c ->> 'email', c ->> 'phone'), E'\n')
    from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]' end) c $$;

-- ----- contracting officers into Contacts
-- Saves a notice's contacts (all, or the one with p_email) to the Contacts list; matched by email so nobody is added twice.
create or replace function public.fed_contacts_upsert(p_ws uuid, n public.fed_notices, p_email text default null) returns int
language plpgsql volatile security definer set search_path = public as $$
declare c jsonb; cid bigint; k int := 0; org text; v_role text; line text;
begin
  org := coalesce(nullif(concat_ws(' / ', n.agency, nullif(n.subtier, n.agency)), ''), n.office);
  line := format('From %s: %s%s', case n.source when 'BidMatch' then 'MyBidMatch' else n.source end, n.title, coalesce(' (' || n.sol_number || ')', ''));
  for c in select * from jsonb_array_elements(case when jsonb_typeof(n.contacts) = 'array' then n.contacts else '[]' end) loop
    continue when p_email is not null and lower(coalesce(c ->> 'email', '')) <> lower(p_email);
    continue when coalesce(c ->> 'email', c ->> 'name') is null;
    v_role := coalesce(c ->> 'title', case when n.source = 'Grants.gov' then 'Grants contact' when n.source = 'SAM.gov' or n.level = 'Federal' then 'Contracting Officer' else 'Buyer' end);
    select id into cid from contacts where workspace_id = p_ws
       and ((c ? 'email' and lower(email) = lower(c ->> 'email')) or (not c ? 'email' and lower(name) = lower(c ->> 'name') and organization is not distinct from org))
     order by id limit 1;
    if cid is null then
      insert into contacts (workspace_id, name, organization, role, email, phone, category, source, tags, notes, updated_by)
      values (p_ws, coalesce(c ->> 'name', c ->> 'email'), org, v_role, c ->> 'email', c ->> 'phone', 'Government', 'Opportunities', 'Contracting officer', line, member_name())
      returning id into cid;
    else
      update contacts set name = case when name is null or name = email then coalesce(c ->> 'name', name) else name end,
          phone = coalesce(phone, c ->> 'phone'), role = coalesce(contacts.role, v_role), organization = coalesce(contacts.organization, org),
          notes = case when position(line in coalesce(notes, '')) > 0 then notes else concat_ws(E'\n', notes, line) end, updated_at = now(), updated_by = member_name()
       where id = cid;
    end if;
    k := k + 1; cid := null;
  end loop;
  return k;
end $$;
create or replace function public.fed_save_contact(p_notice text, p_email text default null) returns int
language plpgsql volatile security definer set search_path = public as $$
declare w uuid := staff_ws(); n fed_notices;
begin
  perform plan_require('opportunities');
  if w is null then raise exception 'Only team members can save contacts.'; end if;
  select * into n from fed_notices where workspace_id = w and notice_id = p_notice;
  if not found then raise exception 'Notice not found.'; end if;
  return fed_contacts_upsert(w, n, nullif(p_email, ''));
end $$;

-- ----- the profile: your NAICS codes and keywords (one for contracts, one for grants)
-- Created from your existing searches the first time; the old searches are paused (kept, not deleted).
create or replace function public.fed_profile_ws(p_ws uuid, p_source text) returns public.fed_searches
language plpgsql volatile security definer set search_path = public as $$
declare pr fed_searches;
begin
  select * into pr from fed_searches where workspace_id = p_ws and source = p_source and is_profile;
  if found then return pr; end if;
  insert into fed_searches (workspace_id, name, source, is_profile, match_any, naics, aln, keywords, exclude, agencies, set_asides, notice_types, size, open_only, active)
  select p_ws, case when p_source = 'Grants.gov' then 'My grants profile' else 'My contracts profile' end, p_source, true, true,
     coalesce((select array_agg(distinct x order by x) from fed_searches s, unnest(s.naics) x where s.workspace_id = p_ws and s.source = p_source and s.active), '{}'),
     coalesce((select array_agg(distinct x order by x) from fed_searches s, unnest(s.aln) x where s.workspace_id = p_ws and s.source = p_source and s.active), '{}'),
     coalesce((select array_agg(distinct lower(trim(x))) from fed_searches s, unnest(s.keywords) x where s.workspace_id = p_ws and s.source = p_source and s.active and trim(x) <> ''), '{}'),
     coalesce((select array_agg(distinct lower(trim(x))) from fed_searches s, unnest(s.exclude) x where s.workspace_id = p_ws and s.source = p_source and s.active and trim(x) <> ''), '{}'),
     '{}', '{}',
     case when p_source = 'Grants.gov' then '{Posted,Forecasted}'::text[] else '{Solicitation,"Combined Synopsis/Solicitation",Presolicitation,"Sources Sought"}'::text[] end,
     case when p_source <> 'Grants.gov' and exists (select 1 from fed_searches s where s.workspace_id = p_ws and s.source = p_source and s.active and s.size = 'small') then 'small' else 'any' end,
     true, true
  returning * into pr;
  update fed_searches set active = false where workspace_id = p_ws and source = p_source and not is_profile;
  delete from fed_matches m using fed_searches s where m.search_id = s.id and s.workspace_id = p_ws and s.source = p_source and not s.is_profile;
  perform fed_rematch(p_ws, pr.id);
  return pr;
end $$;
create or replace function public.fed_profile(p_source text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare w uuid := staff_ws();
begin
  perform plan_require('opportunities');
  if w is null then raise exception 'Only team members can use Opportunities.'; end if;
  if p_source not in ('SAM.gov', 'Grants.gov') then raise exception 'Unknown source %', p_source; end if;
  insert into fed_config (workspace_id) values (w) on conflict do nothing;
  return to_jsonb(fed_profile_ws(w, p_source));
end $$;

create or replace function public.fed_add_to_opportunities(p_notice text, p_kind text default null) returns bigint
language plpgsql volatile security definer set search_path = public as $$
declare w uuid := staff_ws(); n fed_notices; oid bigint;
begin
  perform plan_require('opportunities');
  if w is null then raise exception 'Only team members can add opportunities.'; end if;
  select * into n from fed_notices where workspace_id = w and notice_id = p_notice for update;
  if not found then raise exception 'Notice not found.'; end if;
  if n.opportunity_id is not null and exists (select 1 from opportunities where id = n.opportunity_id) then return n.opportunity_id; end if;
  insert into opportunities (workspace_id, title, kind, agency, ref_no, stage, deadline, naics, set_aside, location, url, source, notes, value, meta, updated_by,
      contact_name, contact_email)
  values (w, n.title, coalesce(nullif(p_kind, ''), 'Federal Contract'), concat_ws(' / ', n.agency, n.subtier), n.sol_number, 'Identified',
    (n.response_deadline at time zone 'America/New_York')::date, n.naics, n.set_aside, nullif(concat_ws(', ', n.city, n.state), ''), n.ui_link,
    case when n.source = 'BidMatch' then 'MyBidMatch (' || coalesce(n.level, 'unsorted') || ')' when n.source = 'Link' then 'Added by link' when n.source = 'Web' then coalesce((select name from fed_sources where id = n.src_id), 'Bid source') else n.source end,
    concat_ws(E'\n', 'Notice type: ' || n.notice_type, 'Office: ' || n.office, 'Posted: ' || n.posted_date, 'PSC: ' || n.psc, fed_contacts_text(n.contacts), left(n.summary, 800),
      case when n.awardee is not null then 'Awardee: ' || n.awardee || coalesce(' ($' || to_char(n.award_amount, 'FM999,999,999,990') || ')', '') end),
    n.award_amount, jsonb_build_object('sam_notice_id', n.notice_id), member_name(),
    n.contacts -> 0 ->> 'name', n.contacts -> 0 ->> 'email')
  returning id into oid;
  update fed_notices set status = 'Added', opportunity_id = oid, status_by = member_name() where workspace_id = w and notice_id = p_notice;
  perform fed_contacts_upsert(w, n);
  return oid;
end $$;

-- ---------------------------------------------------------------- Bid sources (any website, RSS feed or JSON API)
-- A company adds the pages and APIs it watches (a utility's tenders page, a development bank's API, a job board…).
-- Every day at the set hour (5 AM Eastern by default) the database fetches each one, reads the listings it finds and
-- publishes them under Contracts → Bid sources, where the source is a filter. Pages that are built by JavaScript or
-- need a sign-in can't be read this way; they become "Check by hand" reminders.
create table if not exists public.fed_sources (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  name text not null, url text not null,
  kind text not null default 'auto' check (kind in ('auto', 'page', 'feed', 'api', 'manual')),
  org text, level text check (level in ('Federal', 'State', 'Local', 'Education', 'International', 'Private', 'Jobs')), country text,
  keep text[] not null default '{}',               -- only keep listings mentioning one of these words (empty = keep all)
  use_profile boolean not null default false,      -- …or one of the company's profile keywords
  date_order text not null default 'DMY' check (date_order in ('DMY', 'MDY')),
  cfg jsonb not null default '{}',                 -- API: {items: "procnotices", title: "bid_description", link: "url" | link_template: "https://…/{id}", deadline, posted, org, country}
  active boolean not null default true,
  detected text, last_fetch_at timestamptz, last_status text, last_error text, last_found int, next_at timestamptz,
  checked_at timestamptz, checked_by text,         -- for "Check by hand" sources
  created_at timestamptz default now(), updated_at timestamptz default now(), updated_by text
);
create index if not exists ix_fed_sources_ws on public.fed_sources (workspace_id);
alter table public.fed_notices add column if not exists src_id bigint references public.fed_sources (id) on delete set null;
-- removing a source removes its listings nobody kept (saved or added ones stay)
create or replace function public.src_on_delete() returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from fed_notices where src_id = old.id and status in ('New', 'Dismissed');
  return old;
end $$;
drop trigger if exists src_on_delete on public.fed_sources;
create trigger src_on_delete before delete on public.fed_sources for each row execute function public.src_on_delete();
alter table public.fed_config add column if not exists sources_hour int not null default 5 check (sources_hour between 0 and 23);
alter table public.fed_sources enable row level security;
revoke all on public.fed_sources from anon;
grant select, insert, update, delete on public.fed_sources to authenticated;
drop policy if exists src_read on public.fed_sources;
create policy src_read on public.fed_sources for select to authenticated using (workspace_id = staff_ws());
drop policy if exists src_write on public.fed_sources;
create policy src_write on public.fed_sources for all to authenticated using (workspace_id = staff_ws()) with check (workspace_id = staff_ws());
drop policy if exists plan_gate on public.fed_sources;
create policy plan_gate on public.fed_sources as restrictive for all to authenticated using (public.ws_has_app('opportunities')) with check (public.ws_has_app('opportunities'));

-- text helpers
create or replace function public.src_text(p text) returns text language sql immutable as $$
  select nullif(trim(regexp_replace(replace(replace(replace(replace(replace(replace(regexp_replace(coalesce(p, ''), '<[^>]*>', ' ', 'g'),
    '&nbsp;', ' '), '&amp;', '&'), '&#039;', ''''), '&quot;', '"'), '&lt;', '<'), '&gt;', '>'), '\s+', ' ', 'g')), '') $$;
create or replace function public.src_abs(p_href text, p_base text) returns text language sql immutable as $$
  select case when p_href is null or p_href ~* '^(javascript:|mailto:|tel:|#)' then null
              when p_href ~* '^https?://' then p_href
              when p_href like '//%' then 'https:' || p_href
              when p_href like '/%' then substring(p_base from '^(https?://[^/]+)') || p_href
              else regexp_replace(regexp_replace(p_base, '[?#].*$', ''), '[^/]*$', '') || p_href end $$;
-- every date written in a piece of text: 2026-11-07, 07/11/2026, 7 November 2026, November 7, 2026, 07-Nov-2026
create or replace function public.src_dates(p text, p_order text default 'DMY') returns date[] language plpgsql immutable as $$
declare out date[] := '{}'; m text[]; d date; a int; b int;
begin
  for m in select regexp_matches(coalesce(p, ''), '(\d{4})-(\d{1,2})-(\d{1,2})', 'g') loop
    begin out := out || make_date(m[1]::int, m[2]::int, m[3]::int); exception when others then null; end; end loop;
  -- 06/11/2025: day first or month first? A weekday next to it ("Wed, 06/11/2025") settles it; otherwise the source's setting
  for m in select regexp_matches(coalesce(p, ''), '(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?,?\s*)?\m(\d{1,2})[/.](\d{1,2})[/.](\d{4})\M', 'gi') loop
    a := m[2]::int; b := m[3]::int;
    begin
      if a > 12 then d := make_date(m[4]::int, b, a);
      elsif b > 12 then d := make_date(m[4]::int, a, b);
      elsif m[1] is not null and to_char(make_date(m[4]::int, a, b), 'Dy') ilike left(m[1], 3) then d := make_date(m[4]::int, a, b);
      elsif m[1] is not null and to_char(make_date(m[4]::int, b, a), 'Dy') ilike left(m[1], 3) then d := make_date(m[4]::int, b, a);
      elsif p_order = 'MDY' then d := make_date(m[4]::int, a, b); else d := make_date(m[4]::int, b, a); end if;
      out := out || d;
    exception when others then null; end; end loop;
  for m in select regexp_matches(coalesce(p, ''), '\m(\d{1,2})(?:st|nd|rd|th)?[ -]+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?,?[ -]+(\d{4})', 'gi') loop
    begin out := out || to_date(m[1] || ' ' || left(m[2], 3) || ' ' || m[3], 'DD Mon YYYY'); exception when others then null; end; end loop;
  for m in select regexp_matches(coalesce(p, ''), '\m(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})', 'gi') loop
    begin out := out || to_date(m[2] || ' ' || left(m[1], 3) || ' ' || m[3], 'DD Mon YYYY'); exception when others then null; end; end loop;
  return (select coalesce(array_agg(x order by x), '{}') from unnest(out) x where x between date '2000-01-01' and date '2100-01-01');
end $$;

-- does a listing pass the source's word filter?
create or replace function public.src_keep(s public.fed_sources, p_text text) returns boolean language sql stable security definer set search_path = public as $$
  select (cardinality(s.keep) = 0 and not s.use_profile)
      or exists (select 1 from unnest(s.keep) k where p_text ilike '%' || trim(k) || '%' and trim(k) <> '')
      or (s.use_profile and exists (select 1 from fed_profile_ws(s.workspace_id, 'SAM.gov') pr, unnest(pr.keywords) k where p_text ilike '%' || fed_stem(k) || '%')) $$;

-- words that make a link look like a tender, bid, call or job (used when a page has no table of listings)
create or replace function public.src_looks_like(p text) returns boolean language sql immutable as $$
  select p ~* '(tender|bid|rfp|rfq|rfi|eoi|expression[s]? of interest|request for|procure|quotation|proposal|solicitation|consult|invitation|prequalif|supply|construction|framework|contract|vacanc|recruit|job|position|engineer|manager|officer|analyst|specialist|technician|call for)' $$;

-- read listings out of one fetched page / feed / API answer and store them; returns how many were found
create or replace function public.src_store(p_src bigint, p_body text, p_ctype text default '') returns int
language plpgsql volatile security definer set search_path = public as $$
declare s fed_sources; items jsonb := '[]'; v_kind text; j jsonb; arr jsonb; it jsonb; r text; m text[]; t text; l text; dd date[]; n int := 0;
  seen text[] := '{}'; key text; js boolean; cells text[]; atxt text; rowtxt text; ph text; em text; nm text; nc text[]; ct jsonb;
begin
  select * into s from fed_sources where id = p_src;
  v_kind := case when s.kind <> 'auto' then s.kind
               when p_ctype ~* 'json' or left(ltrim(p_body), 1) in ('{', '[') then 'api'
               when p_ctype ~* '(rss|atom|xml)' or left(ltrim(p_body), 200) ~* '<(rss|feed|rdf)' then 'feed' else 'page' end;
  if v_kind = 'api' then
    j := p_body::jsonb;
    -- the array of listings: the configured key, or the biggest array of objects in the answer
    arr := case when s.cfg ? 'items' then j #> string_to_array(s.cfg ->> 'items', '.') when jsonb_typeof(j) = 'array' then j end;
    if arr is null then
      select v into arr from jsonb_each(j) e(k, v) where jsonb_typeof(v) = 'array' order by jsonb_array_length(v) desc limit 1;
      if arr is null then select v2 into arr from jsonb_each(j) e(k, v), jsonb_each(case when jsonb_typeof(v) = 'object' then v else '{}' end) e2(k2, v2)
                          where jsonb_typeof(v2) = 'array' order by jsonb_array_length(v2) desc limit 1; end if;
    end if;
    for it in select * from jsonb_array_elements(coalesce(arr, '[]')) limit 300 loop
      if jsonb_typeof(it) <> 'object' then continue; end if;
      t := coalesce(it ->> (s.cfg ->> 'title'), (select v #>> '{}' from jsonb_each(it) e(k, v) where lower(k) = any (array['title', 'subject', 'bid_description', 'name', 'headline', 'notice_title', 'description', 'project_name'])
                 and jsonb_typeof(v) = 'string' order by array_position(array['title', 'subject', 'bid_description', 'name', 'headline', 'notice_title', 'description', 'project_name'], lower(k)) limit 1));
      l := coalesce(it ->> (s.cfg ->> 'link'), (select v #>> '{}' from jsonb_each(it) e(k, v) where k ~* '^(url|link|href|uri|web_url|notice_url)$' limit 1));
      if l is null and s.cfg ? 'link_template' then
        l := s.cfg ->> 'link_template';
        for m in select regexp_matches(l, '\{([a-zA-Z0-9_]+)\}', 'g') loop l := replace(l, '{' || m[1] || '}', coalesce(it ->> m[1], '')); end loop;
      end if;
      items := items || jsonb_build_object('title', src_text(t), 'link', src_abs(l, s.url),
        'deadline', coalesce(it ->> (s.cfg ->> 'deadline'), (select v #>> '{}' from jsonb_each(it) e(k, v) where k ~* '(deadline|submission|closing|close_?date|due)' limit 1)),
        'posted', coalesce(it ->> (s.cfg ->> 'posted'), (select v #>> '{}' from jsonb_each(it) e(k, v) where k ~* '(noticedate|posted|publish|release|created|^date$)' limit 1)),
        'org', coalesce(it ->> (s.cfg ->> 'org'), (select v #>> '{}' from jsonb_each(it) e(k, v) where k ~* '(agency|organi[sz]ation|buyer|owner|client)' and jsonb_typeof(v) = 'string' limit 1)),
        'country', coalesce(it ->> (s.cfg ->> 'country'), (select v #>> '{}' from jsonb_each(it) e(k, v) where k ~* '(country|ctry|location|state)' and jsonb_typeof(v) = 'string' limit 1)),
        'text', left(src_text(concat_ws(' ', it ->> 'notice_type', it ->> 'procurement_method_name', it ->> 'bid_reference_no', it ->> 'summary', it ->> 'snippet')), 600),
        'ref', coalesce(it ->> 'bid_reference_no', it ->> 'reference', it ->> 'ref', it ->> 'id'));
    end loop;
  elsif v_kind = 'feed' then
    for r in select x from regexp_split_to_table(p_body, '(?i)<(item|entry)[\s>]') with ordinality z(x, i) where i > 1 limit 300 loop
      t := src_text(substring(r from '(?is)<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</title>'));
      l := coalesce(src_text(substring(r from '(?is)<link[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</link>')), substring(r from '(?is)<link[^>]*href="([^"]+)"'));
      items := items || jsonb_build_object('title', t, 'link', src_abs(l, s.url),
        'posted', src_text(substring(r from '(?is)<(?:pubDate|published|updated|dc:date)[^>]*>(.*?)</')),
        'text', left(src_text(substring(r from '(?is)<(?:description|summary|content)[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</')), 600));
    end loop;
  else
    -- web page: rows of tables first (title + dates + first link in the row), then links that look like listings
    for r in select x from regexp_split_to_table(p_body, '(?i)<tr[\s>]') with ordinality z(x, i) where i > 1 limit 400 loop
      r := split_part(regexp_replace(r, '</tr\s*>', '</tr>', 'gi'), '</tr>', 1);
      if r ~* '<th[\s>]' then continue; end if;
      -- the row's cells as plain text (the tag of each cell, with its attributes, is dropped whole)
      cells := array(select x from (select src_text(c) x, o from regexp_split_to_table(r, '(?i)<t[dh](\s[^>]*)?>') with ordinality z(c, o)) q where o > 1 and x is not null order by o);
      rowtxt := array_to_string(cells, ' · ');
      if rowtxt is null or length(rowtxt) < 15 then continue; end if;
      l := src_abs(substring(r from '(?is)<a\s[^>]*href\s*=\s*["'']([^"'']+)'), s.url);
      -- the title: the row's link text if it reads like one, otherwise the longest cell
      atxt := src_text(regexp_replace(split_part(regexp_replace(coalesce(substring(r from '(?is)(<a\s.*)'), ''), '</a\s*>', '</a>', 'gi'), '</a>', 1), '^<a[^>]*>', ''));
      t := case when length(atxt) >= 15 then atxt else (select x from unnest(cells) x order by length(x) desc limit 1) end;
      -- contact and NAICS codes when the row has them
      ph := substring(rowtxt from '(\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4})');
      em := substring(rowtxt from '([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})');
      nm := (select x from unnest(cells) with ordinality q(x, o) where length(x) between 4 and 40 and x ~ '^[A-Z][a-z]+( [A-Z][a-z.''-]+){1,3}$'
              and o > 1 and o < cardinality(cells) + 1 order by o desc limit 1);
      nc := array(select distinct g[1] from regexp_matches(rowtxt, '\m([1-9]\d{5})\M\s*[:–-]', 'g') g);
      items := items || jsonb_build_object('title', t, 'link', l, 'text', left(coalesce(nullif(trim(both ' ·' from replace(rowtxt, t, '')), ''), rowtxt), 900), 'row', true, 'naics', to_jsonb(nc),
                                           'contact', case when ph is not null or em is not null then jsonb_build_object('name', nm, 'phone', ph, 'email', em) end);
    end loop;
    for r in select x from regexp_split_to_table(p_body, '(?i)<a\s') with ordinality z(x, i) where i > 1 limit 2000 loop
      l := src_abs(substring(r from '^[^>]*href\s*=\s*["'']([^"'']+)'), s.url);
      r := regexp_replace(r, '</a\s*>', '</a>', 'gi');
      t := src_text(regexp_replace(split_part(r, '</a>', 1), '^[^>]*>', ''));
      if l is null or t is null or length(t) < 20 or length(t) > 400 then continue; end if;
      if not (src_looks_like(t) or l ~* '\.(pdf|docx?|zip)(\?|$)') then continue; end if;
      if l ~* '(facebook|twitter|linkedin|instagram|youtube|whatsapp|tiktok)\.com|//(www\.)?x\.com|/sharer?[./?]' then continue; end if;
      items := items || jsonb_build_object('title', t, 'link', l, 'text', left(src_text(left(split_part(r, '</a>', 2), 500)), 300));
    end loop;
  end if;
  -- store
  for it in select * from jsonb_array_elements(items) loop
    t := left(it ->> 'title', 400); l := it ->> 'link';
    if t is null or length(t) < 8 then continue; end if;
    key := lower(coalesce(l, t));
    if key = any (seen) then continue; end if;
    seen := seen || key;
    if not src_keep(s, concat_ws(' ', t, it ->> 'text')) then continue; end if;
    dd := src_dates(concat_ws(' ', it ->> 'deadline', case when (it ->> 'deadline') is null then it ->> 'text' end), s.date_order);
    nc := array(select jsonb_array_elements_text(coalesce(it -> 'naics', '[]')));
    ct := case when it -> 'contact' is not null and jsonb_typeof(it -> 'contact') = 'object' then jsonb_build_array(jsonb_strip_nulls(it -> 'contact')) else '[]' end;
    insert into fed_notices as f (workspace_id, notice_id, source, src_id, title, agency, notice_type, level, state, posted_date, response_deadline, ui_link, summary, sol_number, status, active, naics, naics_all, contacts)
    values (s.workspace_id, 'W' || s.id || '-' || left(md5(key), 14), 'Web', s.id, t, coalesce(nullif(it ->> 'org', ''), s.org, s.name),
            case when s.level = 'Jobs' then 'Job' else 'Listing' end, s.level, coalesce(nullif(it ->> 'country', ''), s.country),
            coalesce((src_dates(it ->> 'posted', s.date_order))[1], fed_anydate(it ->> 'posted'), (now() at time zone 'America/New_York')::date),
            case when dd[array_length(dd, 1)] >= current_date - 365 then (dd[array_length(dd, 1)] + time '23:59') at time zone 'America/New_York' end,
            coalesce(l, s.url), nullif(it ->> 'text', ''), nullif(left(it ->> 'ref', 120), ''), 'New', true, nc[1], coalesce(nc, '{}'), ct)
    on conflict (workspace_id, notice_id) do update set title = excluded.title, response_deadline = coalesce(excluded.response_deadline, f.response_deadline),
        summary = excluded.summary, naics = coalesce(excluded.naics, f.naics), naics_all = case when cardinality(excluded.naics_all) > 0 then excluded.naics_all else f.naics_all end,
        contacts = case when jsonb_array_length(excluded.contacts) > 0 and jsonb_array_length(f.contacts) = 0 then excluded.contacts else f.contacts end, updated_at = now()
      where (f.title, f.response_deadline, f.summary, f.naics, f.contacts) is distinct from (excluded.title, coalesce(excluded.response_deadline, f.response_deadline), excluded.summary,
             coalesce(excluded.naics, f.naics), case when jsonb_array_length(excluded.contacts) > 0 and jsonb_array_length(f.contacts) = 0 then excluded.contacts else f.contacts end);
    n := n + 1;
  end loop;
  js := n = 0 and v_kind = 'page' and (p_body ~* '(_adf\.|OA_HTML|enable javascript|javascript is required|__NEXT_DATA__|ng-app|id="root"></div>|data-reactroot|cf-browser-verification|captcha)' or length(src_text(p_body)) < 600);
  update fed_sources set detected = v_kind, last_fetch_at = now(), last_found = n, last_error = null,
         last_status = case when n > 0 then format('%s listing%s found', n, case when n = 1 then '' else 's' end)
                            when js then 'This site builds its page with JavaScript or needs a sign-in, so Pulse can''t read it. Set it to "Check by hand", or use the site''s email alerts.'
                            else 'Read the page but found no listings' || case when cardinality(s.keep) > 0 or s.use_profile then ' matching your words' else '' end end
   where id = s.id;
  return n;
exception when others then
  update fed_sources set last_fetch_at = now(), last_error = 'Could not read it: ' || sqlerrm, last_status = null where id = p_src;
  return 0;
end $$;

-- ask for one source (async through pg_net, like the other fetches)
create or replace function public.src_request(p_src bigint) returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare s fed_sources; rid bigint;
begin
  select * into s from fed_sources where id = p_src;
  if not found or s.kind = 'manual' then return false; end if;
  execute 'select net.http_get(url := $1, headers := $2, timeout_milliseconds := 60000)' into rid
    using s.url, jsonb_build_object('User-Agent', 'Mozilla/5.0 (compatible; PulseBidReader/1.0; +https://bluecredits.org)', 'Accept', 'text/html,application/json,application/xml;q=0.9,*/*;q=0.8');
  insert into fed_calls (workspace_id, request_id, source, ref) values (s.workspace_id, rid, 'Source', s.id::text);
  update fed_sources set last_status = 'Checking…' where id = s.id;
  return true;
exception when undefined_function or invalid_schema_name or undefined_table then
  update fed_sources set last_error = 'The database extension for fetching (pg_net) is not turned on.' where id = p_src;
  return false;
end $$;

-- the next run time: the workspace's hour (Eastern), tomorrow if today's has passed
create or replace function public.src_next(p_ws uuid) returns timestamptz language sql stable set search_path = public as $$
  select case when x > now() then x else x + interval '1 day' end
    from (select ((now() at time zone 'America/New_York')::date + make_interval(hours => coalesce((select sources_hour from fed_config where workspace_id = p_ws), 5))) at time zone 'America/New_York' x) z $$;

-- check one source now (from the Bid sources page)
create or replace function public.src_check(p_src bigint) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare s fed_sources;
begin
  perform plan_require('opportunities');
  select * into s from fed_sources where id = p_src and workspace_id = staff_ws();
  if not found then raise exception 'Source not found.'; end if;
  if s.kind = 'manual' then
    update fed_sources set checked_at = now(), checked_by = member_name() where id = s.id;
    return jsonb_build_object('state', 'checked');
  end if;
  insert into fed_config (workspace_id) values (s.workspace_id) on conflict do nothing;
  return jsonb_build_object('state', case when src_request(s.id) then 'fetching' else 'error' end);
end $$;
-- poll while checking: collect answers, then report
create or replace function public.src_poll(p_src bigint) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare s fed_sources;
begin
  if staff_ws() is null then raise exception 'Only team members can do this.'; end if;
  perform fed_tick_ws(staff_ws());
  select * into s from fed_sources where id = p_src and workspace_id = staff_ws();
  return jsonb_build_object('pending', exists (select 1 from fed_calls where workspace_id = s.workspace_id and source = 'Source' and ref = s.id::text and status = 'pending'),
                            'status', s.last_status, 'error', s.last_error, 'found', s.last_found, 'detected', s.detected);
end $$;
revoke execute on function public.src_store(bigint, text, text), public.src_request(bigint), public.src_check(bigint), public.src_poll(bigint) from public, anon;
grant execute on function public.src_check(bigint), public.src_poll(bigint) to authenticated;

-- ---------------------------------------------------------------- Add by link
-- Paste a SAM.gov or Grants.gov link and Pulse fetches that one notice; any other link (state portals, eVA, foundations…)
-- is saved with the details the person types. Everything added this way lands under Saved.
create or replace function public.fed_anydate(p text) returns date language plpgsql immutable as $$
declare f text;
begin
  if coalesce(trim(p), '') = '' then return null; end if;
  foreach f in array array['Mon DD, YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'MonDD,YYYY'] loop
    begin return to_date(left(trim(p), 12), f); exception when others then null; end;
  end loop;
  return null;
end $$;

create or replace function public.fed_link_parse(p_url text) returns jsonb language sql immutable as $$
  select case
    when p_url ~* 'sam\.gov/(workspace/contract/)?opp/[0-9a-f]{32}' then jsonb_build_object('source', 'SAM.gov', 'id', lower(substring(p_url from '(?i)opp/([0-9a-f]{32})')))
    when p_url ~* 'grants\.gov/.*(search-results-detail/|oppid=)[0-9]+' then jsonb_build_object('source', 'Grants.gov', 'id', 'G' || substring(p_url from '(?i)(?:search-results-detail/|oppid=)([0-9]+)'))
    else jsonb_build_object('source', 'Link', 'id', 'L' || left(md5(lower(regexp_replace(trim(p_url), '[#?].*$', ''))), 16)) end $$;

create or replace function public.fed_request_notice(p_ws uuid, p_notice text) returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare c fed_config; k text; rid bigint; today date := (now() at time zone 'America/New_York')::date;
begin
  select * into c from fed_config where workspace_id = p_ws;
  if c.key_secret_id is null then return false; end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where id = $1' into k using c.key_secret_id;
  if k is null then return false; end if;
  execute 'select net.http_get(url := $1, params := $2, timeout_milliseconds := 120000)' into rid
    using coalesce(nullif(c.sam_relay_url, ''), 'https://api.sam.gov/opportunities/v2/search'),
          jsonb_build_object('api_key', k, 'noticeid', p_notice, 'postedFrom', to_char(today - 364, 'MM/DD/YYYY'), 'postedTo', to_char(today, 'MM/DD/YYYY'), 'limit', '5', 'offset', '0');
  insert into fed_calls (workspace_id, request_id, source, ref) values (p_ws, rid, 'SAM.gov', 'link:' || p_notice);
  return true;
exception when undefined_function or invalid_schema_name or undefined_table then return false;
end $$;

-- p: {url, title, agency, deadline (date), kind, notes} — title etc. are only needed for links other than SAM.gov and Grants.gov
create or replace function public.fed_add_link(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare w uuid := staff_ws(); url text := trim(coalesce(p ->> 'url', '')); lk jsonb; nid text; src text; ok boolean;
begin
  perform plan_require('opportunities');
  if w is null then raise exception 'Only team members can add opportunities.'; end if;
  if url !~* '^https?://[^ ]+\.[^ ]+' then raise exception 'Paste a full link that starts with https://'; end if;
  lk := fed_link_parse(url); src := lk ->> 'source'; nid := lk ->> 'id';
  if coalesce((p ->> 'manual')::boolean, false) and src <> 'Link' then src := 'Link'; nid := 'L' || left(md5(lower(regexp_replace(url, '[#?].*$', ''))), 16); end if;
  if exists (select 1 from fed_notices where workspace_id = w and notice_id = nid) then
    update fed_notices set status = 'Saved', status_by = member_name() where workspace_id = w and notice_id = nid and status in ('New', 'Dismissed');
    return jsonb_build_object('state', 'ready', 'source', src, 'notice_id', nid, 'status', (select status from fed_notices where workspace_id = w and notice_id = nid));
  end if;
  if src = 'SAM.gov' then
    ok := fed_request_notice(w, nid);
    if not ok then return jsonb_build_object('state', 'no_key', 'source', src, 'notice_id', nid); end if;
    return jsonb_build_object('state', 'fetching', 'source', src, 'notice_id', nid);
  elsif src = 'Grants.gov' then
    insert into fed_notices (workspace_id, notice_id, source, title, ui_link, status, status_by, active)
    values (w, nid, 'Grants.gov', 'Grants.gov opportunity ' || substring(nid from 2), 'https://www.grants.gov/search-results-detail/' || substring(nid from 2), 'Saved', member_name(), true);
    if not fed_request_grant_detail(w, nid) then
      update fed_notices set detail_at = now() where workspace_id = w and notice_id = nid;
      return jsonb_build_object('state', 'ready', 'source', src, 'notice_id', nid, 'status', 'Saved');
    end if;
    return jsonb_build_object('state', 'fetching', 'source', src, 'notice_id', nid);
  end if;
  if coalesce(trim(p ->> 'title'), '') = '' then return jsonb_build_object('state', 'need_details', 'source', src, 'notice_id', nid); end if;
  insert into fed_notices (workspace_id, notice_id, source, title, agency, notice_type, level, response_deadline, posted_date, ui_link, summary, sol_number, status, status_by, active)
  values (w, nid, 'Link', left(trim(p ->> 'title'), 400), nullif(trim(p ->> 'agency'), ''), nullif(trim(p ->> 'kind'), ''),
          case when p ->> 'kind' ~* 'federal' then 'Federal' when p ->> 'kind' ~* 'state' then 'State' when p ->> 'kind' ~* 'local|city|county' then 'Local' when p ->> 'kind' ~* 'educat|universit|school' then 'Education' end,
          (nullif(p ->> 'deadline', '')::date + time '23:59') at time zone 'America/New_York', (now() at time zone 'America/New_York')::date, url,
          nullif(trim(p ->> 'notes'), ''), nullif(trim(p ->> 'ref'), ''), 'Saved', member_name(), true);
  return jsonb_build_object('state', 'ready', 'source', src, 'notice_id', nid, 'status', 'Saved');
end $$;

-- while a SAM.gov or Grants.gov link is being fetched: collect answers now, then say where it stands
create or replace function public.fed_link_check(p_notice text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare w uuid := staff_ws(); n fed_notices; cl fed_calls;
begin
  if w is null then raise exception 'Only team members can add opportunities.'; end if;
  perform fed_tick_ws(w);
  select * into n from fed_notices where workspace_id = w and notice_id = p_notice;
  select * into cl from fed_calls where workspace_id = w and (ref = 'link:' || p_notice or (source = 'GrantDetail' and ref = p_notice)) order by id desc limit 1;
  if n.notice_id is not null and (n.source <> 'Grants.gov' or n.detail_at is not null) then
    return jsonb_build_object('state', 'ready', 'title', n.title, 'source', n.source, 'status', n.status);
  end if;
  if cl.status = 'error' then return jsonb_build_object('state', 'error', 'error', cl.error, 'title', n.title); end if;
  return jsonb_build_object('state', 'fetching');
end $$;
revoke execute on function public.fed_add_link(jsonb), public.fed_link_check(text), public.fed_request_notice(uuid, text) from public, anon;
grant execute on function public.fed_add_link(jsonb), public.fed_link_check(text) to authenticated;

-- matched notices for the inbox, newest first or soonest due
drop function if exists public.fed_list(text, bigint, text, int);
create or replace function public.fed_list(p_source text default 'SAM.gov', p_status text default 'New', p_search bigint default null, p_sort text default 'posted', p_limit int default 400) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by case when p_sort = 'due' then x.response_deadline end nulls last, x.posted_date desc nulls last, x.first_seen desc), '[]')
  from (select n.notice_id, n.title, n.sol_number, n.agency, n.subtier, n.office, n.notice_type, n.posted_date, n.response_deadline, n.naics, n.set_aside,
               n.set_aside_code, n.state, n.city, n.ui_link, n.award_amount, n.awardee, n.status, n.opportunity_id, n.funding_id, n.first_seen, n.source, n.aln, n.level, left(n.summary, 6000) summary, n.naics_all, n.psc, n.bm_keywords, n.src_id,
               (select coalesce(jsonb_agg(c || coalesce((select jsonb_build_object('cid', ct.id) from contacts ct where ct.workspace_id = n.workspace_id
                    and c ? 'email' and lower(ct.email) = lower(c ->> 'email') limit 1), '{}')), '[]') from jsonb_array_elements(n.contacts) c) contacts,
               (select array_agg(m.search_id) from fed_matches m where m.workspace_id = n.workspace_id and m.notice_id = n.notice_id) searches
          from fed_notices n
         where n.workspace_id = staff_ws() and ws_has_app('opportunities') and n.source = coalesce(p_source, 'SAM.gov') and (p_status = 'All' or n.status = p_status)
           and ((n.source in ('BidMatch', 'Web', 'Link') and p_search is null) or (n.status <> 'New' and p_search is null)
                or exists (select 1 from fed_matches m where m.workspace_id = n.workspace_id and m.notice_id = n.notice_id and (p_search is null or m.search_id = p_search)))
         order by case when p_sort = 'due' then n.response_deadline end nulls last, n.posted_date desc nulls last, n.first_seen desc
         limit least(greatest(coalesce(p_limit, 400), 1), 1000)) x $$;
-- new (unreviewed) matches, in total and per search
create or replace function public.fed_counts() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('new', (select count(distinct n.notice_id) from fed_notices n join fed_matches m on m.workspace_id = n.workspace_id and m.notice_id = n.notice_id
                                     where n.workspace_id = staff_ws() and ws_has_app('opportunities') and n.status = 'New'),
    'by_source', coalesce((select jsonb_object_agg(source, c) from (select n.source, count(*) c from fed_notices n
                                     where n.workspace_id = staff_ws() and ws_has_app('opportunities') and n.status = 'New'
                                       and (n.source in ('BidMatch', 'Web') or exists (select 1 from fed_matches m where m.workspace_id = n.workspace_id and m.notice_id = n.notice_id))
                                     group by n.source) z), '{}'),
    'by_search', coalesce((select jsonb_object_agg(search_id, c) from (select m.search_id, count(*) c from fed_matches m join fed_notices n on n.workspace_id = m.workspace_id and n.notice_id = m.notice_id
                                     where m.workspace_id = staff_ws() and ws_has_app('opportunities') and n.status = 'New' group by m.search_id) z), '{}')) $$;
revoke execute on function public.fed_list(text, text, bigint, text, int), public.fed_counts() from public, anon;
grant execute on function public.fed_list(text, text, bigint, text, int), public.fed_counts() to authenticated;

-- a grant goes to the Funding app (status Identified)
create or replace function public.fed_add_to_funding(p_notice text) returns bigint
language plpgsql volatile security definer set search_path = public as $$
declare w uuid := staff_ws(); n fed_notices; fid bigint;
begin
  perform plan_require('opportunities');
  if w is null then raise exception 'Only team members can add funding.'; end if;
  select * into n from fed_notices where workspace_id = w and notice_id = p_notice for update;
  if not found then raise exception 'Grant not found.'; end if;
  if n.funding_id is not null and exists (select 1 from funding where id = n.funding_id) then return n.funding_id; end if;
  insert into funding (workspace_id, name, organization, type, status, deadline, url, source, notes, updated_by, contact_email)
  values (w, n.title, n.agency, 'Grant', 'Identified', (n.response_deadline at time zone 'America/New_York')::date, n.ui_link, 'Grants.gov',
    concat_ws(E'\n', 'Opportunity number: ' || n.sol_number, 'Status: ' || n.notice_type, 'Posted: ' || n.posted_date,
      case when cardinality(n.aln) > 0 then 'Assistance listing: ' || array_to_string(n.aln, ', ') end, fed_contacts_text(n.contacts)), member_name(),
    n.contacts -> 0 ->> 'email')
  returning id into fid;
  update fed_notices set status = 'Added', funding_id = fid, status_by = member_name() where workspace_id = w and notice_id = p_notice;
  perform fed_contacts_upsert(w, n);
  return fid;
end $$;
revoke execute on function public.fed_add_to_funding(text), public.fed_store_grants(uuid, jsonb), public.fed_request_grants(uuid, int), public.fed_date(text), public.fed_set_bidmatch(text) from public, anon;
revoke execute on function public.fed_store_bm(uuid, text, text, int, text), public.fed_request_bm(uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.fed_set_bidmatch(text) to authenticated;
revoke execute on function public.fed_store_grants(uuid, jsonb), public.fed_request_grants(uuid, int) from authenticated;
grant execute on function public.fed_add_to_funding(text) to authenticated;

revoke execute on function public.fed_fits(public.fed_notices, public.fed_searches), public.fed_rematch(uuid, bigint, timestamptz), public.fed_store(uuid, jsonb),
  public.fed_used_today(uuid), public.fed_request(uuid, date, date, int), public.fed_tick_ws(uuid, boolean), public.fed_tick(),
  public.fed_ts(text), public.fed_num(text) from public, anon, authenticated;
revoke execute on function public.fed_status(), public.fed_save_config(jsonb), public.fed_set_key(text), public.fed_clear_key(), public.fed_run_now(),
  public.fed_preview(jsonb), public.fed_apply_search(bigint), public.fed_set_status(text[], text), public.fed_add_to_opportunities(text, text) from public, anon;
grant execute on function public.fed_status(), public.fed_save_config(jsonb), public.fed_set_key(text), public.fed_clear_key(), public.fed_run_now(),
  public.fed_preview(jsonb), public.fed_apply_search(bigint), public.fed_set_status(text[], text), public.fed_add_to_opportunities(text, text) to authenticated;

revoke execute on function public.fed_contacts_upsert(uuid, public.fed_notices, text), public.fed_profile_ws(uuid, text),
  public.fed_request_grant_detail(uuid, text), public.fed_store_grant_detail(uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.fed_save_contact(text, text), public.fed_profile(text) from public, anon;
grant execute on function public.fed_save_contact(text, text), public.fed_profile(text) to authenticated;
-- every workspace that uses Opportunities gets its profiles (built from its searches)
select public.fed_profile_ws(c.workspace_id, x.src) from public.fed_config c, (values ('SAM.gov'), ('Grants.gov')) x(src);

-- =====================================================================
-- Documents: policies (with read-and-certify), invoices and the compliance calendar.
--   * Policies are part of Starter: every company needs them. Admins write or load them; once Published, the people
--     they apply to certify they have read them (one click and their typed name; a new version asks again).
--   * Invoices are part of Pro: built from projects and approved timecard hours, numbered, printed, marked paid. Admins only.
--   * The compliance calendar lists licenses, registrations, filings and postings with due dates. Staff can see it; admins edit.
-- =====================================================================
create table if not exists public.doc_policies (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  title text not null,
  category text not null default 'Workplace' check (category in ('Workplace', 'Employee relations', 'Safety and health', 'Ethics and conduct', 'Finance', 'Data and IT', 'Benefits and leave', 'Other')),
  summary text, body text,                          -- body is Markdown
  owner_title text,                                 -- who keeps it current, e.g. "CEO / People"
  audience text not null default 'Everyone' check (audience in ('Everyone', 'Staff', 'Contractors')),
  requires_ack boolean not null default true,
  status text not null default 'Draft' check (status in ('Draft', 'Published', 'Retired')),
  version int not null default 1,
  effective_date date, review_months int default 12, next_review date,
  published_at timestamptz, source text,            -- 'library:<key>' or 'import'
  created_at timestamptz default now(), updated_at timestamptz default now(), updated_by text
);
create index if not exists ix_docpol_ws on public.doc_policies (workspace_id, status);

create table if not exists public.doc_policy_acks (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  policy_id bigint not null references public.doc_policies (id) on delete cascade,
  version int not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  name_typed text not null, acked_at timestamptz not null default now(), ip text,
  unique (policy_id, version, user_id)
);
create index if not exists ix_docack_user on public.doc_policy_acks (user_id);

create table if not exists public.inv_invoices (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  seq int not null, number text not null,
  contact_id bigint references public.contacts (id) on delete set null,
  client_name text not null, client_email text, client_address text,
  project_id bigint references public.projects (id) on delete set null,
  reference text,                                   -- PO / contract number
  issue_date date not null default current_date, due_date date,
  currency text not null default 'USD',
  items jsonb not null default '[]',                -- [{description, qty, rate}]
  tax_rate numeric not null default 0, discount numeric not null default 0,
  notes text, terms text,
  status text not null default 'Draft' check (status in ('Draft', 'Sent', 'Paid', 'Void')),
  sent_at timestamptz, paid_at date, paid_amount numeric, paid_note text,
  created_at timestamptz default now(), updated_at timestamptz default now(), updated_by text,
  unique (workspace_id, seq)
);
create index if not exists ix_inv_ws on public.inv_invoices (workspace_id, status, due_date);

create table if not exists public.doc_compliance (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  title text not null,
  category text not null default 'Registration' check (category in ('Registration', 'License', 'Tax', 'Insurance', 'Safety and health', 'Employment', 'Posting', 'Certification', 'Other')),
  authority text, reference text, due_date date,
  repeats text not null default 'Yearly' check (repeats in ('Once', 'Monthly', 'Quarterly', 'Yearly', 'Every 2 years', 'Every 3 years', 'Every 5 years')),
  owner_id uuid references public.profiles (id) on delete set null,
  status text not null default 'Open' check (status in ('Open', 'Done', 'Not needed')),
  link text, notes text, last_done date,
  created_at timestamptz default now(), updated_at timestamptz default now(), updated_by text
);
create index if not exists ix_comp_ws on public.doc_compliance (workspace_id, status, due_date);

alter table public.doc_policies enable row level security;
alter table public.doc_policy_acks enable row level security;
alter table public.inv_invoices enable row level security;
alter table public.doc_compliance enable row level security;
revoke all on public.doc_policies, public.doc_policy_acks, public.inv_invoices, public.doc_compliance from anon;
grant select, insert, update, delete on public.doc_policies, public.inv_invoices, public.doc_compliance to authenticated;
grant select on public.doc_policy_acks to authenticated;

-- a published policy is visible to the people it applies to; admins see every policy
create or replace function public.policy_for_me(p_audience text) returns boolean
language sql stable security definer set search_path = public as $$
  select case p_audience when 'Everyone' then true when 'Staff' then staff_ws() is not null else staff_ws() is null end $$;
drop policy if exists pol_read on public.doc_policies;
create policy pol_read on public.doc_policies for select to authenticated
  using (workspace_id = ws() and (is_admin() or (status = 'Published' and policy_for_me(audience))));
drop policy if exists pol_admin on public.doc_policies;
create policy pol_admin on public.doc_policies for all to authenticated using (workspace_id = ws() and is_admin()) with check (workspace_id = ws() and is_admin());
drop policy if exists ack_read on public.doc_policy_acks;
create policy ack_read on public.doc_policy_acks for select to authenticated using (workspace_id = ws() and (user_id = auth.uid() or is_admin()));
drop policy if exists inv_admin on public.inv_invoices;
create policy inv_admin on public.inv_invoices for all to authenticated using (workspace_id = ws() and is_admin()) with check (workspace_id = ws() and is_admin());
drop policy if exists plan_gate on public.inv_invoices;
create policy plan_gate on public.inv_invoices as restrictive for all to authenticated using (public.ws_has_app('invoices')) with check (public.ws_has_app('invoices'));
drop policy if exists comp_read on public.doc_compliance;
create policy comp_read on public.doc_compliance for select to authenticated using (workspace_id = ws() and staff_ws() is not null);
drop policy if exists comp_admin on public.doc_compliance;
create policy comp_admin on public.doc_compliance for all to authenticated using (workspace_id = ws() and is_admin()) with check (workspace_id = ws() and is_admin());

-- publish a policy (a new version asks everyone to certify again)
create or replace function public.policy_publish(p_id bigint, p_new_version boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare p doc_policies;
begin
  if not is_admin() then raise exception 'Only admins can publish policies.'; end if;
  select * into p from doc_policies where id = p_id and workspace_id = ws();
  if not found then raise exception 'Policy not found.'; end if;
  update doc_policies set status = 'Published',
         version = case when p_new_version and p.published_at is not null then p.version + 1 else p.version end,
         published_at = now(), effective_date = coalesce(effective_date, current_date),
         next_review = case when review_months > 0 then coalesce(effective_date, current_date) + make_interval(months => review_months) end,
         updated_at = now(), updated_by = member_name()
   where id = p_id returning * into p;
  return jsonb_build_object('version', p.version);
end $$;

-- certify one or more policies: "I have read and understand", with the person's typed name
create or replace function public.policy_ack(p_ids bigint[], p_name text) returns int
language plpgsql volatile security definer set search_path = public as $$
declare n int;
begin
  if coalesce(trim(p_name), '') = '' then raise exception 'Type your full name to certify.'; end if;
  insert into doc_policy_acks (workspace_id, policy_id, version, user_id, name_typed, ip)
  select p.workspace_id, p.id, p.version, auth.uid(), left(trim(p_name), 120), agr_request_ip()
    from doc_policies p
   where p.id = any (p_ids) and p.workspace_id = ws() and p.status = 'Published' and policy_for_me(p.audience)
  on conflict (policy_id, version, user_id) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- my policies: what applies to me and whether I've certified the current version
create or replace function public.my_policies() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'category', p.category, 'summary', p.summary, 'version', p.version,
           'effective_date', p.effective_date, 'requires_ack', p.requires_ack, 'acked_at', a.acked_at,
           'prior_ack', exists (select 1 from doc_policy_acks x where x.policy_id = p.id and x.user_id = auth.uid() and x.version < p.version))
           order by (a.acked_at is null and p.requires_ack) desc, p.title), '[]')
    from doc_policies p left join doc_policy_acks a on a.policy_id = p.id and a.version = p.version and a.user_id = auth.uid()
   where p.workspace_id = ws() and p.status = 'Published' and policy_for_me(p.audience) $$;

-- admins: who has certified each published policy
create or replace function public.policy_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Only admins can see sign-offs.'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'version', p.version, 'audience', p.audience,
            'people', (select coalesce(jsonb_agg(jsonb_build_object('user_id', u.id, 'name', u.display_name, 'role', u.role,
                 'acked_at', (select a.acked_at from doc_policy_acks a where a.policy_id = p.id and a.version = p.version and a.user_id = u.id)) order by u.display_name), '[]')
               from profiles u where u.workspace_id = p.workspace_id and u.active
                 and case p.audience when 'Everyone' then true when 'Staff' then u.role in ('admin', 'member') else u.role = 'contractor' end))
            order by p.title), '[]')
    from doc_policies p where p.workspace_id = ws() and p.status = 'Published' and p.requires_ack);
end $$;

-- invoices: the next number, created atomically
create or replace function public.inv_create(p jsonb) returns bigint
language plpgsql volatile security definer set search_path = public as $$
declare n int; pre text; nid bigint;
begin
  perform plan_require('invoices');
  if not is_admin() then raise exception 'Only admins can create invoices.'; end if;
  perform pg_advisory_xact_lock(hashtext('inv' || ws()::text));
  select coalesce(max(seq), 0) + 1 into n from inv_invoices where workspace_id = ws();
  n := greatest(n, coalesce(nullif((select config #>> '{invoice,start}' from workspaces where id = ws()), '')::int, 1));
  pre := coalesce((select config #>> '{invoice,prefix}' from workspaces where id = ws()), 'INV-');
  insert into inv_invoices (workspace_id, seq, number, client_name, client_email, client_address, contact_id, project_id, reference, issue_date, due_date,
                            currency, items, tax_rate, discount, notes, terms, updated_by)
  values (ws(), n, pre || lpad(n::text, 4, '0'), coalesce(nullif(trim(p ->> 'client_name'), ''), 'Client'), p ->> 'client_email', p ->> 'client_address',
          nullif(p ->> 'contact_id', '')::bigint, nullif(p ->> 'project_id', '')::bigint, p ->> 'reference', coalesce(nullif(p ->> 'issue_date', '')::date, current_date),
          nullif(p ->> 'due_date', '')::date, coalesce(nullif(p ->> 'currency', ''), 'USD'), coalesce(p -> 'items', '[]'), coalesce(nullif(p ->> 'tax_rate', '')::numeric, 0),
          coalesce(nullif(p ->> 'discount', '')::numeric, 0), p ->> 'notes', p ->> 'terms', member_name())
  returning id into nid;
  return nid;
end $$;

-- invoices: approved hours on a project in a date range, by person, at the project's billing rate (or the person's rate)
create or replace function public.inv_hours(p_project bigint, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform plan_require('invoices');
  if not is_admin() then raise exception 'Only admins can bill hours.'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'hours', x.hours, 'rate', x.rate) order by x.name), '[]') from (
    select u.display_name name, sum(e.hours) hours, coalesce(pr.rate, pp.rate, 0) rate
      from time_entries e join timesheets t on t.user_id = e.user_id and t.week_start = week_of(e.work_date) and t.status = 'Approved'
      join projects pr on pr.id = e.project_id join profiles u on u.id = e.user_id
      left join project_people pp on pp.project_id = e.project_id and pp.user_id = e.user_id
     where e.project_id = p_project and pr.workspace_id = ws() and e.work_date between p_from and p_to
     group by u.display_name, coalesce(pr.rate, pp.rate, 0)) x);
end $$;

revoke execute on function public.policy_publish(bigint, boolean), public.policy_ack(bigint[], text), public.my_policies(), public.policy_status(),
  public.inv_create(jsonb), public.inv_hours(bigint, date, date), public.policy_for_me(text) from public, anon;
grant execute on function public.policy_publish(bigint, boolean), public.policy_ack(bigint[], text), public.my_policies(), public.policy_status(),
  public.inv_create(jsonb), public.inv_hours(bigint, date, date), public.policy_for_me(text) to authenticated;

-- =====================================================================
-- Org chart (People → Org chart): each company builds its own from departments and positions.
--   * A position has a title, a department, who it reports to and who holds it. Empty positions show as Open and can
--     link to a Hiring opening; hiring someone for that opening fills the position, offboarding empties it again.
--   * Everyone in the company can see the chart; admins edit it.
-- Devices: assets can be issued to a person being onboarded (even before they have a Pulse login), the person confirms
-- receipt, and offboarding lists what must come back.
-- =====================================================================
create table if not exists public.org_departments (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  name text not null, color text, sort int not null default 0,
  created_at timestamptz default now()
);
create table if not exists public.org_positions (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  title text not null,
  department_id bigint references public.org_departments (id) on delete set null,
  reports_to bigint references public.org_positions (id) on delete set null,
  kind text not null default 'Staff' check (kind in ('Staff', 'Contractor', 'Advisor', 'Board')),
  user_id uuid references public.profiles (id) on delete set null,
  onboarding_id bigint references public.onboardings (id) on delete set null,
  holder_name text,                                 -- someone without a Pulse login (e.g. a board member)
  opening_id bigint references public.hire_openings (id) on delete set null,
  sort int not null default 0, notes text,
  created_at timestamptz default now(), updated_at timestamptz default now(), updated_by text
);
create index if not exists ix_orgpos_ws on public.org_positions (workspace_id);
alter table public.org_departments enable row level security;
alter table public.org_positions enable row level security;
revoke all on public.org_departments, public.org_positions from anon;
grant select, insert, update, delete on public.org_departments, public.org_positions to authenticated;
drop policy if exists org_read on public.org_departments;
create policy org_read on public.org_departments for select to authenticated using (workspace_id = ws());
drop policy if exists org_admin on public.org_departments;
create policy org_admin on public.org_departments for all to authenticated using (workspace_id = ws() and is_admin()) with check (workspace_id = ws() and is_admin());
drop policy if exists org_read on public.org_positions;
create policy org_read on public.org_positions for select to authenticated using (workspace_id = ws());
drop policy if exists org_admin on public.org_positions;
create policy org_admin on public.org_positions for all to authenticated using (workspace_id = ws() and is_admin()) with check (workspace_id = ws() and is_admin());

-- no position may report to itself or to someone below it
create or replace function public.org_no_loop() returns trigger language plpgsql as $$
begin
  if new.reports_to is not null and exists (
      with recursive up(id) as (select new.reports_to union select p.reports_to from org_positions p join up on p.id = up.id where p.reports_to is not null)
      select 1 from up where id = new.id) then
    raise exception 'A position can''t report to itself or to someone who reports to it.';
  end if;
  return new;
end $$;
drop trigger if exists org_no_loop on public.org_positions;
create trigger org_no_loop before insert or update of reports_to on public.org_positions for each row execute function public.org_no_loop();

-- the chart with each position's current holder worked out: a member, someone being onboarded, the person hired for
-- its opening, or a typed name. Offboarded people and inactive logins leave the position Open.
create or replace function public.org_chart() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'departments', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'color', d.color, 'sort', d.sort) order by d.sort, d.id), '[]')
                      from org_departments d where d.workspace_id = ws()),
    'positions', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'department_id', p.department_id, 'reports_to', p.reports_to,
                      'kind', p.kind, 'sort', p.sort, 'notes', p.notes, 'user_id', p.user_id, 'onboarding_id', p.onboarding_id, 'holder_name', p.holder_name,
                      'opening_id', p.opening_id, 'holder', h.name, 'holder_user', h.uid, 'holder_source', h.src,
                      'opening', (select jsonb_build_object('id', o.id, 'title', o.title, 'status', o.status) from hire_openings o where o.id = p.opening_id))
                    order by p.sort, p.id), '[]')
                    from org_positions p
                    left join lateral (
                      select * from (
                        select 1 pri, pr.display_name name, pr.id uid, 'member' src from profiles pr where pr.id = p.user_id and pr.active
                        union all
                        select 2, ob.name, ob.user_id, 'onboarding' from onboardings ob where p.user_id is null and ob.id = p.onboarding_id and ob.status <> 'Offboarded'
                        union all
                        select 3, c.name, ob2.user_id, 'hired' from hire_candidates c left join onboardings ob2 on ob2.id = c.onboarding_id
                         where p.user_id is null and p.onboarding_id is null and p.opening_id is not null and c.opening_id = p.opening_id and c.stage = 'Hired'
                           and coalesce(ob2.status, '') <> 'Offboarded'
                        union all
                        select 4, p.holder_name, null, 'name' where p.user_id is null and p.onboarding_id is null and coalesce(p.holder_name, '') <> ''
                      ) z order by pri limit 1) h on true
                   where p.workspace_id = ws()));
$$;
revoke execute on function public.org_chart() from public, anon;
grant execute on function public.org_chart() to authenticated;

-- hiring links straight into the org chart:
--   an opening points at a position (existing or created for it); when its candidate is hired, the new person's onboarding
--   is put into that position, so the chart shows them from day one and keeps showing them once they join Pulse.
create or replace function public.org_link_opening(p_opening bigint, p_position bigint, p_parent bigint default null, p_dept bigint default null) returns bigint
language plpgsql volatile security definer set search_path = public as $$
declare o hire_openings; pid bigint;
begin
  select * into o from hire_openings where id = p_opening and workspace_id = ws();
  if not found then raise exception 'Opening not found.'; end if;
  if not (is_admin() or o.hiring_manager = auth.uid()) then raise exception 'Only admins or the hiring manager can place an opening on the org chart.'; end if;
  update org_positions set opening_id = null where opening_id = o.id and workspace_id = ws() and (p_position is null or id <> p_position) and user_id is null and onboarding_id is null;
  if p_position is not null then
    update org_positions set opening_id = o.id, updated_at = now(), updated_by = member_name() where id = p_position and workspace_id = ws() returning id into pid;
  elsif p_parent is not null then
    insert into org_positions (workspace_id, title, department_id, reports_to, kind, opening_id, updated_by)
    values (ws(), o.title, coalesce(p_dept, (select department_id from org_positions where id = p_parent)), p_parent,
            case when o.kind in ('Contractor', 'Consultant') then 'Contractor' when o.kind = 'Advisor' then 'Advisor' else 'Staff' end, o.id, member_name())
    returning id into pid;
  end if;
  return pid;
end $$;

-- place a person being onboarded into a position (or a new one under a manager)
create or replace function public.org_place(p_onboarding bigint, p_position bigint, p_parent bigint default null, p_title text default null, p_dept bigint default null) returns bigint
language plpgsql volatile security definer set search_path = public as $$
declare ob onboardings; pid bigint;
begin
  select * into ob from onboardings where id = p_onboarding and workspace_id = ws();
  if not found then raise exception 'Person not found.'; end if;
  if not (is_admin() or ob.owner_id = auth.uid()) then raise exception 'Only admins or the person''s owner can place them on the org chart.'; end if;
  update org_positions set onboarding_id = null where onboarding_id = ob.id and workspace_id = ws();
  if p_position is not null then
    update org_positions set onboarding_id = ob.id, user_id = coalesce(ob.user_id, user_id), holder_name = null, updated_at = now(), updated_by = member_name()
     where id = p_position and workspace_id = ws() returning id into pid;
  elsif p_parent is not null then
    insert into org_positions (workspace_id, title, department_id, reports_to, kind, onboarding_id, user_id, updated_by)
    values (ws(), coalesce(nullif(trim(p_title), ''), ob.role_title, ob.kind), coalesce(p_dept, (select department_id from org_positions where id = p_parent)), p_parent,
            case when ob.kind in ('Contractor', 'Consultant') then 'Contractor' when ob.kind = 'Advisor' then 'Advisor' else 'Staff' end, ob.id, ob.user_id, member_name())
    returning id into pid;
  end if;
  return pid;
end $$;

-- when someone is hired, put them into the position linked to their opening (the first empty one)
create or replace function public.org_on_hire() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.stage = 'Hired' and new.onboarding_id is not null and (old.onboarding_id is distinct from new.onboarding_id or old.stage is distinct from 'Hired') then
    update org_positions set onboarding_id = new.onboarding_id, updated_at = now(), updated_by = 'Hired'
     where id = (select id from org_positions where opening_id = new.opening_id and workspace_id = new.workspace_id
                   and user_id is null and onboarding_id is null order by id limit 1);
  end if;
  return new;
end $$;
drop trigger if exists org_on_hire on public.hire_candidates;
create trigger org_on_hire after update of stage, onboarding_id on public.hire_candidates for each row execute function public.org_on_hire();

-- when a person being onboarded joins Pulse, their position follows their login; when they're offboarded it opens again
create or replace function public.org_on_onboarding() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.user_id is distinct from old.user_id and new.user_id is not null then
    update org_positions set user_id = new.user_id where onboarding_id = new.id and user_id is null;
  end if;
  if new.status = 'Offboarded' and old.status is distinct from 'Offboarded' then
    update org_positions set user_id = null, onboarding_id = null, updated_at = now(), updated_by = 'Offboarded' where onboarding_id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists org_on_onboarding on public.onboardings;
create trigger org_on_onboarding after update of user_id, status on public.onboardings for each row execute function public.org_on_onboarding();

revoke execute on function public.org_link_opening(bigint, bigint, bigint, bigint), public.org_place(bigint, bigint, bigint, text, bigint) from public, anon;
grant execute on function public.org_link_opening(bigint, bigint, bigint, bigint), public.org_place(bigint, bigint, bigint, text, bigint) to authenticated;

-- devices: issue to someone being onboarded, confirm receipt, see them at offboarding
alter table public.assets add column if not exists onboarding_id bigint references public.onboardings (id) on delete set null;
alter table public.assets add column if not exists ack_at timestamptz;
alter table public.assets add column if not exists ack_name text;
create index if not exists ix_assets_onb on public.assets (onboarding_id);
-- a new holder has to confirm again
create or replace function public.asset_reset_ack() returns trigger language plpgsql as $$
begin
  if new.assigned_to is distinct from old.assigned_to or new.onboarding_id is distinct from old.onboarding_id then new.ack_at := null; new.ack_name := null; end if;
  return new;
end $$;
drop trigger if exists asset_reset_ack on public.assets;
create trigger asset_reset_ack before update of assigned_to, onboarding_id on public.assets for each row execute function public.asset_reset_ack();
-- the holder confirms they received it
create or replace function public.asset_ack(p_id bigint, p_name text) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if coalesce(trim(p_name), '') = '' then raise exception 'Type your full name to confirm.'; end if;
  update assets set ack_at = now(), ack_name = left(trim(p_name), 120)
   where id = p_id and workspace_id = ws() and (assigned_to = auth.uid() or onboarding_id in (select id from onboardings where user_id = auth.uid()));
  if not found then raise exception 'That device isn''t assigned to you.'; end if;
end $$;
revoke execute on function public.asset_ack(bigint, text) from public, anon;
grant execute on function public.asset_ack(bigint, text) to authenticated;
-- people see devices issued to them through their onboarding too
drop policy if exists assets_read on public.assets;
create policy assets_read on public.assets for select to authenticated using (workspace_id = ws() and (is_admin() or assigned_to = auth.uid()
  or onboarding_id in (select id from onboardings where user_id = auth.uid())));

-- ---------------------------------------------------------------- plan locks on the paid apps' tables
-- Restrictive policies are ANDed with each table's own rules: on a lower plan the data stays, but can't be opened.
do $$ declare t record; begin
  for t in select * from (values
      ('fed_config', 'opportunities'), ('fed_searches', 'opportunities'), ('fed_notices', 'opportunities'), ('fed_matches', 'opportunities'),
      ('fed_calls', 'opportunities'), ('fed_bm_docs', 'opportunities'),
      ('project_milestones', 'projects'), ('project_tasks', 'projects'), ('project_costs', 'projects'), ('project_risks', 'projects'), ('project_updates', 'projects'),
      ('agreement_templates', 'agreements'), ('agreements', 'agreements'), ('agreement_signers', 'agreements'), ('agreement_events', 'agreements'), ('agreement_files', 'agreements'),
      ('hire_openings', 'hiring'), ('hire_candidates', 'hiring'), ('hire_files', 'hiring'), ('hire_interviews', 'hiring'), ('hire_scores', 'hiring'), ('hire_events', 'hiring'),
      ('calendar_accounts', 'scheduler'), ('busy_blocks', 'scheduler'), ('meetings', 'scheduler'),
      ('reminders', 'chief'), ('chief_briefs', 'chief'), ('chief_usage', 'chief')) v(tbl, app) loop
    if to_regclass('public.' || t.tbl) is not null then
      execute format('drop policy if exists plan_gate on public.%I', t.tbl);
      execute format('create policy plan_gate on public.%I as restrictive for all to authenticated using (public.ws_has_app(%L)) with check (public.ws_has_app(%L))', t.tbl, t.app, t.app);
    end if;
  end loop;
end $$;

-- the timer itself: every 5 minutes (each workspace's own schedule decides when it actually calls SAM.gov)
do $$ begin
  perform cron.schedule('pulse-federal', '*/5 * * * *', 'select public.fed_tick()');
exception when others then raise notice 'pg_cron schedule not created (%). Turn on pg_cron and run this file again.', sqlerrm; end $$;

-- daily reviews start with the new leads from Opportunities (added once to each workspace's saved daily agenda)
update public.workspaces set config = jsonb_set(config, '{agendas,daily}',
    jsonb_build_array('New SAM.gov, grant and bid matches: add to the pipeline or dismiss') || (config #> '{agendas,daily}'))
 where jsonb_typeof(config #> '{agendas,daily}') = 'array'
   and not (config #> '{agendas,daily}') @> '["New SAM.gov, grant and bid matches: add to the pipeline or dismiss"]';
