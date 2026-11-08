-- Pulse update 2026-11-07 (b): openings can be any engagement (Employee, Contractor, Consultant, Intern, Advisor) and Full-time / Part-time / As needed
-- any engagement, from contractor to full-time employee
alter table public.hire_openings add column if not exists schedule text not null default 'Full-time';
alter table public.hire_openings drop constraint if exists hire_openings_kind_check;
alter table public.hire_openings add constraint hire_openings_kind_check check (kind in ('Employee', 'Contractor', 'Consultant', 'Intern', 'Advisor'));
alter table public.hire_openings drop constraint if exists hire_openings_schedule_check;
alter table public.hire_openings add constraint hire_openings_schedule_check check (schedule in ('Full-time', 'Part-time', 'As needed'));

create or replace function public.hire_opening_public(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('title', o.title, 'kind', o.kind, 'schedule', o.schedule, 'location', o.location, 'remote', o.remote, 'description', o.description,
           'must_haves', o.must_haves, 'pay', o.pay, 'company', w.name, 'open', o.status = 'Open')
    from hire_openings o join workspaces w on w.id = o.workspace_id
   where o.apply_token = p_token and length(coalesce(p_token, '')) >= 32 and o.status in ('Open', 'On hold', 'Filled', 'Closed') $$;
