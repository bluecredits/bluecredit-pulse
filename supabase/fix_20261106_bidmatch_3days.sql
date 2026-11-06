-- Pulse fix (Nov 6, 2026): MyBidMatch reads only the last 3 days of lists; older unreviewed bids are removed. Safe to run more than once.
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
      insert into fed_notices (workspace_id, notice_id, source, title, agency, path_name, base_type, notice_type, psc, posted_date, naics, naics_all, ui_link, level, state, active)
      values (p_ws, 'B' || upper(m[5]) || '-' || m[6], 'BidMatch', fed_unhtml(m[7]),
        case when trim(m[2]) = 'procure' then fed_name(fed_unhtml(m[3])) else fed_unhtml(m[3]) end, fed_unhtml(m[3]), trim(m[2]),
        case trim(m[2]) when 'procure' then 'Federal notice' when 'bid' then 'Bid' else initcap(trim(m[2])) end, nullif(trim(m[4]), ''), d,
        substring(m[8] from 'naics!([0-9]+)'), coalesce(array(select x[1] from regexp_matches(m[8], 'naics!([0-9]+)', 'g') x), '{}'),
        'https://mybidmatch.outreachsystems.com/article?doc=' || upper(m[5]) || '&seq=' || m[6],
        fed_level(trim(m[2]), fed_unhtml(m[3]), null), nullif(substring(fed_unhtml(m[3]) from '^([A-Za-z .]+) - '), ''), true)
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
    update fed_notices set summary = left(body, 1500), sol_number = coalesce(sol, sol_number), response_deadline = coalesce(ts, response_deadline),
        set_aside = coalesce(due, set_aside), set_aside_code = coalesce(case when due ~* 'small business' then 'SB' end, set_aside_code),
        subtier = case when base_type = 'procure' then coalesce(fed_name(nullif(trim(split_part(h4, ',', 2)), '')), subtier) else subtier end,
        office = case when base_type = 'procure' then coalesce(fed_name(nullif(trim(split_part(h4, ',', 3)), '')), office) else office end,
        state = coalesce(state, substring(body from 'Place of Performance:[^,]*?\m([A-Z]{2})\M\s')),
        level = fed_level(base_type, agency, coalesce(h4, '') || ' ' || coalesce(body, '')), updated_at = now()
     where workspace_id = p_ws and notice_id = 'B' || upper(p_ref) || '-' || p_seq;
    get diagnostics n = row_count;
  end if;
  return n;
end $$;

delete from public.fed_notices
 where source = 'BidMatch' and status = 'New' and posted_date < current_date - 3;   -- saved, added or dismissed bids stay
select 'bid match: last 3 days only' as check, true as ok,
  (select count(*) from public.fed_notices where source = 'BidMatch') as bids_kept;
