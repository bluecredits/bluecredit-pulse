-- 2026-11-08k: Employee portal.
--   * A new role, Employee, between Member and Contractor. Employees join with their own employee code and land in the
--     employee portal: onboarding checklist, policies to certify, contracts to sign, devices, hours and requests.
--     They never see the business records (contacts, pipeline, funding, bids), same as contractors.
--   * Employees count as users for billing; contractors stay free.
--   * Policies for "Staff" now include employees.
--   * Devices issued to someone still being onboarded stay "In use" (they were being marked Available), and become theirs
--     when they sign up.
-- Safe to run more than once.


alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('admin', 'member', 'employee', 'contractor'));

alter table public.workspaces add column if not exists employee_code text;

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
    exit when not exists (select 1 from workspaces where upper(join_code) = v or upper(contractor_code) = v or upper(employee_code) = v);
  end loop;
  return v;
end $$;

update public.workspaces set employee_code = public.new_company_code(name) where employee_code is null;
create unique index if not exists ux_workspaces_ecode on public.workspaces (upper(employee_code));
alter table public.workspaces alter column employee_code set not null;
-- the role a code gives: company code = member, employee code = employee, contractor code = contractor
create or replace function public.code_role(p_ws uuid, p_code text) returns text
language sql stable security definer set search_path = public as $$
  select case when upper(join_code) = c then 'member' when upper(employee_code) = c then 'employee' when upper(contractor_code) = c then 'contractor' end
    from workspaces, (select upper(trim(coalesce(p_code, ''))) c) x where id = p_ws $$;
revoke execute on function public.code_role(uuid, text) from public, anon, authenticated;

create or replace function public.create_workspace(p_company text, p_name text, p_template text default 'general') returns text
language plpgsql volatile security definer set search_path = public as $$
declare v_email text; v_ws uuid; v_code text; v_company text := trim(coalesce(p_company, ''));
begin
  perform check_join_rate();
  if v_company = '' then raise exception 'Enter your company name.'; end if;
  if length(v_company) > 80 then raise exception 'Keep the company name under 80 characters.'; end if;
  v_email := check_new_member(p_name);
  v_code := new_company_code(v_company);
  insert into workspaces (name, join_code, contractor_code, employee_code, template, created_by)
  values (v_company, v_code, new_company_code(v_company), new_company_code(v_company), case when p_template in ('general', 'govcon', 'fundraising') then p_template else 'general' end, auth.uid())
  returning id into v_ws;
  insert into profiles (id, workspace_id, display_name, email, role) values (auth.uid(), v_ws, trim(p_name), v_email, 'admin');
  insert into activity (workspace_id, user_name, entity, action, summary)
    values (v_ws, split_part(trim(p_name), ' ', 1), 'team', 'create', trim(p_name) || ' started the ' || v_company || ' workspace');
  return v_code;
end $$;

create or replace function public.join_company(p_code text, p_name text) returns text
language plpgsql volatile security definer set search_path = public as $$
declare v_ws uuid; v_email text; p profiles; v_role text;
begin
  perform check_join_rate();
  select id, code_role(id, p_code) into v_ws, v_role
    from workspaces where upper(trim(coalesce(p_code, ''))) in (upper(join_code), upper(contractor_code), upper(employee_code));
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
    values (v_ws, split_part(trim(p_name), ' ', 1), 'team', 'create', trim(p_name) || case v_role when 'contractor' then ' joined as a contractor' when 'employee' then ' joined the employee portal' else ' joined the team' end);
  -- link them to their onboarding record, if an admin set one up with this email
  update onboardings set user_id = auth.uid(), status = case when status = 'Planned' then 'In progress' else status end
   where workspace_id = v_ws and user_id is null and lower(email) = lower(v_email);
  -- devices issued to them while they were being onboarded are now theirs
  update assets set assigned_to = auth.uid()
   where workspace_id = v_ws and assigned_to is null and onboarding_id in (select id from onboardings where workspace_id = v_ws and user_id = auth.uid());
  return v_role;
end $$;

create or replace function public.get_employee_code() returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Only admins can see the employee code.'; end if;
  return (select employee_code from workspaces where id = ws());
end $$;
revoke execute on function public.get_employee_code() from public, anon;
grant execute on function public.get_employee_code() to authenticated;

create or replace function public.rotate_company_code(p_code text default null, p_kind text default 'team') returns text
language plpgsql volatile security definer set search_path = public as $$
declare v text := upper(trim(coalesce(p_code, '')));
begin
  if not is_admin() then raise exception 'Only admins can change the company code.'; end if;
  if v = '' then v := new_company_code((select name from workspaces where id = ws())); end if;
  if length(v) < 8 then raise exception 'Use at least 8 characters.'; end if;
  if exists (select 1 from workspaces where (upper(join_code) = v or upper(contractor_code) = v or upper(employee_code) = v) and id <> ws())
     or exists (select 1 from workspaces w where w.id = ws() and v in (
          select upper(x) from unnest(case p_kind when 'contractor' then array[w.join_code, w.employee_code]
                                                   when 'employee' then array[w.join_code, w.contractor_code]
                                                   else array[w.contractor_code, w.employee_code] end) x)) then
    raise exception 'That code is taken. Try another.';
  end if;
  if p_kind = 'contractor' then update workspaces set contractor_code = v where id = ws();
  elsif p_kind = 'employee' then update workspaces set employee_code = v where id = ws();
  else update workspaces set join_code = v where id = ws(); end if;
  insert into activity (user_name, entity, action, summary)
    values (member_name(), 'team', 'update', case p_kind when 'contractor' then 'Changed the contractor code' when 'employee' then 'Changed the employee code' else 'Changed the company code' end);
  return v;
end $$;

create or replace function public.set_member(p_id uuid, p_role text, p_active boolean) returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_name text;
begin
  if not is_admin() then raise exception 'Only admins can change team members.'; end if;
  if p_role not in ('admin', 'member', 'employee', 'contractor') then raise exception 'Unknown role %', p_role; end if;
  if p_id = auth.uid() and (p_role <> 'admin' or not p_active) then
    raise exception 'You can''t remove your own admin access. Ask another admin.';
  end if;
  update profiles set role = p_role, active = p_active where id = p_id and workspace_id = ws() returning display_name into v_name;
  if v_name is null then raise exception 'That person isn''t on your team.'; end if;
  insert into activity (user_name, entity, action, summary)
    values (member_name(), 'team', 'update', v_name || ': ' || p_role || case when p_active then '' else ', turned off' end);
end $$;

create or replace function public.billing_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'plan', w.plan, 'effective', ws_plan_for(w.id), 'comped', w.comped, 'paid_until', w.paid_until,
    'trial_ends_at', w.trial_ends_at, 'trial_days_left', greatest(0, ceil(extract(epoch from (w.trial_ends_at - now())) / 86400))::int,
    'cycle', w.billing_cycle, 'billing_email', w.billing_email, 'has_stripe', w.stripe_customer_id is not null, 'note', w.plan_note,
    'seats', (select count(*) from profiles p where p.workspace_id = w.id and p.active and p.role in ('admin', 'member', 'employee')),
    'contractors', (select count(*) from profiles p where p.workspace_id = w.id and p.active and p.role = 'contractor'),
    'operator', is_operator())
    from workspaces w where w.id = ws() $$;

create or replace function public.billing_workspaces() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when is_operator() then coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'plan', w.plan, 'effective', ws_plan_for(w.id),
    'comped', w.comped, 'paid_until', w.paid_until, 'trial_ends_at', w.trial_ends_at, 'note', w.plan_note, 'created_at', w.created_at,
    'seats', (select count(*) from profiles p where p.workspace_id = w.id and p.active and p.role in ('admin', 'member', 'employee'))) order by w.created_at), '[]') end
    from workspaces w $$;

create or replace function public.desk_pick_approver(p_requester uuid, p_choice uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v uuid; other_admin boolean;
begin
  other_admin := exists (select 1 from profiles where workspace_id = ws() and active and role = 'admin' and id <> p_requester);
  if p_choice is not null then
    if not exists (select 1 from profiles where id = p_choice and active and workspace_id = ws() and role in ('admin', 'member')) then
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

create or replace function public.policy_for_me(p_audience text) returns boolean
language sql stable security definer set search_path = public as $$
  select case p_audience when 'Everyone' then true
              when 'Staff' then exists (select 1 from profiles where id = auth.uid() and active and role in ('admin', 'member', 'employee'))
              else exists (select 1 from profiles where id = auth.uid() and active and role = 'contractor') end $$;

create or replace function public.policy_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Only admins can see sign-offs.'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'version', p.version, 'audience', p.audience,
            'people', (select coalesce(jsonb_agg(jsonb_build_object('user_id', u.id, 'name', u.display_name, 'role', u.role,
                 'acked_at', (select a.acked_at from doc_policy_acks a where a.policy_id = p.id and a.version = p.version and a.user_id = u.id)) order by u.display_name), '[]')
               from profiles u where u.workspace_id = p.workspace_id and u.active
                 and case p.audience when 'Everyone' then true when 'Staff' then u.role in ('admin', 'member', 'employee') else u.role = 'contractor' end))
            order by p.title), '[]')
    from doc_policies p where p.workspace_id = ws() and p.status = 'Published' and p.requires_ack);
end $$;

create or replace function public.asset_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare held boolean := new.assigned_to is not null or new.onboarding_id is not null;   -- a team member, or someone being onboarded
begin
  if new.assigned_to is not null and not exists (select 1 from profiles where id = new.assigned_to and workspace_id = new.workspace_id) then
    raise exception 'Assign assets to someone on your own team.';
  end if;
  if tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to or new.onboarding_id is distinct from old.onboarding_id then
    new.assigned_since := case when not held then null else coalesce(case when tg_op = 'INSERT' then new.assigned_since end,
      case when tg_op = 'UPDATE' and (old.assigned_to is not null or old.onboarding_id is not null) then old.assigned_since end, current_date) end;
    if held and new.status = 'Available' then new.status := 'In use'; end if;
    if not held and new.status = 'In use' then new.status := 'Available'; end if;
  end if;
  return new;
end $$;
-- devices issued before this fix to people being onboarded
update public.assets a set assigned_to = o.user_id from public.onboardings o
 where a.onboarding_id = o.id and a.assigned_to is null and o.user_id is not null and o.status <> 'Offboarded';
update public.assets set status = 'In use' where onboarding_id is not null and assigned_to is null and status = 'Available'
   and onboarding_id in (select id from public.onboardings where status <> 'Offboarded');
