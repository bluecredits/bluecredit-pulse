-- Pulse fix (Nov 6, 2026): MyBidMatch reads only the last 3 days; keeps the matched keywords, NAICS and the full description.
-- Safe to run more than once.
alter table public.fed_notices add column if not exists bm_keywords text;
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
    update fed_notices set summary = left(body, 6000), sol_number = coalesce(sol, sol_number), response_deadline = coalesce(ts, response_deadline),
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

create or replace function public.fed_list(p_source text default 'SAM.gov', p_status text default 'New', p_search bigint default null, p_sort text default 'posted', p_limit int default 400) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by case when p_sort = 'due' then x.response_deadline end nulls last, x.posted_date desc nulls last, x.first_seen desc), '[]')
  from (select n.notice_id, n.title, n.sol_number, n.agency, n.subtier, n.office, n.notice_type, n.posted_date, n.response_deadline, n.naics, n.set_aside,
               n.set_aside_code, n.state, n.city, n.ui_link, n.award_amount, n.awardee, n.status, n.opportunity_id, n.funding_id, n.first_seen, n.source, n.aln, n.level, left(n.summary, 6000) summary, n.naics_all, n.psc, n.bm_keywords,
               (select array_agg(m.search_id) from fed_matches m where m.workspace_id = n.workspace_id and m.notice_id = n.notice_id) searches
          from fed_notices n
         where n.workspace_id = staff_ws() and n.source = coalesce(p_source, 'SAM.gov') and (p_status = 'All' or n.status = p_status)
           and ((n.source = 'BidMatch' and p_search is null)
                or exists (select 1 from fed_matches m where m.workspace_id = n.workspace_id and m.notice_id = n.notice_id and (p_search is null or m.search_id = p_search)))
         order by case when p_sort = 'due' then n.response_deadline end nulls last, n.posted_date desc nulls last, n.first_seen desc
         limit least(greatest(coalesce(p_limit, 400), 1), 1000)) x $$;

delete from public.fed_notices
 where source = 'BidMatch' and status = 'New' and posted_date < current_date - 3;   -- saved, added or dismissed bids stay
-- read the last 3 days again so their keywords and full text are filled in
delete from public.fed_matches where notice_id like 'B%' and notice_id in (select notice_id from public.fed_notices where source = 'BidMatch' and status = 'New');
delete from public.fed_notices where source = 'BidMatch' and status = 'New';
delete from public.fed_bm_docs;
update public.fed_config set next_fetch_at = null where bidmatch_secret_id is not null;
select 'bid match: last 3 days, keywords and full text' as check, true as ok;
