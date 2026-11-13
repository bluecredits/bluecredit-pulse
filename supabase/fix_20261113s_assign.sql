-- Pulse fix s (2026-11-13): assign work.
--   * "Assign work" (Projects, a project page, and a ticket's "Make it a project task") gives someone a task, a milestone,
--     or a role on a project (manager, approver or team member). Employees and contractors are added to the project
--     so they can see what they were given.
--   * Milestones have an owner. "My work" lists your tasks, the milestones you own and the projects you manage;
--     a milestone owner can mark it done.
--   * A task made from a ticket remembers the ticket, and the ticket's timeline says where the work went.
-- Safe to run more than once.

alter table public.project_milestones add column if not exists owner_id uuid references public.profiles (id) on delete set null;
alter table public.project_tasks add column if not exists ticket_id bigint references public.tickets (id) on delete set null;

create or replace function public.pm_assign(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_kind text := p ->> 'kind'; v_user uuid := nullif(p ->> 'assignee', '')::uuid; v_proj projects; who profiles;
  v_id bigint; v_ms bigint := nullif(p ->> 'milestone_id', '')::bigint; v_task bigint := nullif(p ->> 'task_id', '')::bigint;
  v_ticket bigint := nullif(p ->> 'ticket_id', '')::bigint; v_role text := coalesce(p ->> 'role', 'member'); v_title text;
begin
  if staff_ws() is null then raise exception 'Only admins and members can assign work.'; end if;
  select * into who from profiles where id = v_user and workspace_id = ws() and active;
  if not found then raise exception 'Pick someone on the team.'; end if;
  select * into v_proj from projects where id = nullif(p ->> 'project_id', '')::bigint and workspace_id = ws();
  if not found then raise exception 'Pick a project.'; end if;

  -- people outside the core team only see projects they're on
  if who.role not in ('admin', 'member') and not exists (select 1 from project_people where project_id = v_proj.id and user_id = v_user) then
    if not can_manage_project(v_proj.id) then
      raise exception '% isn''t on %. Ask the project manager to add them, or to assign this.', who.display_name, v_proj.name;
    end if;
    insert into project_people (workspace_id, project_id, user_id) values (v_proj.workspace_id, v_proj.id, v_user) on conflict do nothing;
  end if;

  if v_kind = 'project' then
    if not can_manage_project(v_proj.id) then raise exception 'Only an admin or the project manager can change who runs %.', v_proj.name; end if;
    if v_role in ('manager', 'approver') and who.role not in ('admin', 'member') then
      raise exception 'Project managers and approvers need an admin or member login.';
    end if;
    if v_role = 'manager' then update projects set manager_id = v_user where id = v_proj.id;
    elsif v_role = 'approver' then update projects set approver_id = v_user where id = v_proj.id;
    else insert into project_people (workspace_id, project_id, user_id) values (v_proj.workspace_id, v_proj.id, v_user) on conflict do nothing;
    end if;
    return jsonb_build_object('kind', 'project', 'id', v_proj.id, 'project_id', v_proj.id, 'role', v_role, 'who', who.display_name);

  elsif v_kind = 'milestone' then
    if not can_manage_project(v_proj.id) then raise exception 'Only an admin or the project manager can assign milestones on %.', v_proj.name; end if;
    if v_ms is not null then
      update project_milestones set owner_id = v_user where id = v_ms and project_id = v_proj.id returning id into v_id;
      if v_id is null then raise exception 'That milestone isn''t on %.', v_proj.name; end if;
    else
      if nullif(trim(p ->> 'name'), '') is null then raise exception 'Name the milestone.'; end if;
      insert into project_milestones (workspace_id, project_id, name, start_date, due_date, deliverable, notes, owner_id, sort)
      values (v_proj.workspace_id, v_proj.id, trim(p ->> 'name'), nullif(p ->> 'start_date', '')::date, nullif(p ->> 'due_date', '')::date,
              coalesce((p ->> 'deliverable')::boolean, false), nullif(trim(p ->> 'notes'), ''), v_user,
              coalesce((select max(sort) + 1 from project_milestones where project_id = v_proj.id), 0))
      returning id into v_id;
    end if;
    return jsonb_build_object('kind', 'milestone', 'id', v_id, 'project_id', v_proj.id, 'who', who.display_name);

  elsif v_kind = 'task' then
    if not can_see_project(v_proj.id) then raise exception 'You can''t see %.', v_proj.name; end if;
    if v_ms is not null and not exists (select 1 from project_milestones where id = v_ms and project_id = v_proj.id) then
      raise exception 'That milestone isn''t on %.', v_proj.name;
    end if;
    if v_ticket is not null and not exists (select 1 from tickets where id = v_ticket and workspace_id = ws()) then v_ticket := null; end if;
    if v_task is not null then
      update project_tasks set assignee_id = v_user, updated_at = now(), milestone_id = coalesce(v_ms, milestone_id)
       where id = v_task and project_id = v_proj.id returning id, title into v_id, v_title;
      if v_id is null then raise exception 'That task isn''t on %.', v_proj.name; end if;
    else
      v_title := nullif(trim(p ->> 'title'), '');
      if v_title is null then raise exception 'Give the task a title.'; end if;
      insert into project_tasks (workspace_id, project_id, milestone_id, title, description, priority, assignee_id, due_date, estimate_hours, ticket_id, sort)
      values (v_proj.workspace_id, v_proj.id, v_ms, v_title, nullif(trim(p ->> 'description'), ''), coalesce(nullif(p ->> 'priority', ''), 'Normal'), v_user,
              nullif(p ->> 'due_date', '')::date, nullif(p ->> 'estimate_hours', '')::numeric, v_ticket,
              coalesce((select max(sort) + 1 from project_tasks where project_id = v_proj.id), 0))
      returning id into v_id;
    end if;
    if v_ticket is not null then
      perform desk_log(v_ticket, 'note', format('%s made this a task in %s, assigned to %s.', member_name(), v_proj.name, who.display_name));
    end if;
    return jsonb_build_object('kind', 'task', 'id', v_id, 'project_id', v_proj.id, 'who', who.display_name);
  end if;
  raise exception 'Pick a task, a milestone or a project role.';
end $$;

-- a milestone's owner (or the project manager) marks it done or not done
create or replace function public.pm_milestone_done(p_id bigint, p_done boolean) returns void
language plpgsql volatile security definer set search_path = public as $$
declare m project_milestones;
begin
  select * into m from project_milestones where id = p_id and workspace_id = ws();
  if not found then raise exception 'Milestone not found.'; end if;
  if not (m.owner_id = auth.uid() or can_manage_project(m.project_id)) then raise exception 'Only the milestone''s owner or the project manager can do that.'; end if;
  update project_milestones set done_at = case when p_done then coalesce(done_at, current_date) end where id = p_id;
end $$;

-- open tasks assigned to you, plus open milestones you own (kind tells them apart)
create or replace function public.my_tasks() returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(x order by x ->> 'due' nulls last), '[]') from (
    select jsonb_build_object('kind', 'task', 'id', t.id, 'title', t.title, 'status', t.status, 'priority', t.priority, 'due', t.due_date,
                              'project', p.name, 'project_id', p.id, 'milestone', m.name) x
      from project_tasks t join projects p on p.id = t.project_id left join project_milestones m on m.id = t.milestone_id
     where t.assignee_id = auth.uid() and t.status <> 'Done'
    union all
    select jsonb_build_object('kind', 'milestone', 'id', m.id, 'title', m.name, 'status', 'Open', 'priority', 'Normal', 'due', m.due_date,
                              'project', p.name, 'project_id', p.id, 'deliverable', m.deliverable,
                              'tasks_open', (select count(*) from project_tasks t where t.milestone_id = m.id and t.status <> 'Done'))
      from project_milestones m join projects p on p.id = m.project_id
     where m.owner_id = auth.uid() and m.done_at is null) s $$;

revoke execute on function public.pm_assign(jsonb), public.pm_milestone_done(bigint, boolean) from public, anon;
grant execute on function public.pm_assign(jsonb), public.pm_milestone_done(bigint, boolean), public.my_tasks() to authenticated;
