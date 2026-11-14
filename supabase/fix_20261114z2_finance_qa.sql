-- ================================================================ fix z2 · Finance review fixes (Nov 14 2026)
-- * Finance moves to the Enterprise plan.
-- * A budget row, transaction, category mapping or invoice can only point at an account (and a transaction at a project)
--   in its own workspace. Before this, an admin could create rows pointing at another company's account ids.
-- Safe to run more than once.

create or replace function public.app_plan(p_app text) returns text language sql immutable as $$
  select case when p_app in ('opportunities', 'projects', 'agreements', 'hiring', 'invoices') then 'pro'
              when p_app in ('chief', 'scheduler', 'finance') then 'enterprise' else 'starter' end $$;

create or replace function public.fin_same_ws() returns trigger
language plpgsql security definer set search_path = public as $$
declare acc bigint; ws_of uuid;
begin
  acc := (to_jsonb(new) ->> case when tg_table_name = 'inv_invoices' then 'fin_account_id' else 'account_id' end)::bigint;
  if acc is not null then
    select workspace_id into ws_of from fin_accounts where id = acc;
    if ws_of is distinct from new.workspace_id then raise exception 'That account belongs to another workspace.'; end if;
  end if;
  if tg_table_name = 'fin_entries' and (to_jsonb(new) ->> 'project_id') is not null
     and not exists (select 1 from projects p where p.id = (to_jsonb(new) ->> 'project_id')::bigint and p.workspace_id = new.workspace_id) then
    raise exception 'That project belongs to another workspace.';
  end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['fin_budget', 'fin_entries', 'fin_map'] loop
    execute format('drop trigger if exists fin_same_ws on public.%I', t);
    execute format('create trigger fin_same_ws before insert or update on public.%I for each row execute function public.fin_same_ws()', t);
  end loop;
end $$;
drop trigger if exists fin_same_ws on public.inv_invoices;
create trigger fin_same_ws before insert or update of fin_account_id on public.inv_invoices for each row execute function public.fin_same_ws();
