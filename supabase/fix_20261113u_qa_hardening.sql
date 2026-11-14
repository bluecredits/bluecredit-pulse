-- Pulse fix u (2026-11-13): QA/QC security hardening.
--   * Internal helper functions could be called directly through the API by any signed-in user, from any company.
--     Some of them write without checking the company: adding entries to another company's agreement or ticket
--     history, ticking someone else's onboarding checklist, or feeding made-up listings into another company's bid
--     sources. They're only meant to be called by other database functions, so the API can no longer reach them.
--   * The public (signed-out) role loses its leftover read/truncate rights on profiles and activity (row security
--     already hid the rows; this removes the rights altogether).
--   * Helper functions get a fixed search path (Supabase advisor "function_search_path_mutable").
-- Safe to run more than once.

do $$ declare f record; begin
  for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in (
              'agr_log', 'agr_maybe_execute', 'agr_tick_onboarding', 'desk_log', 'desk_pick_approver', 'fed_request_notice',
              'src_request', 'src_store', 'src_keep', 'sign_lookup', 'check_join_rate', 'check_new_member', 'ws_drop', 'ws_purge')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

-- functions the careers and signing pages don't need: signed-out visitors can't call them
do $$ declare f record; begin
  for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('hire_can', 'hire_lead', 'hire_mark_hired', 'hire_summary', 'hire_upload', 'member_name')
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;

revoke all on public.profiles, public.activity from anon;

-- fixed search path on every public function that doesn't have one
do $$ declare f record; begin
  for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind = 'f'
              and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
              and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('alter function %s set search_path = public, pg_catalog', f.sig);
  end loop;
end $$;
