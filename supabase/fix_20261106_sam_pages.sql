-- Pulse fix (Nov 6, 2026): SAM.gov pages of 200 with a 3-minute wait and one retry (SAM.gov timed out on pages of 1,000).
-- Safe to run more than once.
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
    using 'https://api.sam.gov/opportunities/v2/search',
          jsonb_build_object('api_key', k, 'postedFrom', to_char(p_from, 'MM/DD/YYYY'), 'postedTo', to_char(p_to, 'MM/DD/YYYY'), 'limit', '200', 'offset', p_offset::text);
  insert into fed_calls (workspace_id, request_id, page_offset, posted_from, posted_to) values (p_ws, rid, p_offset, p_from, p_to);
  return true;
exception when undefined_function or invalid_schema_name or undefined_table then
  update fed_config set last_error = 'The database extensions for fetching (pg_net, Vault) are not turned on. See Settings.' where workspace_id = p_ws;
  return false;
end $$;

create or replace function public.fed_request_grants(p_ws uuid, p_start int) returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare rid bigint;
begin
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 180000)' into rid
    using 'https://api.grants.gov/v1/api/search2', jsonb_build_object('oppStatuses', 'forecasted|posted', 'rows', 1000, 'startRecordNum', p_start),
          '{"Content-Type": "application/json"}'::jsonb;
  insert into fed_calls (workspace_id, request_id, page_offset, source) values (p_ws, rid, p_start, 'Grants.gov');
  return true;
exception when undefined_function or invalid_schema_name or undefined_table then
  update fed_config set grants_error = 'The database extension for fetching (pg_net) is not turned on. See Settings.' where workspace_id = p_ws;
  return false;
end $$;

create or replace function public.fed_tick_ws(p_ws uuid, p_force boolean default false) returns void
language plpgsql volatile security definer set search_path = public as $$
declare c fed_config; cl fed_calls; r record; body jsonb; n int; got int; hits int; started timestamptz := clock_timestamp();
  today date := (now() at time zone 'America/New_York')::date; stamp text := to_char(now() at time zone 'America/New_York', 'Mon DD, HH12:MI AM');
begin
  select * into c from fed_config where workspace_id = p_ws for update skip locked;
  if not found then return; end if;
  for cl in select * from fed_calls where workspace_id = p_ws and status = 'pending' order by id loop
    begin
      execute 'select status_code, content, timed_out, error_msg from net._http_response where id = $1' into r using cl.request_id;
    exception when others then r := null; end;
    if r is null then
      if cl.created_at < now() - interval '15 minutes' then update fed_calls set status = 'error', error = 'No response from ' || cl.source, done_at = now() where id = cl.id; end if;
      continue;
    end if;
    body := null;
    if coalesce(r.status_code, 0) = 200 then begin body := r.content::jsonb; exception when others then body := null; end; end if;
    if cl.source = 'BidMatch' then
      if coalesce(r.status_code, 0) = 200 then
        begin
          got := fed_store_bm(p_ws, split_part(cl.ref, ':', 1), nullif(split_part(cl.ref, ':', 2), ''), cl.page_offset, r.content);
          update fed_calls set status = 'done', http_status = 200, records = got, done_at = now() where id = cl.id;
          if split_part(cl.ref, ':', 1) = 'sub' then update fed_config set bidmatch_fetch_at = now(), bidmatch_error = null where workspace_id = p_ws; end if;
        exception when others then
          update fed_calls set status = 'error', http_status = 200, error = sqlerrm, done_at = now() where id = cl.id;
          if split_part(cl.ref, ':', 1) = 'sub' then update fed_config set bidmatch_error = 'Could not read the MyBidMatch page: ' || sqlerrm where workspace_id = p_ws; end if;
        end;
      else
        update fed_calls set status = 'error', http_status = r.status_code, error = coalesce(r.error_msg, left(r.content, 300)), done_at = now() where id = cl.id;
        if split_part(cl.ref, ':', 1) = 'sub' then
          update fed_config set bidmatch_error = format('MyBidMatch error %s: %s', coalesce(r.status_code::text, ''), left(coalesce(r.error_msg, ''), 200)) where workspace_id = p_ws;
        end if;
      end if;
      continue;
    end if;
    if body is null then
      update fed_calls set status = 'error', http_status = r.status_code, error = coalesce(r.error_msg, left(r.content, 300), 'Unreadable response'), done_at = now() where id = cl.id;
      if cl.source = 'Grants.gov' then
        update fed_config set grants_error = format('Grants.gov error %s: %s', coalesce(r.status_code::text, ''), left(coalesce(r.error_msg, r.content, ''), 200)) where workspace_id = p_ws;
      else
        update fed_config set last_error = case
            when r.status_code = 429 then 'SAM.gov says the daily request limit for this API key is used up. Fetching resumes tomorrow; consider a slower schedule.'
            when r.status_code in (401, 403) then 'SAM.gov rejected the API key. Check it is current (keys expire every 90 days) and save it again.'
            when r.timed_out then 'SAM.gov was slow to answer; Pulse retries smaller pages automatically.'
            else format('SAM.gov error %s: %s', r.status_code, left(coalesce(r.error_msg, r.content, ''), 200)) end
          where workspace_id = p_ws;
        -- a slow page gets one retry
        if coalesce(r.timed_out, false) or coalesce(r.error_msg, '') ilike '%timeout%' then
          if (select count(*) from fed_calls x where x.workspace_id = p_ws and x.source = 'SAM.gov' and x.posted_from is not distinct from cl.posted_from
                and x.page_offset = cl.page_offset and x.created_at > now() - interval '1 hour') < 2 then
            perform fed_request(p_ws, cl.posted_from, cl.posted_to, cl.page_offset);
          end if;
        end if;
      end if;
      continue;
    end if;
    if cl.source = 'Grants.gov' then
      n := fed_store_grants(p_ws, body);
      got := jsonb_array_length(coalesce(body #> '{data,oppHits}', '[]')); hits := (body #>> '{data,hitCount}')::int;
      update fed_calls set status = 'done', http_status = 200, records = got, total = hits, done_at = now() where id = cl.id;
      if got > 0 and coalesce(hits, 0) > cl.page_offset + got then perform fed_request_grants(p_ws, cl.page_offset + got); end if;
      update fed_config set grants_fetch_at = now(), grants_error = null where workspace_id = p_ws;
    else
      n := fed_store(p_ws, body);
      update fed_calls set status = 'done', http_status = 200, records = jsonb_array_length(coalesce(body -> 'opportunitiesData', '[]')), total = (body ->> 'totalRecords')::int, done_at = now() where id = cl.id;
      if coalesce((body ->> 'totalRecords')::int, 0) > cl.page_offset + 200 then
        perform fed_request(p_ws, cl.posted_from, cl.posted_to, cl.page_offset + 200);
      elsif cl.posted_from < today then
        update fed_config set yesterday_done = today where workspace_id = p_ws;
      end if;
      update fed_config set last_fetch_at = now(), last_error = null, last_status = 'Checked SAM.gov ' || stamp where workspace_id = p_ws;
    end if;
  end loop;
  perform fed_rematch(p_ws, null, started - interval '1 minute');
  -- next scheduled fetch: SAM.gov today's notices (plus yesterday's once a day, for late postings); Grants.gov all open grants
  select * into c from fed_config where workspace_id = p_ws;
  if (c.enabled and (c.next_fetch_at is null or c.next_fetch_at <= now()) or p_force)
     and not exists (select 1 from fed_calls where workspace_id = p_ws and status = 'pending' and source <> 'BidMatch') then
    update fed_config set next_fetch_at = now() + make_interval(mins => c.every_min) where workspace_id = p_ws;
    if c.key_secret_id is not null then
      perform fed_request(p_ws, case when c.yesterday_done is distinct from today then today - 1 else today end, today, 0);
    end if;
    if exists (select 1 from fed_searches where workspace_id = p_ws and source = 'Grants.gov' and active) then
      perform fed_request_grants(p_ws, 0);
    end if;
    if c.bidmatch_secret_id is not null then perform fed_request_bm(p_ws, 'sub'); end if;
  end if;
  -- housekeeping
  delete from fed_bm_docs where workspace_id = p_ws and created_at < now() - interval '45 days';
  delete from fed_notices f where f.workspace_id = p_ws and f.status = 'New' and f.first_seen < now() - case when f.source = 'BidMatch' then interval '40 days' else interval '21 days' end
     and not exists (select 1 from fed_matches m where m.workspace_id = f.workspace_id and m.notice_id = f.notice_id);
  delete from fed_calls where workspace_id = p_ws and created_at < now() - interval '30 days';
end $$;

update public.fed_config set next_fetch_at = null, last_error = null;  -- check again at the next 5-minute tick
select 'fix applied' as check, true as ok;
