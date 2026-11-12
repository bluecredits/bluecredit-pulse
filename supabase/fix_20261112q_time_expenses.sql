-- Pulse fix q (2026-11-12): Timecards rules, time off rows, and Expenses.
--   * Hours can't be logged for a future date. Paid time off and company holidays can be entered ahead.
--   * A timesheet has time-off rows next to projects: Holiday, PTO and Sick (staff only; contractors log project work only).
--     If the company lists its holidays, Holiday hours go on those dates only.
--   * Expenses: people put expenses on a report (receipts, mileage at the company rate, an optional project, billable or not),
--     submit it, an admin (or the approver of every project on it) approves it, and an admin marks it reimbursed.
--     Approved expenses on a project show up in that project's costs.
-- Safe to run more than once.

-- ---------------------------------------------------------------- employees log time like members
-- staff_ws() is admins and members; team_ws() adds employees (paid staff on the employee portal), who log time on open projects and take time off.
create or replace function public.team_ws() returns uuid
language sql stable security definer set search_path = public as $$
  select workspace_id from profiles where id = auth.uid() and active and role in ('admin', 'member', 'employee') $$;
revoke execute on function public.team_ws() from public, anon;
grant execute on function public.team_ws() to authenticated;
create or replace function public.can_log(p_project bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from projects p where p.id = p_project and p.workspace_id = ws() and p.status = 'Active'
                 and ((not p.limited and team_ws() is not null)
                      or exists (select 1 from project_people pp where pp.project_id = p.id and pp.user_id = auth.uid())))
$$;
drop policy if exists tc_read on public.projects;
create policy tc_read on public.projects for select to authenticated using (workspace_id = ws() and (staff_ws() is not null or on_project(id)
  or (team_ws() is not null and status = 'Active' and not limited)));

-- ---------------------------------------------------------------- time off on timesheets
alter table public.time_entries add column if not exists kind text not null default 'Work';
alter table public.time_entries alter column project_id drop not null;
do $$ begin
  alter table public.time_entries add constraint time_entries_kind_check check (kind in ('Work', 'Holiday', 'PTO', 'Sick'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.time_entries add constraint time_entries_kind_project check ((kind = 'Work') = (project_id is not null));
exception when duplicate_object then null; end $$;
create unique index if not exists ux_time_leave on public.time_entries (user_id, kind, work_date) where project_id is null;

create table if not exists public.company_holidays (
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  day date not null, name text not null,
  primary key (workspace_id, day)
);
alter table public.company_holidays enable row level security;
drop policy if exists hol_read on public.company_holidays;
create policy hol_read on public.company_holidays for select to authenticated using (workspace_id = ws());
drop policy if exists hol_admin on public.company_holidays;
create policy hol_admin on public.company_holidays for all to authenticated using (is_admin() and workspace_id = ws()) with check (is_admin() and workspace_id = ws());
revoke all on public.company_holidays from anon;
grant select, insert, update, delete on public.company_holidays to authenticated;

-- the latest calendar date anywhere on Earth right now (UTC+14), so nobody is blocked from logging "today" in their own time zone
create or replace function public.latest_today() returns date language sql stable as $$ select (now() at time zone 'Pacific/Kiritimati')::date $$;

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
    if new.kind = 'Work' then
      if not can_log(new.project_id) then raise exception 'You aren''t on that project, or it''s closed.'; end if;
    else
      if team_ws() is null then raise exception 'Time off is logged by staff. Contractors log project hours only.'; end if;
      if new.kind = 'Holiday' and exists (select 1 from company_holidays where workspace_id = ws())
         and not exists (select 1 from company_holidays where workspace_id = ws() and day = new.work_date) then
        raise exception '% isn''t a company holiday. Use PTO for other days off.', to_char(new.work_date, 'Mon FMDD');
      end if;
    end if;
    if new.work_date > latest_today() and new.kind not in ('Holiday', 'PTO') then
      raise exception 'You can''t log hours for a future date. Only holidays and paid time off can be entered ahead.';
    end if;
    new.updated_at := now();
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------- expenses
create table if not exists public.expense_settings (
  workspace_id uuid primary key default public.ws_default() references public.workspaces (id) on delete cascade,
  mileage_rate numeric not null default 0.76,        -- IRS business rate from July 1, 2026
  receipt_over numeric not null default 75,          -- receipts required at or above this amount (IRS substantiation threshold)
  updated_at timestamptz default now()
);
create table if not exists public.expense_receipts (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  name text not null, mime text, size int, data_b64 text not null,
  created_at timestamptz default now()
);
create table if not exists public.expense_reports (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  number int,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title text not null,
  status text not null default 'Draft' check (status in ('Draft', 'Submitted', 'Approved', 'Rejected', 'Paid')),
  note text, submitted_at timestamptz, decided_by uuid references public.profiles (id) on delete set null, decided_at timestamptz, decision_note text,
  paid_at date, paid_ref text, paid_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create table if not exists public.expense_items (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null default public.ws_default() references public.workspaces (id) on delete cascade,
  report_id bigint not null references public.expense_reports (id) on delete cascade,
  spent_on date not null,
  category text not null default 'Other',
  merchant text, description text,
  amount numeric(12, 2) not null default 0 check (amount >= 0),
  miles numeric(9, 1),
  project_id bigint references public.projects (id) on delete set null,
  billable boolean not null default false,
  receipt_id bigint references public.expense_receipts (id) on delete set null,
  created_at timestamptz default now()
);
alter table public.project_costs add column if not exists expense_item_id bigint references public.expense_items (id) on delete cascade;
create index if not exists ix_exp_reports on public.expense_reports (workspace_id, status, user_id);
create index if not exists ix_exp_items on public.expense_items (report_id);
create index if not exists ix_exp_items_project on public.expense_items (project_id);

-- who can look at a report: its owner, admins, and the approver of a project on it
create or replace function public.exp_can_see(p_report bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from expense_reports r where r.id = p_report and r.workspace_id = ws()
     and (r.user_id = auth.uid() or is_admin()
          or exists (select 1 from expense_items i join projects p on p.id = i.project_id where i.report_id = r.id and p.approver_id = auth.uid()))) $$;
-- who can approve it: an admin, or the approver of every project on it (when every line is on a project)
create or replace function public.exp_can_approve(p_report bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select is_admin() or (exists (select 1 from expense_items where report_id = p_report)
     and not exists (select 1 from expense_items i left join projects p on p.id = i.project_id
                      where i.report_id = p_report and (p.id is null or p.approver_id is distinct from auth.uid()))) $$;

-- numbering, and lines only change while their report is the owner's draft
create or replace function public.exp_report_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if auth.uid() is not null and old.status not in ('Draft', 'Rejected') then raise exception 'This report is %. It can''t be deleted.', lower(old.status); end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    new.number := coalesce((select max(number) from expense_reports where workspace_id = new.workspace_id), 0) + 1;
    new.status := 'Draft';
  elsif auth.uid() is not null and current_setting('pulse.exp_rpc', true) is distinct from 'on' then
    if old.user_id <> auth.uid() then raise exception 'Only the person who made a report can change it.'; end if;
    if old.status not in ('Draft', 'Rejected') then raise exception 'This report is %. Pull it back first.', lower(old.status); end if;
    new.status := old.status; new.user_id := old.user_id; new.number := old.number;
    new.submitted_at := old.submitted_at; new.decided_by := old.decided_by; new.decided_at := old.decided_at;
    new.paid_at := old.paid_at; new.paid_ref := old.paid_ref; new.paid_by := old.paid_by;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists stamp on public.expense_reports;
create trigger stamp before insert or update or delete on public.expense_reports for each row execute function public.exp_report_stamp();

create or replace function public.exp_item_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare r expense_items := case when tg_op = 'DELETE' then old else new end; rep expense_reports; rate numeric;
begin
  if auth.uid() is null or current_setting('pulse.exp_rpc', true) = 'on' then return r; end if;
  select * into rep from expense_reports where id = r.report_id;
  if rep.user_id <> auth.uid() then raise exception 'You can only change your own expenses.'; end if;
  if rep.status not in ('Draft', 'Rejected') then raise exception 'This report is %. Pull it back first.', lower(rep.status); end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'UPDATE' and new.report_id <> old.report_id then raise exception 'Move an expense by deleting and adding it again.'; end if;
  if new.spent_on > latest_today() then raise exception 'An expense can''t be dated in the future.'; end if;
  if new.project_id is not null and not (can_log(new.project_id) or on_project(new.project_id)) then
    raise exception 'You aren''t on that project, or it''s closed.';
  end if;
  if new.receipt_id is not null and not exists (select 1 from expense_receipts where id = new.receipt_id and user_id = auth.uid()) then
    raise exception 'That receipt isn''t yours.';
  end if;
  if new.category = 'Mileage' then
    select mileage_rate into rate from expense_settings where workspace_id = rep.workspace_id;
    new.amount := round(coalesce(new.miles, 0) * coalesce(rate, 0.76), 2);
  else new.miles := null;
  end if;
  if new.project_id is null then new.billable := false; end if;
  new.workspace_id := rep.workspace_id;
  return new;
end $$;
drop trigger if exists guard on public.expense_items;
create trigger guard before insert or update or delete on public.expense_items for each row execute function public.exp_item_guard();

alter table public.expense_settings enable row level security;
alter table public.expense_receipts enable row level security;
alter table public.expense_reports enable row level security;
alter table public.expense_items enable row level security;
drop policy if exists exp_read on public.expense_settings;
create policy exp_read on public.expense_settings for select to authenticated using (workspace_id = ws());
drop policy if exists exp_admin on public.expense_settings;
create policy exp_admin on public.expense_settings for all to authenticated using (is_admin() and workspace_id = ws()) with check (is_admin() and workspace_id = ws());
drop policy if exists exp_read on public.expense_reports;
create policy exp_read on public.expense_reports for select to authenticated using (workspace_id = ws() and exp_can_see(id));
drop policy if exists exp_own on public.expense_reports;
create policy exp_own on public.expense_reports for all to authenticated using (workspace_id = ws() and user_id = auth.uid())
  with check (workspace_id = ws() and user_id = auth.uid());
drop policy if exists exp_read on public.expense_items;
create policy exp_read on public.expense_items for select to authenticated using (workspace_id = ws() and exp_can_see(report_id));
drop policy if exists exp_own on public.expense_items;
create policy exp_own on public.expense_items for all to authenticated
  using (workspace_id = ws() and exists (select 1 from expense_reports r where r.id = report_id and r.user_id = auth.uid()))
  with check (exists (select 1 from expense_reports r where r.id = report_id and r.user_id = auth.uid() and r.workspace_id = ws()));
drop policy if exists exp_read on public.expense_receipts;
create policy exp_read on public.expense_receipts for select to authenticated using (workspace_id = ws() and (user_id = auth.uid()
  or exists (select 1 from expense_items i where i.receipt_id = expense_receipts.id and exp_can_see(i.report_id))));
drop policy if exists exp_own on public.expense_receipts;
create policy exp_own on public.expense_receipts for all to authenticated using (workspace_id = ws() and user_id = auth.uid())
  with check (workspace_id = ws() and user_id = auth.uid() and length(data_b64) <= 14000000);
revoke all on public.expense_settings, public.expense_receipts, public.expense_reports, public.expense_items from anon;
grant select, insert, update, delete on public.expense_settings, public.expense_receipts, public.expense_reports, public.expense_items to authenticated;

create or replace function public.exp_submit(p_report bigint, p_note text default null) returns void
language plpgsql volatile security definer set search_path = public as $$
declare rep expense_reports; lim numeric; bad text;
begin
  select * into rep from expense_reports where id = p_report and workspace_id = ws() for update;
  if not found or rep.user_id <> auth.uid() then raise exception 'Report not found.'; end if;
  if rep.status not in ('Draft', 'Rejected') then raise exception 'This report is already %.', lower(rep.status); end if;
  if not exists (select 1 from expense_items where report_id = p_report) then raise exception 'Add at least one expense first.'; end if;
  select coalesce((select receipt_over from expense_settings where workspace_id = ws()), 75) into lim;
  select string_agg(coalesce(nullif(merchant, ''), category) || ' (' || to_char(amount, 'FM$999,999,990.00') || ')', ', ') into bad
    from expense_items where report_id = p_report and receipt_id is null and category not in ('Mileage', 'Per diem') and amount >= lim;
  if bad is not null then raise exception 'Attach receipts for expenses of % or more: %.', to_char(lim, 'FM$999,990.00'), bad; end if;
  if exists (select 1 from expense_items where report_id = p_report and amount <= 0) then raise exception 'Every expense needs an amount (or miles).'; end if;
  perform set_config('pulse.exp_rpc', 'on', true);
  update expense_reports set status = 'Submitted', note = coalesce(nullif(trim(p_note), ''), note), submitted_at = now(),
    decided_by = null, decided_at = null, decision_note = null where id = p_report;
end $$;

create or replace function public.exp_decide(p_report bigint, p_approve boolean, p_note text default null) returns void
language plpgsql volatile security definer set search_path = public as $$
declare rep expense_reports; who text;
begin
  select * into rep from expense_reports where id = p_report and workspace_id = ws() for update;
  if not found then raise exception 'Report not found.'; end if;
  if not exp_can_approve(p_report) then raise exception 'You can''t approve this report.'; end if;
  if rep.user_id = auth.uid() and exists (select 1 from profiles where workspace_id = ws() and role = 'admin' and active and id <> auth.uid()) then
    raise exception 'Ask another admin to approve your own expenses.';
  end if;
  if rep.status <> 'Submitted' then raise exception 'This report isn''t waiting for approval.'; end if;
  if not p_approve and nullif(trim(p_note), '') is null then raise exception 'Add a reason so they know what to fix.'; end if;
  perform set_config('pulse.exp_rpc', 'on', true);
  update expense_reports set status = case when p_approve then 'Approved' else 'Rejected' end, decided_by = auth.uid(), decided_at = now(),
    decision_note = nullif(trim(p_note), '') where id = p_report;
  if p_approve then
    select display_name into who from profiles where id = rep.user_id;
    insert into project_costs (workspace_id, project_id, cost_date, category, vendor, description, amount, expense_item_id, created_by)
    select rep.workspace_id, i.project_id, i.spent_on, i.category, i.merchant,
           'EXP-' || lpad(rep.number::text, 4, '0') || ' · ' || coalesce(who, '') || coalesce(' · ' || nullif(i.description, ''), '') || case when i.billable then ' · billable' else '' end,
           i.amount, i.id, auth.uid()
      from expense_items i where i.report_id = p_report and i.project_id is not null
       and not exists (select 1 from project_costs c where c.expense_item_id = i.id);
  end if;
end $$;

-- the owner pulls back a Submitted report; an admin reopens an Approved or Rejected one (its project costs come off again)
create or replace function public.exp_reopen(p_report bigint) returns void
language plpgsql volatile security definer set search_path = public as $$
declare rep expense_reports;
begin
  select * into rep from expense_reports where id = p_report and workspace_id = ws() for update;
  if not found then raise exception 'Report not found.'; end if;
  if rep.status = 'Paid' then raise exception 'This report was already reimbursed.'; end if;
  if not ((rep.user_id = auth.uid() and rep.status = 'Submitted') or (exp_can_approve(p_report) and rep.status in ('Submitted', 'Approved', 'Rejected'))) then
    raise exception 'You can''t reopen this report.';
  end if;
  perform set_config('pulse.exp_rpc', 'on', true);
  delete from project_costs where expense_item_id in (select id from expense_items where report_id = p_report);
  update expense_reports set status = 'Draft', submitted_at = null, decided_by = null, decided_at = null where id = p_report;
end $$;

create or replace function public.exp_paid(p_report bigint, p_date date, p_ref text default null) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Only admins record reimbursements.'; end if;
  perform set_config('pulse.exp_rpc', 'on', true);
  update expense_reports set status = 'Paid', paid_at = coalesce(p_date, current_date), paid_ref = nullif(trim(p_ref), ''), paid_by = auth.uid()
   where id = p_report and workspace_id = ws() and status = 'Approved';
  if not found then raise exception 'Only an approved report can be marked reimbursed.'; end if;
end $$;

-- invoices: approved (or reimbursed) expenses marked billable on a project, to bill the client
create or replace function public.inv_expenses(p_project bigint, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform plan_require('invoices');
  if not is_admin() then raise exception 'Only admins can bill expenses.'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('date', i.spent_on, 'category', i.category, 'merchant', i.merchant, 'description', i.description, 'amount', i.amount) order by i.spent_on, i.id), '[]')
    from expense_items i join expense_reports r on r.id = i.report_id
   where i.project_id = p_project and i.billable and r.workspace_id = ws() and r.status in ('Approved', 'Paid') and i.spent_on between p_from and p_to);
end $$;
revoke execute on function public.inv_expenses(bigint, date, date) from public, anon;
grant execute on function public.inv_expenses(bigint, date, date) to authenticated;

revoke execute on function public.exp_submit(bigint, text), public.exp_decide(bigint, boolean, text), public.exp_reopen(bigint), public.exp_paid(bigint, date, text),
  public.exp_can_see(bigint), public.exp_can_approve(bigint), public.latest_today() from public, anon;
grant execute on function public.exp_submit(bigint, text), public.exp_decide(bigint, boolean, text), public.exp_reopen(bigint), public.exp_paid(bigint, date, text),
  public.exp_can_see(bigint), public.exp_can_approve(bigint), public.latest_today() to authenticated;
