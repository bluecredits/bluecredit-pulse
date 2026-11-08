-- Pulse fix 2026-11-08f: Opportunities → Add by link (SAM.gov and Grants.gov links fetched; any other link saved with your details).
-- Safe to run more than once.

-- ---------------------------------------------------------------- Add by link
-- Paste a SAM.gov or Grants.gov link and Pulse fetches that one notice; any other link (state portals, eVA, foundations…)
-- is saved with the details the person types. Everything added this way lands under Saved.
create or replace function public.fed_anydate(p text) returns date language plpgsql immutable as $$
declare f text;
begin
  if coalesce(trim(p), '') = '' then return null; end if;
  foreach f in array array['Mon DD, YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'MonDD,YYYY'] loop
    begin return to_date(left(trim(p), 12), f); exception when others then null; end;
  end loop;
  return null;
end $$;

create or replace function public.fed_link_parse(p_url text) returns jsonb language sql immutable as $$
  select case
    when p_url ~* 'sam\.gov/(workspace/contract/)?opp/[0-9a-f]{32}' then jsonb_build_object('source', 'SAM.gov', 'id', lower(substring(p_url from '(?i)opp/([0-9a-f]{32})')))
    when p_url ~* 'grants\.gov/.*(search-results-detail/|oppid=)[0-9]+' then jsonb_build_object('source', 'Grants.gov', 'id', 'G' || substring(p_url from '(?i)(?:search-results-detail/|oppid=)([0-9]+)'))
    else jsonb_build_object('source', 'Link', 'id', 'L' || left(md5(lower(regexp_replace(trim(p_url), '[#?].*$', ''))), 16)) end $$;

create or replace function public.fed_request_notice(p_ws uuid, p_notice text) returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare c fed_config; k text; rid bigint; today date := (now() at time zone 'America/New_York')::date;
begin
  select * into c from fed_config where workspace_id = p_ws;
  if c.key_secret_id is null then return false; end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where id = $1' into k using c.key_secret_id;
  if k is null then return false; end if;
  execute 'select net.http_get(url := $1, params := $2, timeout_milliseconds := 120000)' into rid
    using coalesce(nullif(c.sam_relay_url, ''), 'https://api.sam.gov/opportunities/v2/search'),
          jsonb_build_object('api_key', k, 'noticeid', p_notice, 'postedFrom', to_char(today - 364, 'MM/DD/YYYY'), 'postedTo', to_char(today, 'MM/DD/YYYY'), 'limit', '5', 'offset', '0');
  insert into fed_calls (workspace_id, request_id, source, ref) values (p_ws, rid, 'SAM.gov', 'link:' || p_notice);
  return true;
exception when undefined_function or invalid_schema_name or undefined_table then return false;
end $$;

-- p: {url, title, agency, deadline (date), kind, notes} — title etc. are only needed for links other than SAM.gov and Grants.gov
create or replace function public.fed_add_link(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare w uuid := staff_ws(); url text := trim(coalesce(p ->> 'url', '')); lk jsonb; nid text; src text; ok boolean;
begin
  perform plan_require('opportunities');
  if w is null then raise exception 'Only team members can add opportunities.'; end if;
  if url !~* '^https?://[^ ]+\.[^ ]+' then raise exception 'Paste a full link that starts with https://'; end if;
  lk := fed_link_parse(url); src := lk ->> 'source'; nid := lk ->> 'id';
  if coalesce((p ->> 'manual')::boolean, false) and src <> 'Link' then src := 'Link'; nid := 'L' || left(md5(lower(regexp_replace(url, '[#?].*$', ''))), 16); end if;
  if exists (select 1 from fed_notices where workspace_id = w and notice_id = nid) then
    update fed_notices set status = 'Saved', status_by = member_name() where workspace_id = w and notice_id = nid and status in ('New', 'Dismissed');
    return jsonb_build_object('state', 'ready', 'source', src, 'notice_id', nid, 'status', (select status from fed_notices where workspace_id = w and notice_id = nid));
  end if;
  if src = 'SAM.gov' then
    ok := fed_request_notice(w, nid);
    if not ok then return jsonb_build_object('state', 'no_key', 'source', src, 'notice_id', nid); end if;
    return jsonb_build_object('state', 'fetching', 'source', src, 'notice_id', nid);
  elsif src = 'Grants.gov' then
    insert into fed_notices (workspace_id, notice_id, source, title, ui_link, status, status_by, active)
    values (w, nid, 'Grants.gov', 'Grants.gov opportunity ' || substring(nid from 2), 'https://www.grants.gov/search-results-detail/' || substring(nid from 2), 'Saved', member_name(), true);
    if not fed_request_grant_detail(w, nid) then
      update fed_notices set detail_at = now() where workspace_id = w and notice_id = nid;
      return jsonb_build_object('state', 'ready', 'source', src, 'notice_id', nid, 'status', 'Saved');
    end if;
    return jsonb_build_object('state', 'fetching', 'source', src, 'notice_id', nid);
  end if;
  if coalesce(trim(p ->> 'title'), '') = '' then return jsonb_build_object('state', 'need_details', 'source', src, 'notice_id', nid); end if;
  insert into fed_notices (workspace_id, notice_id, source, title, agency, notice_type, level, response_deadline, posted_date, ui_link, summary, sol_number, status, status_by, active)
  values (w, nid, 'Link', left(trim(p ->> 'title'), 400), nullif(trim(p ->> 'agency'), ''), nullif(trim(p ->> 'kind'), ''),
          case when p ->> 'kind' ~* 'federal' then 'Federal' when p ->> 'kind' ~* 'state' then 'State' when p ->> 'kind' ~* 'local|city|county' then 'Local' when p ->> 'kind' ~* 'educat|universit|school' then 'Education' end,
          (nullif(p ->> 'deadline', '')::date + time '23:59') at time zone 'America/New_York', (now() at time zone 'America/New_York')::date, url,
          nullif(trim(p ->> 'notes'), ''), nullif(trim(p ->> 'ref'), ''), 'Saved', member_name(), true);
  return jsonb_build_object('state', 'ready', 'source', src, 'notice_id', nid, 'status', 'Saved');
end $$;

-- while a SAM.gov or Grants.gov link is being fetched: collect answers now, then say where it stands
create or replace function public.fed_link_check(p_notice text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare w uuid := staff_ws(); n fed_notices; cl fed_calls;
begin
  if w is null then raise exception 'Only team members can add opportunities.'; end if;
  perform fed_tick_ws(w);
  select * into n from fed_notices where workspace_id = w and notice_id = p_notice;
  select * into cl from fed_calls where workspace_id = w and (ref = 'link:' || p_notice or (source = 'GrantDetail' and ref = p_notice)) order by id desc limit 1;
  if n.notice_id is not null and (n.source <> 'Grants.gov' or n.detail_at is not null) then
    return jsonb_build_object('state', 'ready', 'title', n.title, 'source', n.source, 'status', n.status);
  end if;
  if cl.status = 'error' then return jsonb_build_object('state', 'error', 'error', cl.error, 'title', n.title); end if;
  return jsonb_build_object('state', 'fetching');
end $$;
revoke execute on function public.fed_add_link(jsonb), public.fed_link_check(text), public.fed_request_notice(uuid, text) from public, anon;
grant execute on function public.fed_add_link(jsonb), public.fed_link_check(text) to authenticated;


create or replace function public.fed_store_grant_detail(p_ws uuid, p_notice text, p_body jsonb) returns int
language plpgsql volatile security definer set search_path = public as $$
declare d jsonb := coalesce(p_body #> '{data,synopsis}', p_body #> '{data,forecast}', '{}'); ph text; n int;
begin
  ph := nullif(trim(d ->> 'agencyContactPhone'), ''); if ph !~ '[0-9]{3}' then ph := null; end if;
  update fed_notices set detail_at = now(),
      contacts = case when coalesce(nullif(trim(d ->> 'agencyContactName'), ''), nullif(trim(d ->> 'agencyContactEmail'), '')) is not null
        then jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('name', fed_person(d ->> 'agencyContactName'),
               'email', nullif(lower(trim(d ->> 'agencyContactEmail')), ''), 'phone', ph, 'type', 'Agency contact'))) else contacts end,
      summary = coalesce(summary, left(fed_unhtml(coalesce(d ->> 'synopsisDesc', d ->> 'forecastDesc')), 6000)),
      -- grants added by link start as a placeholder; fill them in from the full record
      title = case when title like 'Grants.gov opportunity %' then coalesce(nullif(p_body #>> '{data,opportunityTitle}', ''), title) else title end,
      sol_number = coalesce(sol_number, nullif(p_body #>> '{data,opportunityNumber}', '')),
      agency = coalesce(agency, nullif(d ->> 'agencyName', ''), nullif(p_body #>> '{data,owningAgencyCode}', '')),
      notice_type = coalesce(notice_type, case when p_body #> '{data,synopsis}' is not null then 'Posted' when p_body #> '{data,forecast}' is not null then 'Forecasted' end),
      posted_date = coalesce(posted_date, fed_anydate(coalesce(d ->> 'postingDate', d ->> 'postingDateStr'))),
      response_deadline = coalesce(response_deadline, (fed_anydate(coalesce(d ->> 'responseDate', d ->> 'responseDateStr', d ->> 'estApplicationResponseDate')) + time '23:59') at time zone 'America/New_York')
   where workspace_id = p_ws and notice_id = p_notice;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.fed_tick_ws(p_ws uuid, p_force boolean default false) returns void
language plpgsql volatile security definer set search_path = public as $$
declare c fed_config; cl fed_calls; r record; g record; body jsonb; n int; got int; hits int; started timestamptz := clock_timestamp();
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
    if cl.source = 'GrantDetail' then
      if body is not null then
        got := fed_store_grant_detail(p_ws, cl.ref, body);
        update fed_calls set status = 'done', http_status = 200, records = got, done_at = now() where id = cl.id;
      else
        update fed_calls set status = 'error', http_status = r.status_code, error = coalesce(r.error_msg, left(r.content, 300), 'Unreadable response'), done_at = now() where id = cl.id;
        update fed_notices set detail_at = now() where workspace_id = p_ws and notice_id = cl.ref;
      end if;
      continue;
    end if;
    -- a single notice asked for by link (Add by link)
    if cl.source = 'SAM.gov' and coalesce(cl.ref, '') like 'link:%' then
      if body is not null then
        got := fed_store(p_ws, body);
        update fed_notices set status = 'Saved', status_by = coalesce(status_by, 'Added by link') where workspace_id = p_ws and notice_id = substring(cl.ref from 6) and status = 'New';
        n := (select count(*) from fed_notices where workspace_id = p_ws and notice_id = substring(cl.ref from 6));
        update fed_calls set status = case when n > 0 then 'done' else 'error' end, http_status = 200, records = jsonb_array_length(coalesce(body -> 'opportunitiesData', '[]')),
               error = case when n > 0 then null else 'SAM.gov has no notice with that ID posted in the last year' end, done_at = now() where id = cl.id;
      else
        update fed_calls set status = 'error', http_status = r.status_code, done_at = now(),
               error = case when r.status_code = 429 then 'SAM.gov''s daily limit for your API key is used up; try again tomorrow'
                            when r.status_code in (401, 403) then 'SAM.gov rejected the API key; save a current key in Settings'
                            else coalesce(r.error_msg, left(r.content, 300), 'Unreadable response') end where id = cl.id;
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
            when (r.timed_out or coalesce(r.error_msg, '') ilike '%timeout%') and nullif(c.sam_relay_url, '') is null
              then 'SAM.gov never accepted the connection from the database. Deploy the sam-relay Edge Function and run the contacts + relay SQL to route SAM.gov through it.'
            when r.timed_out or coalesce(r.error_msg, '') ilike '%timeout%' then 'SAM.gov did not answer in time (through sam-relay). Pulse tries once more; if this keeps happening, SAM.gov may be down.'
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
     and not exists (select 1 from fed_calls where workspace_id = p_ws and status = 'pending' and source in ('SAM.gov', 'Grants.gov')) then
    update fed_config set next_fetch_at = now() + make_interval(mins => c.every_min) where workspace_id = p_ws;
    if c.key_secret_id is not null then
      perform fed_request(p_ws, case when c.yesterday_done is distinct from today then today - 1 else today end, today, 0);
    end if;
    if exists (select 1 from fed_searches where workspace_id = p_ws and source = 'Grants.gov' and active) then
      perform fed_request_grants(p_ws, 0);
    end if;
    if c.bidmatch_secret_id is not null then perform fed_request_bm(p_ws, 'sub'); end if;
  end if;
  -- contacts for matched grants, a few per tick
  for g in select f.notice_id from fed_notices f
            where f.workspace_id = p_ws and f.source = 'Grants.gov' and f.detail_at is null and f.status in ('New', 'Saved')
              and exists (select 1 from fed_matches m where m.workspace_id = f.workspace_id and m.notice_id = f.notice_id)
              and not exists (select 1 from fed_calls x where x.workspace_id = p_ws and x.source = 'GrantDetail' and x.ref = f.notice_id and x.created_at > now() - interval '1 day')
            order by f.response_deadline nulls last limit 25 loop
    perform fed_request_grant_detail(p_ws, g.notice_id);
  end loop;
  -- housekeeping
  delete from fed_bm_docs where workspace_id = p_ws and created_at < now() - interval '45 days';
  delete from fed_notices f where f.workspace_id = p_ws and f.status = 'New' and f.first_seen < now() - case when f.source = 'BidMatch' then interval '40 days' else interval '21 days' end
     and not exists (select 1 from fed_matches m where m.workspace_id = f.workspace_id and m.notice_id = f.notice_id);
  delete from fed_calls where workspace_id = p_ws and created_at < now() - interval '30 days';
end $$;

create or replace function public.fed_add_to_opportunities(p_notice text, p_kind text default null) returns bigint
language plpgsql volatile security definer set search_path = public as $$
declare w uuid := staff_ws(); n fed_notices; oid bigint;
begin
  perform plan_require('opportunities');
  if w is null then raise exception 'Only team members can add opportunities.'; end if;
  select * into n from fed_notices where workspace_id = w and notice_id = p_notice for update;
  if not found then raise exception 'Notice not found.'; end if;
  if n.opportunity_id is not null and exists (select 1 from opportunities where id = n.opportunity_id) then return n.opportunity_id; end if;
  insert into opportunities (workspace_id, title, kind, agency, ref_no, stage, deadline, naics, set_aside, location, url, source, notes, value, meta, updated_by,
      contact_name, contact_email)
  values (w, n.title, coalesce(nullif(p_kind, ''), 'Federal Contract'), concat_ws(' / ', n.agency, n.subtier), n.sol_number, 'Identified',
    (n.response_deadline at time zone 'America/New_York')::date, n.naics, n.set_aside, nullif(concat_ws(', ', n.city, n.state), ''), n.ui_link,
    case when n.source = 'BidMatch' then 'MyBidMatch (' || coalesce(n.level, 'unsorted') || ')' when n.source = 'Link' then 'Added by link' else n.source end,
    concat_ws(E'\n', 'Notice type: ' || n.notice_type, 'Office: ' || n.office, 'Posted: ' || n.posted_date, 'PSC: ' || n.psc, fed_contacts_text(n.contacts), left(n.summary, 800),
      case when n.awardee is not null then 'Awardee: ' || n.awardee || coalesce(' ($' || to_char(n.award_amount, 'FM999,999,999,990') || ')', '') end),
    n.award_amount, jsonb_build_object('sam_notice_id', n.notice_id), member_name(),
    n.contacts -> 0 ->> 'name', n.contacts -> 0 ->> 'email')
  returning id into oid;
  update fed_notices set status = 'Added', opportunity_id = oid, status_by = member_name() where workspace_id = w and notice_id = p_notice;
  perform fed_contacts_upsert(w, n);
  return oid;
end $$;
