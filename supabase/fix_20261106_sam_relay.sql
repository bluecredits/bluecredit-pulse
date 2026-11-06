-- Pulse fix 2026-11-06: SAM.gov through the sam-relay Edge Function
-- api.sam.gov never finishes the TLS handshake from the database network, so every SAM request timed out.
-- Deploy the Edge Function "sam-relay" first (Verify JWT off), then run this.
alter table public.fed_config add column if not exists sam_relay_url text;

create or replace function public.fed_request(p_ws uuid, p_from date, p_to date, p_offset int) returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare c fed_config; k text; rid bigint;
begin
  select * into c from fed_config where workspace_id = p_ws;
  if c.key_secret_id is null then update fed_config set last_status = 'No SAM.gov API key yet' where workspace_id = p_ws; return false; end if;
  if fed_used_today(p_ws) >= c.daily_budget then
    update fed_config set last_status = format('Paused: daily limit of %s requests reached; resumes after midnight Eastern', c.daily_budget) where workspace_id = p_ws;
    return false;
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where id = $1' into k using c.key_secret_id;
  if k is null then update fed_config set last_error = 'The saved API key could not be read. Save it again in Settings.' where workspace_id = p_ws; return false; end if;
  execute 'select net.http_get(url := $1, params := $2, timeout_milliseconds := 180000)' into rid
    using coalesce(nullif(c.sam_relay_url, ''), 'https://api.sam.gov/opportunities/v2/search'),
          jsonb_build_object('api_key', k, 'postedFrom', to_char(p_from, 'MM/DD/YYYY'), 'postedTo', to_char(p_to, 'MM/DD/YYYY'), 'limit', '200', 'offset', p_offset::text);
  insert into fed_calls (workspace_id, request_id, page_offset, posted_from, posted_to) values (p_ws, rid, p_offset, p_from, p_to);
  return true;
exception when undefined_function or invalid_schema_name or undefined_table then
  update fed_config set last_error = 'The database extensions for fetching (pg_net, Vault) are not turned on. See Settings.' where workspace_id = p_ws;
  return false;
end $$;

update public.fed_config set sam_relay_url = 'https://dtnohwaxnnwqplmdtdeq.supabase.co/functions/v1/sam-relay',
       last_error = null, next_fetch_at = null
 where key_secret_id is not null;
select 'SAM.gov goes through sam-relay' as check, true as ok;
