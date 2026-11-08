-- Pulse fix 2026-11-08h: Bid sources read table rows cleanly (title from the row's link, NAICS codes and contact picked up).
-- Safe to run more than once. Re-reads every source within 5 minutes so existing listings are corrected.

create or replace function public.src_store(p_src bigint, p_body text, p_ctype text default '') returns int
language plpgsql volatile security definer set search_path = public as $$
declare s fed_sources; items jsonb := '[]'; v_kind text; j jsonb; arr jsonb; it jsonb; r text; m text[]; t text; l text; dd date[]; n int := 0;
  seen text[] := '{}'; key text; js boolean; cells text[]; atxt text; rowtxt text; ph text; em text; nm text; nc text[]; ct jsonb;
begin
  select * into s from fed_sources where id = p_src;
  v_kind := case when s.kind <> 'auto' then s.kind
               when p_ctype ~* 'json' or left(ltrim(p_body), 1) in ('{', '[') then 'api'
               when p_ctype ~* '(rss|atom|xml)' or left(ltrim(p_body), 200) ~* '<(rss|feed|rdf)' then 'feed' else 'page' end;
  if v_kind = 'api' then
    j := p_body::jsonb;
    -- the array of listings: the configured key, or the biggest array of objects in the answer
    arr := case when s.cfg ? 'items' then j #> string_to_array(s.cfg ->> 'items', '.') when jsonb_typeof(j) = 'array' then j end;
    if arr is null then
      select v into arr from jsonb_each(j) e(k, v) where jsonb_typeof(v) = 'array' order by jsonb_array_length(v) desc limit 1;
      if arr is null then select v2 into arr from jsonb_each(j) e(k, v), jsonb_each(case when jsonb_typeof(v) = 'object' then v else '{}' end) e2(k2, v2)
                          where jsonb_typeof(v2) = 'array' order by jsonb_array_length(v2) desc limit 1; end if;
    end if;
    for it in select * from jsonb_array_elements(coalesce(arr, '[]')) limit 300 loop
      if jsonb_typeof(it) <> 'object' then continue; end if;
      t := coalesce(it ->> (s.cfg ->> 'title'), (select v #>> '{}' from jsonb_each(it) e(k, v) where lower(k) = any (array['title', 'subject', 'bid_description', 'name', 'headline', 'notice_title', 'description', 'project_name'])
                 and jsonb_typeof(v) = 'string' order by array_position(array['title', 'subject', 'bid_description', 'name', 'headline', 'notice_title', 'description', 'project_name'], lower(k)) limit 1));
      l := coalesce(it ->> (s.cfg ->> 'link'), (select v #>> '{}' from jsonb_each(it) e(k, v) where k ~* '^(url|link|href|uri|web_url|notice_url)$' limit 1));
      if l is null and s.cfg ? 'link_template' then
        l := s.cfg ->> 'link_template';
        for m in select regexp_matches(l, '\{([a-zA-Z0-9_]+)\}', 'g') loop l := replace(l, '{' || m[1] || '}', coalesce(it ->> m[1], '')); end loop;
      end if;
      items := items || jsonb_build_object('title', src_text(t), 'link', src_abs(l, s.url),
        'deadline', coalesce(it ->> (s.cfg ->> 'deadline'), (select v #>> '{}' from jsonb_each(it) e(k, v) where k ~* '(deadline|submission|closing|close_?date|due)' limit 1)),
        'posted', coalesce(it ->> (s.cfg ->> 'posted'), (select v #>> '{}' from jsonb_each(it) e(k, v) where k ~* '(noticedate|posted|publish|release|created|^date$)' limit 1)),
        'org', coalesce(it ->> (s.cfg ->> 'org'), (select v #>> '{}' from jsonb_each(it) e(k, v) where k ~* '(agency|organi[sz]ation|buyer|owner|client)' and jsonb_typeof(v) = 'string' limit 1)),
        'country', coalesce(it ->> (s.cfg ->> 'country'), (select v #>> '{}' from jsonb_each(it) e(k, v) where k ~* '(country|ctry|location|state)' and jsonb_typeof(v) = 'string' limit 1)),
        'text', left(src_text(concat_ws(' ', it ->> 'notice_type', it ->> 'procurement_method_name', it ->> 'bid_reference_no', it ->> 'summary', it ->> 'snippet')), 600),
        'ref', coalesce(it ->> 'bid_reference_no', it ->> 'reference', it ->> 'ref', it ->> 'id'));
    end loop;
  elsif v_kind = 'feed' then
    for r in select x from regexp_split_to_table(p_body, '(?i)<(item|entry)[\s>]') with ordinality z(x, i) where i > 1 limit 300 loop
      t := src_text(substring(r from '(?is)<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</title>'));
      l := coalesce(src_text(substring(r from '(?is)<link[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</link>')), substring(r from '(?is)<link[^>]*href="([^"]+)"'));
      items := items || jsonb_build_object('title', t, 'link', src_abs(l, s.url),
        'posted', src_text(substring(r from '(?is)<(?:pubDate|published|updated|dc:date)[^>]*>(.*?)</')),
        'text', left(src_text(substring(r from '(?is)<(?:description|summary|content)[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</')), 600));
    end loop;
  else
    -- web page: rows of tables first (title + dates + first link in the row), then links that look like listings
    for r in select x from regexp_split_to_table(p_body, '(?i)<tr[\s>]') with ordinality z(x, i) where i > 1 limit 400 loop
      r := split_part(regexp_replace(r, '</tr\s*>', '</tr>', 'gi'), '</tr>', 1);
      if r ~* '<th[\s>]' then continue; end if;
      -- the row's cells as plain text (the tag of each cell, with its attributes, is dropped whole)
      cells := array(select x from (select src_text(c) x, o from regexp_split_to_table(r, '(?i)<t[dh](\s[^>]*)?>') with ordinality z(c, o)) q where o > 1 and x is not null order by o);
      rowtxt := array_to_string(cells, ' · ');
      if rowtxt is null or length(rowtxt) < 15 then continue; end if;
      l := src_abs(substring(r from '(?is)<a\s[^>]*href\s*=\s*["'']([^"'']+)'), s.url);
      -- the title: the row's link text if it reads like one, otherwise the longest cell
      atxt := src_text(regexp_replace(split_part(regexp_replace(coalesce(substring(r from '(?is)(<a\s.*)'), ''), '</a\s*>', '</a>', 'gi'), '</a>', 1), '^<a[^>]*>', ''));
      t := case when length(atxt) >= 15 then atxt else (select x from unnest(cells) x order by length(x) desc limit 1) end;
      -- contact and NAICS codes when the row has them
      ph := substring(rowtxt from '(\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4})');
      em := substring(rowtxt from '([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})');
      nm := (select x from unnest(cells) with ordinality q(x, o) where length(x) between 4 and 40 and x ~ '^[A-Z][a-z]+( [A-Z][a-z.''-]+){1,3}$'
              and o > 1 and o < cardinality(cells) + 1 order by o desc limit 1);
      nc := array(select distinct g[1] from regexp_matches(rowtxt, '\m([1-9]\d{5})\M\s*[:–-]', 'g') g);
      items := items || jsonb_build_object('title', t, 'link', l, 'text', left(coalesce(nullif(trim(both ' ·' from replace(rowtxt, t, '')), ''), rowtxt), 900), 'row', true, 'naics', to_jsonb(nc),
                                           'contact', case when ph is not null or em is not null then jsonb_build_object('name', nm, 'phone', ph, 'email', em) end);
    end loop;
    for r in select x from regexp_split_to_table(p_body, '(?i)<a\s') with ordinality z(x, i) where i > 1 limit 2000 loop
      l := src_abs(substring(r from '^[^>]*href\s*=\s*["'']([^"'']+)'), s.url);
      r := regexp_replace(r, '</a\s*>', '</a>', 'gi');
      t := src_text(regexp_replace(split_part(r, '</a>', 1), '^[^>]*>', ''));
      if l is null or t is null or length(t) < 20 or length(t) > 400 then continue; end if;
      if not (src_looks_like(t) or l ~* '\.(pdf|docx?|zip)(\?|$)') then continue; end if;
      if l ~* '(facebook|twitter|linkedin|instagram|youtube|whatsapp|tiktok)\.com|//(www\.)?x\.com|/sharer?[./?]' then continue; end if;
      items := items || jsonb_build_object('title', t, 'link', l, 'text', left(src_text(left(split_part(r, '</a>', 2), 500)), 300));
    end loop;
  end if;
  -- store
  for it in select * from jsonb_array_elements(items) loop
    t := left(it ->> 'title', 400); l := it ->> 'link';
    if t is null or length(t) < 8 then continue; end if;
    key := lower(coalesce(l, t));
    if key = any (seen) then continue; end if;
    seen := seen || key;
    if not src_keep(s, concat_ws(' ', t, it ->> 'text')) then continue; end if;
    dd := src_dates(concat_ws(' ', it ->> 'deadline', case when (it ->> 'deadline') is null then it ->> 'text' end), s.date_order);
    nc := array(select jsonb_array_elements_text(coalesce(it -> 'naics', '[]')));
    ct := case when it -> 'contact' is not null and jsonb_typeof(it -> 'contact') = 'object' then jsonb_build_array(jsonb_strip_nulls(it -> 'contact')) else '[]' end;
    insert into fed_notices as f (workspace_id, notice_id, source, src_id, title, agency, notice_type, level, state, posted_date, response_deadline, ui_link, summary, sol_number, status, active, naics, naics_all, contacts)
    values (s.workspace_id, 'W' || s.id || '-' || left(md5(key), 14), 'Web', s.id, t, coalesce(nullif(it ->> 'org', ''), s.org, s.name),
            case when s.level = 'Jobs' then 'Job' else 'Listing' end, s.level, coalesce(nullif(it ->> 'country', ''), s.country),
            coalesce((src_dates(it ->> 'posted', s.date_order))[1], fed_anydate(it ->> 'posted'), (now() at time zone 'America/New_York')::date),
            case when dd[array_length(dd, 1)] >= current_date - 365 then (dd[array_length(dd, 1)] + time '23:59') at time zone 'America/New_York' end,
            coalesce(l, s.url), nullif(it ->> 'text', ''), nullif(left(it ->> 'ref', 120), ''), 'New', true, nc[1], coalesce(nc, '{}'), ct)
    on conflict (workspace_id, notice_id) do update set title = excluded.title, response_deadline = coalesce(excluded.response_deadline, f.response_deadline),
        summary = excluded.summary, naics = coalesce(excluded.naics, f.naics), naics_all = case when cardinality(excluded.naics_all) > 0 then excluded.naics_all else f.naics_all end,
        contacts = case when jsonb_array_length(excluded.contacts) > 0 and jsonb_array_length(f.contacts) = 0 then excluded.contacts else f.contacts end, updated_at = now()
      where (f.title, f.response_deadline, f.summary, f.naics, f.contacts) is distinct from (excluded.title, coalesce(excluded.response_deadline, f.response_deadline), excluded.summary,
             coalesce(excluded.naics, f.naics), case when jsonb_array_length(excluded.contacts) > 0 and jsonb_array_length(f.contacts) = 0 then excluded.contacts else f.contacts end);
    n := n + 1;
  end loop;
  js := n = 0 and v_kind = 'page' and (p_body ~* '(_adf\.|OA_HTML|enable javascript|javascript is required|__NEXT_DATA__|ng-app|id="root"></div>|data-reactroot|cf-browser-verification|captcha)' or length(src_text(p_body)) < 600);
  update fed_sources set detected = v_kind, last_fetch_at = now(), last_found = n, last_error = null,
         last_status = case when n > 0 then format('%s listing%s found', n, case when n = 1 then '' else 's' end)
                            when js then 'This site builds its page with JavaScript or needs a sign-in, so Pulse can''t read it. Set it to "Check by hand", or use the site''s email alerts.'
                            else 'Read the page but found no listings' || case when cardinality(s.keep) > 0 or s.use_profile then ' matching your words' else '' end end
   where id = s.id;
  return n;
exception when others then
  update fed_sources set last_fetch_at = now(), last_error = 'Could not read it: ' || sqlerrm, last_status = null where id = p_src;
  return 0;
end $$;

update public.fed_sources set next_at = null where kind <> 'manual' and active;
