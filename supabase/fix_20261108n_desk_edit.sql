-- 2026-11-08n: editing a request in Tickets failed ("malformed array literal"). Safe to run more than once.
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
    changed := array_append(changed, 'title'::text); t.title := trim(p ->> 'title'); end if;
  if p ? 'description' and nullif(trim(p ->> 'description'), '') is distinct from t.description then
    changed := array_append(changed, 'details'::text); t.description := nullif(trim(p ->> 'description'), ''); end if;
  if p ? 'priority' and coalesce(nullif(p ->> 'priority', ''), 'Normal') is distinct from t.priority then
    changed := array_append(changed, 'priority'::text); t.priority := coalesce(nullif(p ->> 'priority', ''), 'Normal'); end if;
  if p ? 'amount' and nullif(regexp_replace(coalesce(p ->> 'amount', ''), '[$,\s]', '', 'g'), '')::numeric is distinct from t.amount then
    changed := array_append(changed, 'amount'::text); t.amount := nullif(regexp_replace(coalesce(p ->> 'amount', ''), '[$,\s]', '', 'g'), '')::numeric; end if;
  if p ? 'start_date' and nullif(p ->> 'start_date', '')::date is distinct from t.start_date then
    changed := array_append(changed, 'dates'::text); t.start_date := nullif(p ->> 'start_date', '')::date; end if;
  if p ? 'end_date' and nullif(p ->> 'end_date', '')::date is distinct from t.end_date then
    if not 'dates' = any (changed) then changed := array_append(changed, 'dates'::text); end if; t.end_date := nullif(p ->> 'end_date', '')::date; end if;
  if t.end_date is not null and t.start_date is not null and t.end_date < t.start_date then raise exception 'The end date is before the start date.'; end if;
  if p ? 'reference' and nullif(trim(p ->> 'reference'), '') is distinct from t.reference then
    changed := array_append(changed, 'reference'::text); t.reference := nullif(trim(p ->> 'reference'), ''); end if;
  if p ? 'needed_by' and nullif(p ->> 'needed_by', '')::date is distinct from t.needed_by then
    changed := array_append(changed, 'needed-by date'::text); t.needed_by := nullif(p ->> 'needed_by', '')::date; end if;
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
