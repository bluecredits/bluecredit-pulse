-- Pulse update 2026-11-08: plans and billing (Starter $3 / Pro $6 / Enterprise $10 per user per month)
-- Adds plan fields to workspaces, the plan checks, and locks on the Pro and Enterprise apps.
-- Existing companies get 14 days of Pro from today; BlueCredit (the operators' company) is set to Enterprise, complimentary.
-- Safe to run more than once.

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
  select case when p_app in ('opportunities', 'projects', 'agreements', 'hiring') then 'pro'
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
    case when n.source = 'BidMatch' then 'MyBidMatch (' || coalesce(n.level, 'unsorted') || ')' else n.source end,
    concat_ws(E'\n', 'Notice type: ' || n.notice_type, 'Office: ' || n.office, 'Posted: ' || n.posted_date, 'PSC: ' || n.psc, fed_contacts_text(n.contacts), left(n.summary, 800),
      case when n.awardee is not null then 'Awardee: ' || n.awardee || coalesce(' ($' || to_char(n.award_amount, 'FM999,999,999,990') || ')', '') end),
    n.award_amount, jsonb_build_object('sam_notice_id', n.notice_id), member_name(),
    n.contacts -> 0 ->> 'name', n.contacts -> 0 ->> 'email')
  returning id into oid;
  update fed_notices set status = 'Added', opportunity_id = oid, status_by = member_name() where workspace_id = w and notice_id = p_notice;
  perform fed_contacts_upsert(w, n);
  return oid;
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

create or replace function public.fed_save_config(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare w uuid := staff_ws();
begin
  perform plan_require('opportunities');
  if w is null or not is_admin() then raise exception 'Only admins can change Federal settings.'; end if;
  insert into fed_config (workspace_id) values (w) on conflict do nothing;
  update fed_config set enabled = coalesce((p ->> 'enabled')::boolean, enabled), every_min = coalesce((p ->> 'every_min')::int, every_min),
    daily_budget = coalesce((p ->> 'daily_budget')::int, daily_budget), next_fetch_at = null, updated_at = now(), updated_by = member_name()
   where workspace_id = w;
  return fed_status();
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

create or replace function public.fed_set_status(p_notices text[], p_status text) returns void
language plpgsql volatile security definer set search_path = public as $$
declare w uuid := staff_ws();
begin
  perform plan_require('opportunities');
  if w is null then raise exception 'Only team members can use Federal opportunities.'; end if;
  if p_status not in ('New', 'Saved', 'Dismissed') then raise exception 'Unknown status.'; end if;
  update fed_notices set status = p_status, status_by = member_name() where workspace_id = w and notice_id = any (p_notices) and status <> 'Added';
end $$;

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
    'grants', (select count(*) from fed_notices where workspace_id = w and source = 'Grants.gov'));
end $$;

create or replace function public.fed_list(p_source text default 'SAM.gov', p_status text default 'New', p_search bigint default null, p_sort text default 'posted', p_limit int default 400) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by case when p_sort = 'due' then x.response_deadline end nulls last, x.posted_date desc nulls last, x.first_seen desc), '[]')
  from (select n.notice_id, n.title, n.sol_number, n.agency, n.subtier, n.office, n.notice_type, n.posted_date, n.response_deadline, n.naics, n.set_aside,
               n.set_aside_code, n.state, n.city, n.ui_link, n.award_amount, n.awardee, n.status, n.opportunity_id, n.funding_id, n.first_seen, n.source, n.aln, n.level, left(n.summary, 6000) summary, n.naics_all, n.psc, n.bm_keywords,
               (select coalesce(jsonb_agg(c || coalesce((select jsonb_build_object('cid', ct.id) from contacts ct where ct.workspace_id = n.workspace_id
                    and c ? 'email' and lower(ct.email) = lower(c ->> 'email') limit 1), '{}')), '[]') from jsonb_array_elements(n.contacts) c) contacts,
               (select array_agg(m.search_id) from fed_matches m where m.workspace_id = n.workspace_id and m.notice_id = n.notice_id) searches
          from fed_notices n
         where n.workspace_id = staff_ws() and ws_has_app('opportunities') and n.source = coalesce(p_source, 'SAM.gov') and (p_status = 'All' or n.status = p_status)
           and ((n.source = 'BidMatch' and p_search is null) or (n.status <> 'New' and p_search is null)
                or exists (select 1 from fed_matches m where m.workspace_id = n.workspace_id and m.notice_id = n.notice_id and (p_search is null or m.search_id = p_search)))
         order by case when p_sort = 'due' then n.response_deadline end nulls last, n.posted_date desc nulls last, n.first_seen desc
         limit least(greatest(coalesce(p_limit, 400), 1), 1000)) x $$;

create or replace function public.fed_counts() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('new', (select count(distinct n.notice_id) from fed_notices n join fed_matches m on m.workspace_id = n.workspace_id and m.notice_id = n.notice_id
                                     where n.workspace_id = staff_ws() and ws_has_app('opportunities') and n.status = 'New'),
    'by_source', coalesce((select jsonb_object_agg(source, c) from (select n.source, count(*) c from fed_notices n
                                     where n.workspace_id = staff_ws() and ws_has_app('opportunities') and n.status = 'New'
                                       and (n.source = 'BidMatch' or exists (select 1 from fed_matches m where m.workspace_id = n.workspace_id and m.notice_id = n.notice_id))
                                     group by n.source) z), '{}'),
    'by_search', coalesce((select jsonb_object_agg(search_id, c) from (select m.search_id, count(*) c from fed_matches m join fed_notices n on n.workspace_id = m.workspace_id and n.notice_id = m.notice_id
                                     where m.workspace_id = staff_ws() and ws_has_app('opportunities') and n.status = 'New' group by m.search_id) z), '{}')) $$;

create or replace function public.fed_tick() returns void
language plpgsql volatile security definer set search_path = public as $$
declare w uuid;
begin
  for w in select workspace_id from fed_config where ws_has_app_for(workspace_id, 'opportunities')
              and (enabled or exists (select 1 from fed_calls x where x.workspace_id = fed_config.workspace_id and x.status = 'pending')) loop
    begin perform fed_tick_ws(w); exception when others then
      update fed_config set last_error = 'Internal error: ' || sqlerrm where workspace_id = w; end;
  end loop;
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

create or replace function public.hire_opening_public(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('title', o.title, 'kind', o.kind, 'schedule', o.schedule, 'location', o.location, 'remote', o.remote, 'description', o.description,
           'must_haves', o.must_haves, 'pay', o.pay, 'company', w.name, 'open', o.status = 'Open' and ws_has_app_for(o.workspace_id, 'hiring'))
    from hire_openings o join workspaces w on w.id = o.workspace_id
   where o.apply_token = p_token and length(coalesce(p_token, '')) >= 32 and o.status in ('Open', 'On hold', 'Filled', 'Closed') $$;

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


select name, plan, comped, ws_plan_for(id) as effective, trial_ends_at::date as trial_ends from public.workspaces order by created_at;
