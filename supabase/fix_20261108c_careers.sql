-- Pulse fix 2026-11-08c: Careers page (public list of open openings per company, to link or embed on the company's website).
-- Safe to run more than once.

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
