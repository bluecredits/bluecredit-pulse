-- ================================================================ fix z3 · Tasks in Tickets (Nov 14 2026)
-- A "Task" request type: anyone on the team asks a teammate to do something (administrative, operational or a review),
-- with a due date. It goes straight to that person (no approval); they see it under "To work on", comment, start and finish it.
-- The person who created a task can reassign or reopen it. The kind is kept in tickets.reference.
-- Safe to run more than once.

create or replace function public.desk_types() returns text[] language sql immutable as $$
  select array['Task', 'IT support', 'Software request', 'New equipment', 'Purchase or expense', 'Time off', 'Travel', 'Access or account',
               'Asset problem', 'Return an asset', 'Other'] $$;

create or replace function public.desk_submit(p jsonb) returns bigint
language plpgsql volatile security definer set search_path = public as $$
declare
  v_type text := trim(p ->> 'type'); v_title text := nullif(trim(p ->> 'title'), '');
  v_needs boolean; v_appr uuid; v_asset bigint := nullif(p ->> 'asset_id', '')::bigint; v_label text;
  v_start date := nullif(p ->> 'start_date', '')::date; v_end date := nullif(p ->> 'end_date', '')::date;
  v_amount numeric := nullif(regexp_replace(coalesce(p ->> 'amount', ''), '[$,\s]', '', 'g'), '')::numeric;
  v_status text; v_id bigint;
  v_sw software_catalog; v_swid bigint := nullif(p ->> 'software_id', '')::bigint; v_ref text := nullif(trim(p ->> 'reference'), '');
  v_assignee uuid := nullif(p ->> 'assignee_id', '')::uuid;
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
  if v_type = 'Software request' then
    -- on the approved list: no approval unless the admin flagged it; anything else needs approval and a reason
    if v_swid is not null then
      select * into v_sw from software_catalog where id = v_swid and workspace_id = ws() and active;
      if not found then raise exception 'That software isn''t on the approved list any more.'; end if;
      v_ref := v_sw.name; v_needs := v_sw.needs_approval;
      if v_amount is null and coalesce(v_sw.cost, 0) > 0 then v_amount := v_sw.cost; end if;
    else
      if v_ref is null then raise exception 'Name the software you need.'; end if;
      if nullif(trim(p ->> 'description'), '') is null then raise exception 'Say what you need it for, since it isn''t on the approved list.'; end if;
      v_needs := true;
    end if;
  end if;
  if v_type = 'Task' then
    -- a task for a teammate: who does it, what kind of work, no approval
    if v_assignee is null then raise exception 'Pick who should do it.'; end if;
    if not exists (select 1 from profiles where id = v_assignee and active and workspace_id = ws()) then raise exception 'Pick an active team member.'; end if;
    v_ref := coalesce(v_ref, 'Operational');
    if v_ref not in ('Administrative', 'Operational', 'Review') then raise exception 'Pick administrative, operational or review.'; end if;
    v_needs := false;
  else
    v_assignee := null;
  end if;
  if v_needs then v_appr := desk_pick_approver(auth.uid(), nullif(p ->> 'approver_id', '')::uuid); end if;
  v_status := case when v_needs then 'Pending approval' else 'Open' end;
  perform pg_advisory_xact_lock(hashtext('tickets:' || ws()::text));
  insert into tickets (number, type, title, description, status, priority, requester_id, approver_id, asset_id, asset_label,
                       amount, start_date, end_date, reference, needed_by, software_id, assignee_id)
  values ((select coalesce(max(number), 0) + 1 from tickets where workspace_id = ws()),
          v_type, v_title, nullif(trim(p ->> 'description'), ''), v_status,
          coalesce(nullif(p ->> 'priority', ''), 'Normal'), auth.uid(), v_appr, v_asset, v_label,
          v_amount, v_start, v_end, v_ref, nullif(p ->> 'needed_by', '')::date, case when v_type = 'Software request' then v_swid end, v_assignee)
  returning id into v_id;
  perform desk_log(v_id, 'created', null, null, v_status);
  if v_assignee is not null then perform desk_log(v_id, 'assigned', (select display_name from profiles where id = v_assignee)); end if;
  return v_id;
end $$;
revoke execute on function public.desk_submit(jsonb) from public, anon;
grant execute on function public.desk_submit(jsonb) to authenticated;

-- admins assign any request; whoever created a task can hand it to someone else
create or replace function public.desk_assign(p_id bigint, p_assignee uuid) returns void
language plpgsql volatile security definer set search_path = public as $$
declare t tickets;
begin
  select * into t from tickets where id = p_id and workspace_id = ws();
  if not found then raise exception 'Request not found.'; end if;
  if not (is_admin() or (t.type = 'Task' and t.requester_id = auth.uid())) then raise exception 'Only admins (or whoever created the task) can assign it.'; end if;
  if t.type = 'Task' and p_assignee is null then raise exception 'A task needs someone to do it.'; end if;
  if p_assignee is not null and not exists (select 1 from profiles where id = p_assignee and active and workspace_id = ws()) then
    raise exception 'Pick an active team member.';
  end if;
  if p_assignee is not distinct from t.assignee_id then return; end if;
  update tickets set assignee_id = p_assignee, updated_at = now() where id = p_id;
  perform desk_log(p_id, 'assigned', coalesce((select display_name from profiles where id = p_assignee), 'nobody'));
end $$;

-- whoever created a task can send it back (reopen) if it isn't done right
create or replace function public.desk_set_status(p_id bigint, p_status text, p_note text default null) returns void
language plpgsql volatile security definer set search_path = public as $$
declare t tickets; v_to text := p_status; v_worker boolean;
begin
  select * into t from tickets where id = p_id and workspace_id = ws() for update;
  if not found then raise exception 'Request not found.'; end if;
  v_worker := is_admin() or coalesce(t.assignee_id = auth.uid(), false);
  if p_status = 'Reopen' and t.type = 'Task' and t.requester_id = auth.uid() then v_worker := true; end if;   -- send a finished task back
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
