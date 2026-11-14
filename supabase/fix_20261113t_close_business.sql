-- Pulse fix t (2026-11-13): close or archive the business (workspace).
--   * Archive: the workspace becomes read-only. Everyone can still sign in, look things up and export, but nothing can be
--     added or changed, nobody new can join (the join codes stop working), and the daily bid checks and GitHub sync stop.
--     An admin can reopen it at any time and everything comes back as it was.
--   * Close: archives it now and deletes it permanently after 30 days. Reopening before then cancels the deletion.
--   * Download everything: an admin export of every record (JSON), for the files you keep when you close.
-- Safe to run more than once.

alter table public.workspaces add column if not exists status text not null default 'Active';
do $$ begin
  alter table public.workspaces add constraint workspaces_status_check check (status in ('Active', 'Archived'));
exception when duplicate_object then null; end $$;
alter table public.workspaces add column if not exists archived_at timestamptz;
alter table public.workspaces add column if not exists archived_by uuid;
alter table public.workspaces add column if not exists archive_reason text;
alter table public.workspaces add column if not exists delete_after timestamptz;
alter table public.workspaces add column if not exists archive_state jsonb;

create or replace function public.ws_open(p_ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select status = 'Active' from workspaces where id = p_ws), true) $$;

-- nothing changes in an archived workspace (covers the apps and the database functions they call)
create or replace function public.ws_write_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare w uuid;
begin
  if auth.uid() is null or current_setting('pulse.ws_admin', true) = 'on' then return coalesce(new, old); end if;
  w := coalesce((to_jsonb(coalesce(new, old)) ->> 'workspace_id')::uuid, null);
  if w is not null and exists (select 1 from workspaces where id = w and status = 'Archived') then
    raise exception 'This business is archived, so it''s read-only. An admin can reopen it in Workspace settings.';
  end if;
  return coalesce(new, old);
end $$;
do $$ declare t record; begin
  for t in select c.table_name from information_schema.columns c join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name
            where c.table_schema = 'public' and c.column_name = 'workspace_id' and x.table_type = 'BASE TABLE'
              and c.table_name not in ('workspaces', 'profiles') and c.table_name not like 'backup\_%' loop
    execute format('drop trigger if exists ws_write_guard on public.%I', t.table_name);
    execute format('create trigger ws_write_guard before insert or update or delete on public.%I for each row execute function public.ws_write_guard()', t.table_name);
  end loop;
end $$;

-- deleting a workspace also removes its secrets from the Vault
create or replace function public.ws_drop(p_ws uuid) returns void
language plpgsql volatile security definer set search_path = public as $$
declare ids uuid[];
begin
  select array_agg(x) into ids from (
    select key_secret_id x from fed_config where workspace_id = p_ws union all
    select bidmatch_secret_id from fed_config where workspace_id = p_ws union all
    select token_secret_id from gh_conns where workspace_id = p_ws) s where x is not null;
  if ids is not null then
    begin execute 'delete from vault.secrets where id = any ($1)' using ids;
    exception when others then raise notice 'Vault secrets not removed: %', sqlerrm; end;
  end if;
  perform set_config('pulse.bulk', 'on', true);
  perform set_config('pulse.ws_admin', 'on', true);
  delete from workspaces where id = p_ws;   -- cascades to members and every record
end $$;
revoke execute on function public.ws_drop(uuid) from public, anon, authenticated;

create or replace function public.delete_workspace(p_confirm text) returns void
language plpgsql volatile security definer set search_path = public as $$
declare w workspaces;
begin
  if not is_admin() then raise exception 'Only admins can delete the workspace.'; end if;
  select * into w from workspaces where id = ws();
  if trim(coalesce(p_confirm, '')) <> w.name then raise exception 'Type the workspace name exactly to confirm.'; end if;
  perform ws_drop(w.id);
end $$;

-- archive (read-only); with p_delete the workspace is also deleted after 30 days unless someone reopens it
create or replace function public.ws_archive(p_reason text default null, p_delete boolean default false, p_confirm text default null) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare w workspaces; rnd text := upper(substr(md5(random()::text), 1, 10));
begin
  if not is_admin() then raise exception 'Only admins can close or archive the business.'; end if;
  select * into w from workspaces where id = ws() for update;
  if p_delete and trim(coalesce(p_confirm, '')) <> w.name then raise exception 'Type the business name exactly to confirm.'; end if;
  perform set_config('pulse.ws_admin', 'on', true);
  update workspaces set
    status = 'Archived', archived_at = coalesce(case when w.status = 'Archived' then archived_at end, now()), archived_by = auth.uid(),
    archive_reason = coalesce(nullif(trim(p_reason), ''), archive_reason),
    delete_after = case when p_delete then now() + interval '30 days' else null end,
    archive_state = case when w.status = 'Archived' then archive_state else jsonb_build_object('join_code', join_code, 'employee_code', employee_code, 'contractor_code', contractor_code) end,
    join_code = case when w.status = 'Archived' then join_code else 'ARCHIVED-' || rnd end,
    employee_code = case when w.status = 'Archived' or employee_code is null then employee_code else 'ARCHIVED-E' || rnd end,
    contractor_code = case when w.status = 'Archived' or contractor_code is null then contractor_code else 'ARCHIVED-C' || rnd end
  where id = w.id returning * into w;
  return jsonb_build_object('status', w.status, 'archived_at', w.archived_at, 'delete_after', w.delete_after);
end $$;

-- reopen: writable again, the old join codes work again, and any scheduled deletion is cancelled
create or replace function public.ws_reopen() returns void
language plpgsql volatile security definer set search_path = public as $$
declare w workspaces;
begin
  if not is_admin() then raise exception 'Only admins can reopen the business.'; end if;
  select * into w from workspaces where id = ws() for update;
  if w.status <> 'Archived' then return; end if;
  update workspaces set status = 'Active', archived_at = null, archived_by = null, delete_after = null,
    join_code = coalesce(w.archive_state ->> 'join_code', join_code), employee_code = coalesce(w.archive_state ->> 'employee_code', employee_code),
    contractor_code = coalesce(w.archive_state ->> 'contractor_code', contractor_code), archive_state = null
  where id = w.id;
end $$;

create or replace function public.ws_close_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('status', status, 'archived_at', archived_at, 'archived_by', archived_by, 'reason', archive_reason, 'delete_after', delete_after)
    from workspaces where id = ws() $$;

-- everything in the workspace as JSON, for the records you keep (file contents and secrets left out)
create or replace function public.ws_export() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t record; out jsonb := '{}'; rows jsonb; w uuid := ws();
begin
  if not is_admin() then raise exception 'Only admins can export the whole business.'; end if;
  for t in select c.table_name from information_schema.columns c join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name
            where c.table_schema = 'public' and c.column_name = 'workspace_id' and x.table_type = 'BASE TABLE' and c.table_name not like 'backup\_%'
            order by c.table_name loop
    execute format('select coalesce(jsonb_agg(to_jsonb(r) - %L::text[]), ''[]'') from public.%I r where workspace_id = $1',
      array['data_b64', 'token_hash', 'key_secret_id', 'bidmatch_secret_id', 'token_secret_id', 'join_code', 'employee_code', 'contractor_code', 'archive_state'], t.table_name)
      into rows using w;
    if jsonb_array_length(rows) > 0 then out := out || jsonb_build_object(t.table_name, rows); end if;
  end loop;
  return jsonb_build_object('exported_at', now(), 'workspace', (select to_jsonb(x) - array['join_code', 'employee_code', 'contractor_code', 'archive_state', 'stripe_customer_id', 'stripe_subscription_id', 'paypal_subscription_id'] from workspaces x where id = w), 'tables', out);
end $$;

-- daily: delete closed workspaces whose 30 days are up
create or replace function public.ws_purge() returns int
language plpgsql volatile security definer set search_path = public as $$
declare w uuid; n int := 0;
begin
  for w in select id from workspaces where status = 'Archived' and delete_after is not null and delete_after <= now() loop
    perform ws_drop(w); n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.ws_purge() from public, anon, authenticated;
do $$ begin
  perform cron.unschedule('pulse-ws-purge');
exception when others then null; end $$;
do $$ begin
  perform cron.schedule('pulse-ws-purge', '17 7 * * *', 'select public.ws_purge()');
exception when others then raise notice 'pg_cron schedule not created (%). Turn on pg_cron and run this file again.', sqlerrm; end $$;

-- archived workspaces: no bid checks, no GitHub sync
create or replace function public.fed_tick() returns void
language plpgsql volatile security definer set search_path = public as $$
declare w uuid;
begin
  for w in select workspace_id from fed_config where ws_has_app_for(workspace_id, 'opportunities') and ws_open(workspace_id)
              and (enabled or exists (select 1 from fed_calls x where x.workspace_id = fed_config.workspace_id and x.status = 'pending')
                   or exists (select 1 from fed_sources y where y.workspace_id = fed_config.workspace_id and y.active)) loop
    begin perform fed_tick_ws(w); exception when others then
      update fed_config set last_error = 'Internal error: ' || sqlerrm where workspace_id = w; end;
  end loop;
end $$;
create or replace function public.gh_tick() returns void
language plpgsql volatile security definer set search_path = public as $$
declare w uuid; lid bigint;
begin
  for w in select distinct workspace_id from gh_conns where ws_has_app_for(workspace_id, 'projects') and ws_open(workspace_id) loop
    begin
      perform gh_collect(w);
      for lid in select id from gh_links where workspace_id = w and active
                   and (next_sync_at is null or next_sync_at <= now())
                   and (sync_started_at is null or sync_started_at < now() - interval '15 minutes')
                   and exists (select 1 from projects p where p.id = gh_links.project_id and p.status <> 'Closed')
                 order by next_sync_at nulls first limit 20 loop
        perform gh_sync_link(lid);
      end loop;
    exception when others then
      insert into gh_config (workspace_id, last_error) values (w, 'Internal error: ' || sqlerrm) on conflict (workspace_id) do update set last_error = excluded.last_error;
    end;
  end loop;
end $$;

revoke execute on function public.ws_archive(text, boolean, text), public.ws_reopen(), public.ws_close_status(), public.ws_export(), public.ws_open(uuid) from public, anon;
grant execute on function public.ws_archive(text, boolean, text), public.ws_reopen(), public.ws_close_status(), public.ws_export(), public.ws_open(uuid) to authenticated;

-- nobody joins an archived business, whatever code they have
create or replace function public.ws_join_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.workspace_id is not null and new.workspace_id is distinct from (case when tg_op = 'UPDATE' then old.workspace_id end)
     and exists (select 1 from workspaces where id = new.workspace_id and status = 'Archived') then
    raise exception 'That business has closed, so it isn''t taking new members.';
  end if;
  return new;
end $$;
drop trigger if exists ws_join_guard on public.profiles;
create trigger ws_join_guard before insert or update of workspace_id on public.profiles for each row execute function public.ws_join_guard();
