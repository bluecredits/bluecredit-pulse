-- Pulse fix 2026-11-06 (c): one NAICS + keywords profile, contracting officers into Contacts, contacts on cards, SAM.gov through sam-relay
-- Safe to run more than once. Your existing searches are merged into the profile and paused (not deleted).
alter table public.fed_notices add column if not exists contacts jsonb not null default '[]';
alter table public.fed_notices add column if not exists detail_at timestamptz;
alter table public.fed_config add column if not exists sam_relay_url text;
alter table public.fed_searches add column if not exists is_profile boolean not null default false;
alter table public.fed_searches add column if not exists match_any boolean not null default false;
create unique index if not exists ux_fed_searches_profile on public.fed_searches (workspace_id, source) where is_profile;

create or replace function public.fed_person(p text) returns text language plpgsql immutable as $$
declare n text := trim(both ' ,;' from coalesce(p, ''));
begin
  n := regexp_replace(n, '\m(Mr|Ms|Mrs|Miss|Dr)\.?\s+', '', 'gi');
  if n ~ '^[^,]+,[^,]+$' then n := trim(split_part(n, ',', 2)) || ' ' || trim(split_part(n, ',', 1)); end if;
  n := regexp_replace(n, '\s+', ' ', 'g');
  if n = upper(n) then n := initcap(n); end if;
  return nullif(n, '');
end $$;

create or replace function public.fed_bm_contacts(p_body text) returns jsonb language plpgsql immutable as $$
declare seg text; em text[]; parts text[]; out jsonb := '[]'; i int; nm text; ph text;
  ere text := '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}';
begin
  if p_body is null then return out; end if;
  seg := substring(p_body from '\mPOC\s+(.{1,250}.{0,250})');
  if seg is not null then
    em := array(select m[1] from regexp_matches(seg, '(' || ere || ')', 'g') m);
    parts := regexp_split_to_array(seg, ere);
    for i in 1 .. least(coalesce(array_length(em, 1), 0), 3) loop
      nm := trim(both ' ,' from regexp_replace(parts[i], '^\s*,?\s*tel:\s*[0-9() .+-]*[0-9]', ''));
      -- past the POC line the text is the notice itself: stop at anything that doesn't look like a name
      exit when i > 1 and (length(nm) > 45 or nm !~ '^[A-Za-z][A-Za-z .,''-]*$' or array_length(regexp_split_to_array(trim(nm), '\s+'), 1) > 5);
      ph := substring(parts[i + 1] from '^\s*,\s*tel:\s*([0-9() .+-]*[0-9])');
      out := out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('name', case when length(nm) <= 45 and nm ~ '^[A-Za-z][A-Za-z .,''-]*$' then fed_person(nm) end,
               'email', lower(em[i]), 'phone', nullif(trim(ph), ''))));
    end loop;
  end if;
  if jsonb_array_length(out) = 0 then
    nm := substring(p_body from '(' || ere || ')');
    if nm is not null then out := jsonb_build_array(jsonb_build_object('email', lower(trim(trailing '.' from nm)))); end if;
  end if;
  return out;
end $$;

create or replace function public.fed_contacts_text(p jsonb) returns text language sql immutable as $$
  select string_agg('Contact: ' || concat_ws(', ', nullif(concat_ws(' ', c ->> 'name', '(' || coalesce(c ->> 'title', c ->> 'type') || ')'), ''), c ->> 'email', c ->> 'phone'), E'\n')
    from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]' end) c $$;

create or replace function public.fed_stem(k text) returns text language sql immutable as $$
  select case when length(regexp_replace(lower(trim(k)), '(ical|al|ing|ed|es|s)$', '')) >= 4
              then regexp_replace(lower(trim(k)), '(ical|al|ing|ed|es|s)$', '') else lower(trim(k)) end $$;

create or replace function public.fed_fits(n public.fed_notices, s public.fed_searches) returns boolean
language sql stable set search_path = public as $$
  with t as (select
      -- codes: NAICS for contracts, assistance listings for grants
      case when n.source = 'Grants.gov' then cardinality(s.aln) > 0 and exists (select 1 from unnest(s.aln) q, unnest(n.aln) c where c like trim(q) || '%')
           else cardinality(s.naics) > 0 and exists (select 1 from unnest(s.naics) q, unnest(n.naics_all) c where c like trim(q) || '%') end as code_hit,
      case when n.source = 'Grants.gov' then cardinality(s.aln) = 0 else cardinality(s.naics) = 0 end as no_codes,
      cardinality(s.keywords) > 0 and exists (select 1 from unnest(s.keywords) k where trim(k) <> ''
        and concat_ws(' ', n.title, n.sol_number, case when s.match_any then n.summary end) ilike '%' || fed_stem(k) || '%') as kw_hit)
  select n.source = s.source
     and (cardinality(s.agencies) = 0 or exists (select 1 from unnest(s.agencies) a where concat_ws(' ', n.path_name, n.agency, n.subtier) ilike '%' || trim(a) || '%'))
     and not exists (select 1 from unnest(s.exclude) k where trim(k) <> '' and n.title ilike '%' || trim(k) || '%')
     and (cardinality(s.notice_types) = 0 or n.notice_type = any (s.notice_types) or n.base_type = any (s.notice_types))
     and (not s.open_only or n.response_deadline is null or n.response_deadline >= now())
     and case when s.match_any then t.code_hit or t.kw_hit
              else (t.no_codes or t.code_hit) and (cardinality(s.keywords) = 0 or t.kw_hit) end
     and (n.source = 'Grants.gov' or (
           (s.size = 'any' or (s.size = 'small' and coalesce(n.set_aside_code, '') not in ('', 'NONE'))
                or (s.size = 'unrestricted' and coalesce(n.set_aside_code, '') in ('', 'NONE')))
           and (cardinality(s.set_asides) = 0 or n.set_aside_code = any (s.set_asides))))
    from t $$;

create or replace function public.fed_store(p_ws uuid, p_body jsonb) returns int
language plpgsql volatile security definer set search_path = public as $$
declare v int;
begin
  insert into fed_notices as f (workspace_id, notice_id, title, sol_number, path_name, agency, subtier, office, notice_type, base_type, posted_date,
      response_deadline, naics, naics_all, psc, set_aside_code, set_aside, state, city, ui_link, award_amount, awardee, active, contacts)
  select p_ws, o ->> 'noticeId', o ->> 'title', o ->> 'solicitationNumber', o ->> 'fullParentPathName',
      fed_name(split_part(o ->> 'fullParentPathName', '.', 1)), fed_name(nullif(split_part(o ->> 'fullParentPathName', '.', 2), '')),
      fed_name(nullif(regexp_replace(o ->> 'fullParentPathName', '^.*\.', ''), '')),
      o ->> 'type', o ->> 'baseType', fed_ts(o ->> 'postedDate')::date, fed_ts(o ->> 'responseDeadLine'),
      o ->> 'naicsCode',
      coalesce((select array_agg(distinct x) from (select jsonb_array_elements_text(case when jsonb_typeof(o -> 'naicsCodes') = 'array' then o -> 'naicsCodes' else '[]' end) x
                union select o ->> 'naicsCode') z where x is not null and x <> ''), '{}'),
      o ->> 'classificationCode', nullif(o ->> 'typeOfSetAside', ''), nullif(o ->> 'typeOfSetAsideDescription', ''),
      o #>> '{placeOfPerformance,state,code}', o #>> '{placeOfPerformance,city,name}', o ->> 'uiLink',
      fed_num(o #>> '{award,amount}'), o #>> '{award,awardee,name}', (o ->> 'active') = 'Yes',
      coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('name', fed_person(p ->> 'fullName'), 'title', nullif(trim(p ->> 'title'), ''),
          'email', nullif(lower(trim(p ->> 'email')), ''), 'phone', nullif(trim(p ->> 'phone'), ''), 'type', initcap(nullif(p ->> 'type', '')))))
        from jsonb_array_elements(case when jsonb_typeof(o -> 'pointOfContact') = 'array' then o -> 'pointOfContact' else '[]' end) p
       where coalesce(nullif(trim(p ->> 'fullName'), ''), nullif(trim(p ->> 'email'), '')) is not null), '[]')
    from jsonb_array_elements(case when jsonb_typeof(p_body -> 'opportunitiesData') = 'array' then p_body -> 'opportunitiesData' else '[]' end) o
   where coalesce(o ->> 'noticeId', '') <> ''
  on conflict (workspace_id, notice_id) do update set title = excluded.title, sol_number = excluded.sol_number, path_name = excluded.path_name,
      agency = excluded.agency, subtier = excluded.subtier, office = excluded.office, notice_type = excluded.notice_type, base_type = excluded.base_type,
      posted_date = excluded.posted_date, response_deadline = excluded.response_deadline, naics = excluded.naics, naics_all = excluded.naics_all,
      psc = excluded.psc, set_aside_code = excluded.set_aside_code, set_aside = excluded.set_aside, state = excluded.state, city = excluded.city,
      ui_link = excluded.ui_link, award_amount = excluded.award_amount, awardee = excluded.awardee, active = excluded.active, contacts = excluded.contacts, updated_at = now()
    where (f.title, f.response_deadline, f.active, f.set_aside_code, f.notice_type, f.contacts) is distinct from
          (excluded.title, excluded.response_deadline, excluded.active, excluded.set_aside_code, excluded.notice_type, excluded.contacts);
  get diagnostics v = row_count;
  return v;
end $$;

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

create or replace function public.fed_store_bm(p_ws uuid, p_kind text, p_ref text, p_seq int, p_html text) returns int
language plpgsql volatile security definer set search_path = public as $$
declare m text[]; n int := 0; d date; body text; h4 text; due text; sol text; ts timestamptz;
begin
  if p_kind = 'sub' then
    if p_html !~* 'mybidmatch' then raise exception 'That page is not a MyBidMatch list'; end if;
    for m in select regexp_matches(p_html, 'href="/go\?doc=([0-9A-Fa-f-]{36})"[^>]*>[A-Za-z]+, ([A-Za-z]{3} +[0-9]{1,2}, [0-9]{4})</a>\s*</td>\s*<td[^>]*>\s*([0-9]+)', 'g') loop
      d := to_date(regexp_replace(m[2], ' +', ' ', 'g'), 'Mon DD, YYYY');
      if d >= current_date - 3 and m[3]::int > 0 and not exists (select 1 from fed_bm_docs where workspace_id = p_ws and doc = upper(m[1])) then
        insert into fed_bm_docs (workspace_id, doc, list_date, articles) values (p_ws, upper(m[1]), d, m[3]::int);
        perform fed_request_bm(p_ws, 'doc', upper(m[1]));
        n := n + 1;
      end if;
    end loop;
  elsif p_kind = 'doc' then
    select list_date into d from fed_bm_docs where workspace_id = p_ws and doc = upper(p_ref);
    for m in select regexp_matches(p_html,
        '<tr>\s*<td[^>]*>\s*([0-9]+)\s*</td>\s*<td[^>]*>([^<]*)</td>\s*<td[^>]*>([^<]*)</td>\s*<td[^>]*>([^<]*)</td>\s*<td[^>]*>\s*<a href="/article\?doc=([0-9A-Fa-f-]{36})&(?:amp;)?seq=([0-9]+)"[^>]*>([^<]*)</a>\s*</td>\s*<td[^>]*>([^<]*)</td>', 'g') loop
      insert into fed_notices (workspace_id, notice_id, source, title, agency, path_name, base_type, notice_type, psc, posted_date, naics, naics_all, ui_link, level, state, active, bm_keywords)
      values (p_ws, 'B' || upper(m[5]) || '-' || m[6], 'BidMatch', fed_unhtml(m[7]),
        case when trim(m[2]) = 'procure' then fed_name(fed_unhtml(m[3])) else fed_unhtml(m[3]) end, fed_unhtml(m[3]), trim(m[2]),
        case trim(m[2]) when 'procure' then 'Federal notice' when 'bid' then 'Bid' else initcap(trim(m[2])) end, nullif(trim(m[4]), ''), d,
        substring(m[8] from 'naics!([0-9]+)'), coalesce(array(select x[1] from regexp_matches(m[8], 'naics!([0-9]+)', 'g') x), '{}'),
        'https://mybidmatch.outreachsystems.com/article?doc=' || upper(m[5]) || '&seq=' || m[6],
        fed_level(trim(m[2]), fed_unhtml(m[3]), null), nullif(substring(fed_unhtml(m[3]) from '^([A-Za-z .]+) - '), ''), true, fed_unhtml(m[8]))
      on conflict (workspace_id, notice_id) do nothing;
      if found then n := n + 1; perform fed_request_bm(p_ws, 'article', upper(m[5]), m[6]::int); end if;
    end loop;
  else
    h4 := fed_unhtml(substring(p_html from '<h4>(.*?)</h4>'));
    body := fed_unhtml(substring(p_html from '</h4>(.*?)<i>OutreachSystems'));
    m := regexp_match(body, '(?i)(?:due date|closing on|closing date|response date|responses? due|offers due|bids? due|deadline|\mdue\M)[^0-9]{0,30}([0-9]{1,2}/[0-9]{1,2}/[0-9]{2,4})(?:[ ,]*(?:at)?[ ]*([0-9]{1,2}:[0-9]{2}) *([AP]M))?');
    begin
      d := to_date(regexp_replace(m[1], '/([0-9]{2})$', '/20\1'), 'MM/DD/YYYY');
      ts := case when m[2] is not null then (d + to_timestamp(m[2] || ' ' || upper(m[3]), 'HH12:MI AM')::time) at time zone 'America/New_York'
                 when d is not null then (d + time '23:59') at time zone 'America/New_York' end;
    exception when others then ts := null; end;
    sol := trim(substring(body from '\mSOL\s+((?:(?:RFP|RFQ|IFB|ITB|RFI|RFB)\s+)?[A-Z0-9][A-Za-z0-9_./-]{2,})'));
    due := substring(body from '(?i)set-aside:\s*(.+?\))');
    update fed_notices set summary = left(body, 6000), contacts = fed_bm_contacts(body), sol_number = coalesce(sol, sol_number), response_deadline = coalesce(ts, response_deadline),
        set_aside = coalesce(due, set_aside), set_aside_code = coalesce(case when due ~* 'small business' then 'SB' end, set_aside_code),
        subtier = case when base_type = 'procure' then coalesce(fed_name(nullif(trim(split_part(h4, ',', 2)), '')), subtier) else subtier end,
        office = case when base_type = 'procure' then coalesce(fed_name(nullif(trim(split_part(h4, ',', 3)), '')), office) else office end,
        state = coalesce(state, substring(body from 'Place of Performance:[^,]*?\m([A-Z]{2})\M\s')),
        naics_all = (select coalesce(array_agg(distinct x), '{}') from (select unnest(naics_all) x union select (regexp_matches(body, '(?i)naics(?: code)?(?: is|:)?\s*([0-9]{6})', 'g'))[1]) z),
        naics = coalesce(naics, substring(body from '(?i)naics(?: code)?(?: is|:)?\s*([0-9]{6})')),
        level = fed_level(base_type, agency, coalesce(h4, '') || ' ' || coalesce(body, '')), updated_at = now()
     where workspace_id = p_ws and notice_id = 'B' || upper(p_ref) || '-' || p_seq;
    get diagnostics n = row_count;
  end if;
  return n;
end $$;

create or replace function public.fed_request_grant_detail(p_ws uuid, p_notice text) returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare rid bigint;
begin
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 60000)' into rid
    using 'https://api.grants.gov/v1/api/fetchOpportunity', jsonb_build_object('opportunityId', substring(p_notice from 2)::bigint),
          '{"Content-Type": "application/json"}'::jsonb;
  insert into fed_calls (workspace_id, request_id, source, ref) values (p_ws, rid, 'GrantDetail', p_notice);
  return true;
exception when undefined_function or invalid_schema_name or undefined_table or invalid_text_representation then return false;
end $$;

create or replace function public.fed_store_grant_detail(p_ws uuid, p_notice text, p_body jsonb) returns int
language plpgsql volatile security definer set search_path = public as $$
declare d jsonb := coalesce(p_body #> '{data,synopsis}', p_body #> '{data,forecast}', '{}'); ph text; n int;
begin
  ph := nullif(trim(d ->> 'agencyContactPhone'), ''); if ph !~ '[0-9]{3}' then ph := null; end if;
  update fed_notices set detail_at = now(),
      contacts = case when coalesce(nullif(trim(d ->> 'agencyContactName'), ''), nullif(trim(d ->> 'agencyContactEmail'), '')) is not null
        then jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('name', fed_person(d ->> 'agencyContactName'),
               'email', nullif(lower(trim(d ->> 'agencyContactEmail')), ''), 'phone', ph, 'type', 'Agency contact'))) else contacts end,
      summary = coalesce(summary, left(fed_unhtml(coalesce(d ->> 'synopsisDesc', d ->> 'forecastDesc')), 6000))
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

create or replace function public.fed_list(p_source text default 'SAM.gov', p_status text default 'New', p_search bigint default null, p_sort text default 'posted', p_limit int default 400) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by case when p_sort = 'due' then x.response_deadline end nulls last, x.posted_date desc nulls last, x.first_seen desc), '[]')
  from (select n.notice_id, n.title, n.sol_number, n.agency, n.subtier, n.office, n.notice_type, n.posted_date, n.response_deadline, n.naics, n.set_aside,
               n.set_aside_code, n.state, n.city, n.ui_link, n.award_amount, n.awardee, n.status, n.opportunity_id, n.funding_id, n.first_seen, n.source, n.aln, n.level, left(n.summary, 6000) summary, n.naics_all, n.psc, n.bm_keywords,
               (select coalesce(jsonb_agg(c || coalesce((select jsonb_build_object('cid', ct.id) from contacts ct where ct.workspace_id = n.workspace_id
                    and c ? 'email' and lower(ct.email) = lower(c ->> 'email') limit 1), '{}')), '[]') from jsonb_array_elements(n.contacts) c) contacts,
               (select array_agg(m.search_id) from fed_matches m where m.workspace_id = n.workspace_id and m.notice_id = n.notice_id) searches
          from fed_notices n
         where n.workspace_id = staff_ws() and n.source = coalesce(p_source, 'SAM.gov') and (p_status = 'All' or n.status = p_status)
           and ((n.source = 'BidMatch' and p_search is null) or (n.status <> 'New' and p_search is null)
                or exists (select 1 from fed_matches m where m.workspace_id = n.workspace_id and m.notice_id = n.notice_id and (p_search is null or m.search_id = p_search)))
         order by case when p_sort = 'due' then n.response_deadline end nulls last, n.posted_date desc nulls last, n.first_seen desc
         limit least(greatest(coalesce(p_limit, 400), 1), 1000)) x $$;

create or replace function public.fed_contacts_upsert(p_ws uuid, n public.fed_notices, p_email text default null) returns int
language plpgsql volatile security definer set search_path = public as $$
declare c jsonb; cid bigint; k int := 0; org text; v_role text; line text;
begin
  org := coalesce(nullif(concat_ws(' / ', n.agency, nullif(n.subtier, n.agency)), ''), n.office);
  line := format('From %s: %s%s', case n.source when 'BidMatch' then 'MyBidMatch' else n.source end, n.title, coalesce(' (' || n.sol_number || ')', ''));
  for c in select * from jsonb_array_elements(case when jsonb_typeof(n.contacts) = 'array' then n.contacts else '[]' end) loop
    continue when p_email is not null and lower(coalesce(c ->> 'email', '')) <> lower(p_email);
    continue when coalesce(c ->> 'email', c ->> 'name') is null;
    v_role := coalesce(c ->> 'title', case when n.source = 'Grants.gov' then 'Grants contact' when n.source = 'SAM.gov' or n.level = 'Federal' then 'Contracting Officer' else 'Buyer' end);
    select id into cid from contacts where workspace_id = p_ws
       and ((c ? 'email' and lower(email) = lower(c ->> 'email')) or (not c ? 'email' and lower(name) = lower(c ->> 'name') and organization is not distinct from org))
     order by id limit 1;
    if cid is null then
      insert into contacts (workspace_id, name, organization, role, email, phone, category, source, tags, notes, updated_by)
      values (p_ws, coalesce(c ->> 'name', c ->> 'email'), org, v_role, c ->> 'email', c ->> 'phone', 'Government', 'Opportunities', 'Contracting officer', line, member_name())
      returning id into cid;
    else
      update contacts set name = case when name is null or name = email then coalesce(c ->> 'name', name) else name end,
          phone = coalesce(phone, c ->> 'phone'), role = coalesce(contacts.role, v_role), organization = coalesce(contacts.organization, org),
          notes = case when position(line in coalesce(notes, '')) > 0 then notes else concat_ws(E'\n', notes, line) end, updated_at = now(), updated_by = member_name()
       where id = cid;
    end if;
    k := k + 1; cid := null;
  end loop;
  return k;
end $$;

create or replace function public.fed_save_contact(p_notice text, p_email text default null) returns int
language plpgsql volatile security definer set search_path = public as $$
declare w uuid := staff_ws(); n fed_notices;
begin
  if w is null then raise exception 'Only team members can save contacts.'; end if;
  select * into n from fed_notices where workspace_id = w and notice_id = p_notice;
  if not found then raise exception 'Notice not found.'; end if;
  return fed_contacts_upsert(w, n, nullif(p_email, ''));
end $$;

create or replace function public.fed_profile_ws(p_ws uuid, p_source text) returns public.fed_searches
language plpgsql volatile security definer set search_path = public as $$
declare pr fed_searches;
begin
  select * into pr from fed_searches where workspace_id = p_ws and source = p_source and is_profile;
  if found then return pr; end if;
  insert into fed_searches (workspace_id, name, source, is_profile, match_any, naics, aln, keywords, exclude, agencies, set_asides, notice_types, size, open_only, active)
  select p_ws, case when p_source = 'Grants.gov' then 'My grants profile' else 'My contracts profile' end, p_source, true, true,
     coalesce((select array_agg(distinct x order by x) from fed_searches s, unnest(s.naics) x where s.workspace_id = p_ws and s.source = p_source and s.active), '{}'),
     coalesce((select array_agg(distinct x order by x) from fed_searches s, unnest(s.aln) x where s.workspace_id = p_ws and s.source = p_source and s.active), '{}'),
     coalesce((select array_agg(distinct lower(trim(x))) from fed_searches s, unnest(s.keywords) x where s.workspace_id = p_ws and s.source = p_source and s.active and trim(x) <> ''), '{}'),
     coalesce((select array_agg(distinct lower(trim(x))) from fed_searches s, unnest(s.exclude) x where s.workspace_id = p_ws and s.source = p_source and s.active and trim(x) <> ''), '{}'),
     '{}', '{}',
     case when p_source = 'Grants.gov' then '{Posted,Forecasted}'::text[] else '{Solicitation,"Combined Synopsis/Solicitation",Presolicitation,"Sources Sought"}'::text[] end,
     case when p_source <> 'Grants.gov' and exists (select 1 from fed_searches s where s.workspace_id = p_ws and s.source = p_source and s.active and s.size = 'small') then 'small' else 'any' end,
     true, true
  returning * into pr;
  update fed_searches set active = false where workspace_id = p_ws and source = p_source and not is_profile;
  delete from fed_matches m using fed_searches s where m.search_id = s.id and s.workspace_id = p_ws and s.source = p_source and not s.is_profile;
  perform fed_rematch(p_ws, pr.id);
  return pr;
end $$;

create or replace function public.fed_profile(p_source text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare w uuid := staff_ws();
begin
  if w is null then raise exception 'Only team members can use Opportunities.'; end if;
  if p_source not in ('SAM.gov', 'Grants.gov') then raise exception 'Unknown source %', p_source; end if;
  insert into fed_config (workspace_id) values (w) on conflict do nothing;
  return to_jsonb(fed_profile_ws(w, p_source));
end $$;

create or replace function public.fed_add_to_opportunities(p_notice text, p_kind text default null) returns bigint
language plpgsql volatile security definer set search_path = public as $$
declare w uuid := staff_ws(); n fed_notices; oid bigint;
begin
  if w is null then raise exception 'Only team members can add opportunities.'; end if;
  select * into n from fed_notices where workspace_id = w and notice_id = p_notice for update;
  if not found then raise exception 'Notice not found.'; end if;
  if n.opportunity_id is not null and exists (select 1 from opportunities where id = n.opportunity_id) then return n.opportunity_id; end if;
  insert into opportunities (workspace_id, title, kind, agency, ref_no, stage, deadline, naics, set_aside, location, url, source, notes, value, meta, updated_by,
      contact_name, contact_email)
  values (w, n.title, coalesce(nullif(p_kind, ''), 'Federal Contract'), concat_ws(' / ', n.agency, n.subtier), n.sol_number, 'Identified',
    (n.response_deadline at time zone 'America/New_York')::date, n.naics, n.set_aside, nullif(concat_ws(', ', n.city, n.state), ''), n.ui_link,
    case when n.source = 'BidMatch' then 'MyBidMatch (' || coalesce(n.level, 'unsorted') || ')' else n.source end,
    concat_ws(E'\n', 'Notice type: ' || n.notice_type, 'Office: ' || n.office, 'Posted: ' || n.posted_date, 'PSC: ' || n.psc, fed_contacts_text(n.contacts), left(n.summary, 800),
      case when n.awardee is not null then 'Awardee: ' || n.awardee || coalesce(' ($' || to_char(n.award_amount, 'FM999,999,999,990') || ')', '') end),
    n.award_amount, jsonb_build_object('sam_notice_id', n.notice_id), member_name(),
    n.contacts -> 0 ->> 'name', n.contacts -> 0 ->> 'email')
  returning id into oid;
  update fed_notices set status = 'Added', opportunity_id = oid, status_by = member_name() where workspace_id = w and notice_id = p_notice;
  perform fed_contacts_upsert(w, n);
  return oid;
end $$;

create or replace function public.fed_add_to_funding(p_notice text) returns bigint
language plpgsql volatile security definer set search_path = public as $$
declare w uuid := staff_ws(); n fed_notices; fid bigint;
begin
  if w is null then raise exception 'Only team members can add funding.'; end if;
  select * into n from fed_notices where workspace_id = w and notice_id = p_notice for update;
  if not found then raise exception 'Grant not found.'; end if;
  if n.funding_id is not null and exists (select 1 from funding where id = n.funding_id) then return n.funding_id; end if;
  insert into funding (workspace_id, name, organization, type, status, deadline, url, source, notes, updated_by, contact_email)
  values (w, n.title, n.agency, 'Grant', 'Identified', (n.response_deadline at time zone 'America/New_York')::date, n.ui_link, 'Grants.gov',
    concat_ws(E'\n', 'Opportunity number: ' || n.sol_number, 'Status: ' || n.notice_type, 'Posted: ' || n.posted_date,
      case when cardinality(n.aln) > 0 then 'Assistance listing: ' || array_to_string(n.aln, ', ') end, fed_contacts_text(n.contacts)), member_name(),
    n.contacts -> 0 ->> 'email')
  returning id into fid;
  update fed_notices set status = 'Added', funding_id = fid, status_by = member_name() where workspace_id = w and notice_id = p_notice;
  perform fed_contacts_upsert(w, n);
  return fid;
end $$;

create or replace function public.build_snapshot(p_cadence text, p_as_of date default null) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  t date := coalesce(p_as_of, current_date);
  lb int; ah int; since date; until date;
  ao text[] := array['Identified', 'Qualifying', 'Pursuing', 'Submitted'];
  af text[] := array['Identified', 'Pursuing', 'Submitted'];
  snap jsonb; prev record; won int; lost int;
  o jsonb; f jsonb;
begin
  if not is_member() then raise exception 'Not a member'; end if;
  select v.lb, v.ah into lb, ah from (values ('daily', 1, 7), ('weekly', 7, 30), ('monthly', 31, 60), ('quarterly', 92, 120))
    v(c, lb, ah) where v.c = p_cadence;
  if lb is null then raise exception 'Unknown cadence %', p_cadence; end if;
  since := t - lb; until := t + ah;

  snap := jsonb_build_object('cadence', p_cadence, 'as_of', t, 'since', since, 'until', until,
    'opp_deadlines', coalesce((select jsonb_agg(x order by x.deadline) from (
        select id, title, agency, deadline, stage, priority, owner, value, value_text from opportunities
         where stage = any (ao) and deadline between t and until) x), '[]'),
    'funding_deadlines', coalesce((select jsonb_agg(x order by x.deadline) from (
        select id, name, organization, deadline, status, owner, amount_text from funding
         where status = any (af) and deadline between t and until) x), '[]'),
    'stale_count', (select count(*) from opportunities where stage in ('Identified', 'Qualifying', 'Pursuing') and deadline < t)
                 + (select count(*) from funding where status in ('Identified', 'Pursuing') and deadline < t),
    'stale', coalesce((select jsonb_agg(x order by x.deadline desc) from (
        select * from (
          select 'opportunities' entity, id, title as name, deadline, stage status, owner from opportunities
           where stage in ('Identified', 'Qualifying', 'Pursuing') and deadline < t
          union all
          select 'funding', id, name, deadline, status, owner from funding
           where status in ('Identified', 'Pursuing') and deadline < t) u
        order by deadline desc limit 25) x), '[]'),
    'actions_overdue', coalesce((select jsonb_agg(a order by a.due_date) from actions a where status = 'Open' and due_date < t), '[]'),
    'actions_completed', coalesce((select jsonb_agg(a order by a.updated_at desc) from actions a
        where status = 'Done' and updated_at::date >= since), '[]'),
    'followups_due', coalesce((select jsonb_agg(x order by x.next_step_date) from (
        select id, name, organization, next_step, next_step_date, owner, status from contacts
         where next_step_date <= until and coalesce(status, '') not in ('Do Not Contact', 'Dormant')
         order by next_step_date limit 100) x), '[]'),
    'contacts_touched', (select count(*) from contacts where last_touch >= since),
    'moves', jsonb_build_object(
        'submitted', coalesce((select jsonb_agg(a order by a.ts desc) from activity a where field in ('stage', 'status')
            and entity in ('opportunities', 'funding') and ts::date >= since and new_value = 'Submitted'), '[]'),
        'won', coalesce((select jsonb_agg(a order by a.ts desc) from activity a where field in ('stage', 'status')
            and entity in ('opportunities', 'funding') and ts::date >= since and new_value = 'Won'), '[]'),
        'lost', coalesce((select jsonb_agg(a order by a.ts desc) from activity a where field in ('stage', 'status')
            and entity in ('opportunities', 'funding') and ts::date >= since and new_value in ('Lost', 'Missed')), '[]')),
    'created', jsonb_build_object(
        'opportunities', (select count(*) from activity where entity = 'opportunities' and action = 'create' and ts::date >= since),
        'funding', (select count(*) from activity where entity = 'funding' and action = 'create' and ts::date >= since),
        'contacts', (select count(*) from activity where entity = 'contacts' and action = 'create' and ts::date >= since)));

  -- new leads from Opportunities (SAM.gov, Grants.gov, MyBidMatch) found in this period and not yet reviewed
  if to_regclass('public.fed_notices') is not null then
    snap := snap || jsonb_build_object('leads', coalesce((select jsonb_object_agg(src, obj) from (
      select n.source src, jsonb_build_object(
          'new', count(*) filter (where n.status = 'New'), 'saved', count(*) filter (where n.status = 'Saved'),
          'due_soon', count(*) filter (where n.response_deadline::date between t and until),
          'items', coalesce(jsonb_agg(jsonb_build_object('id', n.notice_id, 'title', n.title, 'agency', coalesce(n.subtier, n.agency), 'due', n.response_deadline,
                      'status', n.status, 'level', n.level, 'naics', n.naics, 'url', n.ui_link)
                    order by n.response_deadline nulls last, n.posted_date desc) filter (where n.rk <= 12), '[]')) obj
        from (select f.*, row_number() over (partition by f.source order by f.response_deadline nulls last, f.posted_date desc) rk
                from fed_notices f
               where f.status in ('New', 'Saved') and f.first_seen::date >= since and f.first_seen::date <= t
                 and (f.response_deadline is null or f.response_deadline >= t)
                 and (f.source = 'BidMatch' or f.status = 'Saved' or exists (select 1 from fed_matches m where m.workspace_id = f.workspace_id and m.notice_id = f.notice_id))) n
       group by n.source) z), '{}'));
  end if;

  if p_cadence <> 'daily' then
    snap := snap || jsonb_build_object(
      'opp_pipeline', coalesce((select jsonb_agg(jsonb_build_object('k', stage, 'n', n, 'value', v) order by n desc) from (
          select stage, count(*) n, coalesce(sum(value), 0) v from opportunities group by stage) s), '[]'),
      'funding_pipeline', coalesce((select jsonb_agg(jsonb_build_object('k', status, 'n', n) order by n desc) from (
          select status, count(*) n from funding where coalesce(status, '') <> 'Catalog' group by status) s), '[]'));
  end if;

  if p_cadence in ('monthly', 'quarterly') then
    select coalesce(jsonb_object_agg(new_value, n), '{}') into o from (
      select new_value, count(distinct entity_id) n from activity where entity = 'opportunities' and field = 'stage'
         and ts::date >= since group by new_value) s;
    select coalesce(jsonb_object_agg(new_value, n), '{}') into f from (
      select new_value, count(distinct entity_id) n from activity where entity = 'funding' and field = 'status'
         and ts::date >= since group by new_value) s;
    won := coalesce((o ->> 'Won')::int, 0) + coalesce((f ->> 'Won')::int, 0);
    lost := coalesce((o ->> 'Lost')::int, 0) + coalesce((f ->> 'Lost')::int, 0);
    snap := snap || jsonb_build_object(
      'results', jsonb_build_object('opportunities', o, 'funding', f,
        'win_rate', case when won + lost > 0 then round(100.0 * won / (won + lost)) end,
        'value_won', (select coalesce(sum(value), 0) from opportunities where stage = 'Won' and id in (
            select entity_id from activity where entity = 'opportunities' and new_value = 'Won' and ts::date >= since)),
        'funding_submitted_by_date', (select count(*) from funding where submitted_date between since and t)),
      'by_owner', coalesce((select jsonb_agg(x order by x.active_opps + x.active_funding desc) from (
          select coalesce(nullif(owner, ''), 'Unassigned') owner,
                 count(*) filter (where src = 'o' and st = any (ao)) active_opps,
                 count(*) filter (where src = 'f' and st = any (af)) active_funding,
                 count(*) filter (where st = 'Submitted') submitted,
                 count(*) filter (where st = 'Won') won
            from (select owner, stage st, 'o' src from opportunities
                  union all select owner, status, 'f' from funding where coalesce(status, '') <> 'Catalog') u
           group by 1) x), '[]'));
  end if;

  select id, review_date, title into prev from reviews where cadence = p_cadence and review_date < t
   order by review_date desc, id desc limit 1;
  if found then
    snap := snap || jsonb_build_object('previous_review', jsonb_build_object('id', prev.id, 'review_date', prev.review_date, 'title', prev.title),
      'carry_over', coalesce((select jsonb_agg(a) from actions a where review_id = prev.id and status = 'Open'), '[]'));
  else
    snap := snap || jsonb_build_object('previous_review', null, 'carry_over', '[]'::jsonb);
  end if;
  return snap;
end $$;

revoke execute on function public.fed_contacts_upsert(uuid, public.fed_notices, text), public.fed_profile_ws(uuid, text),
  public.fed_request_grant_detail(uuid, text), public.fed_store_grant_detail(uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.fed_save_contact(text, text), public.fed_profile(text) from public, anon;
grant execute on function public.fed_save_contact(text, text), public.fed_profile(text) to authenticated;
-- every workspace that uses Opportunities gets its profiles (built from its searches)
select public.fed_profile_ws(c.workspace_id, x.src) from public.fed_config c, (values ('SAM.gov'), ('Grants.gov')) x(src);


-- contacts for the bids already read
update public.fed_notices set contacts = public.fed_bm_contacts(summary) where source = 'BidMatch' and summary is not null;
-- SAM.gov through the relay, and fetch now
update public.fed_config set sam_relay_url = 'https://dtnohwaxnnwqplmdtdeq.supabase.co/functions/v1/sam-relay', last_error = null, next_fetch_at = null
 where key_secret_id is not null;
select (select count(*) from public.fed_searches where is_profile) as profiles,
       (select count(*) from public.fed_matches m join public.fed_searches s on s.id = m.search_id where s.is_profile) as profile_matches,
       (select count(*) from public.fed_notices where jsonb_array_length(contacts) > 0) as notices_with_a_contact;
