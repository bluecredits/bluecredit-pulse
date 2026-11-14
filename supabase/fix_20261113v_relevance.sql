-- Pulse fix v (2026-11-13): a relevance filter for Opportunities.
--   * Every new listing (SAM.gov, Grants.gov, BidMatch, bid sources) gets a relevance score from the company's
--     relevance terms: core terms count most, related terms less, "helps" terms (consultancy, study, design…) a little,
--     and "lower the score" terms (supplies, janitorial, vehicles…) count against it. Words in the title count fully,
--     words only in the description count half. Notices in one of your NAICS codes get a bonus.
--   * New listings are hidden when they're closed, when they're a site's navigation link rather than a listing
--     ("View all jobs", "• World Bank Tenders"), when they're a plain job ad, when their title has an "always hide"
--     word, or when they score below the strictness level. Nothing is deleted: "Filtered out" shows them with the reason.
--   * Saved, added and dismissed items are never hidden.
-- Safe to run more than once.

create table if not exists public.fed_filters (
  workspace_id uuid primary key default public.ws_default() references public.workspaces (id) on delete cascade,
  enabled boolean not null default true,
  terms jsonb not null default '[]',              -- [{ "t": "stormwater", "w": 3 }, …]; w is 3, 2, 1 or -3
  exclude text[] not null default '{}',           -- titles with these are always hidden
  min_score int not null default 3,
  hide_expired boolean not null default true,
  hide_jobs boolean not null default true,
  hide_junk boolean not null default true,
  updated_at timestamptz default now(), updated_by text
);
alter table public.fed_filters enable row level security;
drop policy if exists ff_read on public.fed_filters;
create policy ff_read on public.fed_filters for select to authenticated using (workspace_id = staff_ws());
drop policy if exists ff_write on public.fed_filters;
create policy ff_write on public.fed_filters for all to authenticated using (workspace_id = staff_ws()) with check (workspace_id = staff_ws());
revoke all on public.fed_filters from anon;
grant select, insert, update, delete on public.fed_filters to authenticated;
drop trigger if exists stamp on public.fed_filters;
create trigger stamp before insert or update on public.fed_filters for each row execute function public.stamp_row();
drop trigger if exists ws_write_guard on public.fed_filters;
create trigger ws_write_guard before insert or update or delete on public.fed_filters for each row execute function public.ws_write_guard();

-- starting terms: your profile keywords as core terms, plus words that mark consulting work and words that mark supplies
create or replace function public.fed_filter_default(p_ws uuid) returns jsonb
language sql stable security definer set search_path = public, pg_catalog as $$
  select coalesce(jsonb_agg(distinct jsonb_build_object('t', t, 'w', w)), '[]') from (
    select lower(trim(k)) t, 3 w from fed_searches s, unnest(s.keywords) k where s.workspace_id = p_ws and s.active and trim(k) <> ''
    union select t, 1 from unnest(array['consulting', 'consultancy', 'consultant', 'study', 'assessment', 'feasibility', 'design', 'survey',
      'supervision', 'technical assistance', 'advisory', 'evaluation', 'analysis', 'planning', 'modeling', 'modelling', 'research', 'professional services']) t
    union select t, 2 from unnest(array['architect-engineer', 'architectural & engineering', 'architectural and engineering', 'a-e', 'a/e', 'a&e', 'engineering services']) t
    union select t, -3 from unnest(array['supplies', 'supply of', 'procurement of goods', 'furniture', 'stationery', 'office supplies', 'vehicle', 'vehicles',
      'janitorial', 'custodial', 'cleaning services', 'mowing', 'grounds maintenance', 'catering', 'food', 'uniforms', 'insurance', 'printing',
      'laptop', 'laptops', 'computers', 'fuel', 'security guard', 'guard services', 'rental', 'rentals', 'spare parts', 'tires', 'ammunition',
      'water heater', 'water heaters', 'bottled water', 'fourniture', 'acquisition de', 'aquisição']) t) x $$;

create or replace function public.fed_filter_get() returns jsonb
language plpgsql stable security definer set search_path = public, pg_catalog as $$
declare f fed_filters;
begin
  if staff_ws() is null then return null; end if;
  select * into f from fed_filters where workspace_id = staff_ws();
  if not found then
    return jsonb_build_object('enabled', true, 'terms', fed_filter_default(staff_ws()), 'exclude', '{}'::text[], 'min_score', 3,
                              'hide_expired', true, 'hide_jobs', true, 'hide_junk', true, 'is_default', true);
  end if;
  return to_jsonb(f) - 'workspace_id';
end $$;

create or replace function public.fed_filter_save(p jsonb) returns void
language plpgsql volatile security definer set search_path = public, pg_catalog as $$
begin
  if staff_ws() is null then raise exception 'Only team members can change the filter.'; end if;
  insert into fed_filters (workspace_id, enabled, terms, exclude, min_score, hide_expired, hide_jobs, hide_junk)
  values (staff_ws(), coalesce((p ->> 'enabled')::boolean, true),
          coalesce((select jsonb_agg(distinct jsonb_build_object('t', lower(trim(e ->> 't')), 'w', least(3, greatest(-3, (e ->> 'w')::int))))
                      from jsonb_array_elements(coalesce(p -> 'terms', '[]')) e where trim(coalesce(e ->> 't', '')) <> ''), '[]'),
          coalesce((select array_agg(distinct lower(trim(x))) from jsonb_array_elements_text(coalesce(p -> 'exclude', '[]')) x where trim(x) <> ''), '{}'),
          least(10, greatest(0, coalesce((p ->> 'min_score')::int, 3))),
          coalesce((p ->> 'hide_expired')::boolean, true), coalesce((p ->> 'hide_jobs')::boolean, true), coalesce((p ->> 'hide_junk')::boolean, true))
  on conflict (workspace_id) do update set enabled = excluded.enabled, terms = excluded.terms, exclude = excluded.exclude, min_score = excluded.min_score,
    hide_expired = excluded.hide_expired, hide_jobs = excluded.hide_jobs, hide_junk = excluded.hide_junk;
end $$;

-- add one word to "always hide" (the "Less like this" button)
create or replace function public.fed_filter_exclude(p_word text) returns void
language plpgsql volatile security definer set search_path = public, pg_catalog as $$
declare cur jsonb := fed_filter_get();
begin
  if nullif(trim(p_word), '') is null then return; end if;
  perform fed_filter_save(cur || jsonb_build_object('exclude', (select to_jsonb(array_agg(distinct x)) from (
    select jsonb_array_elements_text(coalesce(cur -> 'exclude', '[]')) x union select lower(trim(p_word))) z)));
end $$;

-- a term as a regular expression: terms of 5+ letters (or ending in *) match the start of a word ("hydrolog" finds "hydrology");
-- shorter ones match the whole word, plural allowed ("dam" finds "dams" but not "damage" or "Amsterdam")
create or replace function public.fed_rx(p text) returns text language sql immutable set search_path = pg_catalog as $$
  with t as (select lower(trim(p)) v), e as (select regexp_replace(rtrim(v, '*'), '([.*+?^${}()|\[\]\\])', '\\\1', 'g') x, v from t)
  select case when v like '%*' or length(v) >= 5 then '(^|[^[:alnum:]])' || x else '(^|[^[:alnum:]])' || x || '(s|es)?($|[^[:alnum:]])' end from e $$;

-- score one notice: { score, why[], minus[], hide }
create or replace function public.fed_rel(n public.fed_notices, f jsonb, my_naics text[]) returns jsonb
language plpgsql stable set search_path = public, pg_catalog as $$
declare ti text := lower(coalesce(n.title, '')); body text := lower(concat_ws(' ', n.summary, n.bm_keywords));
  e jsonb; t text; w int; score int := 0; why text[] := '{}'; minus text[] := '{}'; hide text; x text; words int;
begin
  for e in select * from jsonb_array_elements(coalesce(f -> 'terms', '[]')) loop
    t := e ->> 't'; w := (e ->> 'w')::int;
    if t is null or trim(t) = '' then continue; end if;
    if ti ~ fed_rx(t) then score := score + w; if w > 0 then why := array_append(why, t); else minus := array_append(minus, t); end if;
    elsif w > 0 and body ~ fed_rx(t) then score := score + (w + 1) / 2; why := array_append(why, t);
    end if;
  end loop;
  if my_naics is not null and cardinality(my_naics) > 0 and exists (select 1 from unnest(my_naics) q, unnest(n.naics_all || n.naics) c where c like q || '%') then
    score := score + 2; why := array_append(why, 'your NAICS');
  end if;
  -- reasons to hide a new listing, most definite first
  if coalesce((f ->> 'hide_junk')::boolean, true) and n.source = 'Web' then
    words := coalesce(array_length(regexp_split_to_array(trim(regexp_replace(ti, '[^[:alnum:] ]', ' ', 'g')), '\s+'), 1), 0);
    if ti ~ '^\s*[•·▪►»›\-–—]' or ti ~ '(view all|see all|learn about|read more|click here|more tenders|all tenders|subscribe|log ?in|sign up|contact us|home page)'
       or ti ~ '(^|\s)(tenders|notices|jobs|vacancies|opportunities)\s*$' or words < 3 then hide := 'Not a listing'; end if;
  end if;
  if hide is null then
    select k into x from unnest(coalesce((select array_agg(v) from jsonb_array_elements_text(coalesce(f -> 'exclude', '[]')) v), '{}')) k where ti ~ fed_rx(k) limit 1;
    if x is not null then hide := 'Has “' || x || '”'; end if;
  end if;
  if hide is null and coalesce((f ->> 'hide_expired')::boolean, true) and n.response_deadline is not null and n.response_deadline < now() then hide := 'Closed'; end if;
  if hide is null and coalesce((f ->> 'hide_jobs')::boolean, true) and n.notice_type = 'Job'
     and ti !~ '(rfp|rfq|rfi|tender|bid|consultan|eoi|expression of interest|request for|proposals?)' then hide := 'Job ad'; end if;
  if hide is null and score < coalesce((f ->> 'min_score')::int, 3) then hide := 'Low relevance'; end if;
  return jsonb_build_object('score', score, 'why', to_jsonb(why), 'minus', to_jsonb(minus), 'hide', hide);
end $$;

-- the list, now with relevance; p_show: 'relevant' (default), 'filtered' (only what the filter hides) or 'all'
drop function if exists public.fed_list(text, text, bigint, text, int);
create or replace function public.fed_list(p_source text default 'SAM.gov', p_status text default 'New', p_search bigint default null, p_sort text default 'posted',
                                           p_limit int default 400, p_show text default 'relevant') returns jsonb
language plpgsql stable security definer set search_path = public, pg_catalog as $$
declare f jsonb := fed_filter_get(); on_ boolean; mn text[];
begin
  if staff_ws() is null or not ws_has_app('opportunities') then return '[]'; end if;
  on_ := coalesce((f ->> 'enabled')::boolean, true);
  select array_agg(distinct q) into mn from fed_searches s, unnest(s.naics) q where s.workspace_id = staff_ws() and s.active and s.source = 'SAM.gov';
  return (select coalesce(jsonb_agg(to_jsonb(x) - 'hide_' - 'dup' order by case when p_sort = 'due' then x.response_deadline end nulls last,
                                                             case when p_sort = 'relevance' then -(x.rel ->> 'score')::int end, x.posted_date desc nulls last, x.first_seen desc), '[]')
  from (select y.*, y.rel ->> 'hide' hide_ from (
          select n.notice_id, n.title, n.sol_number, n.agency, n.subtier, n.office, n.notice_type, n.posted_date, n.response_deadline, n.naics, n.set_aside,
                 n.set_aside_code, n.state, n.city, n.ui_link, n.award_amount, n.awardee, n.status, n.opportunity_id, n.funding_id, n.first_seen, n.source, n.aln, n.level,
                 left(n.summary, 6000) summary, n.naics_all, n.psc, n.bm_keywords, n.src_id,
                 (select coalesce(jsonb_agg(c || coalesce((select jsonb_build_object('cid', ct.id) from contacts ct where ct.workspace_id = n.workspace_id
                      and c ? 'email' and lower(ct.email) = lower(c ->> 'email') limit 1), '{}')), '[]') from jsonb_array_elements(n.contacts) c) contacts,
                 (select array_agg(m.search_id) from fed_matches m where m.workspace_id = n.workspace_id and m.notice_id = n.notice_id) searches,
                 fed_rel(n, f, mn) rel,
                 row_number() over (partition by n.source, n.status, lower(regexp_replace(coalesce(n.title, ''), '\s+', ' ', 'g')), n.response_deadline::date order by n.first_seen desc) dup
            from fed_notices n
           where n.workspace_id = staff_ws() and n.source = coalesce(p_source, 'SAM.gov') and (p_status = 'All' or n.status = p_status)
             and ((n.source in ('BidMatch', 'Web', 'Link') and p_search is null) or (n.status <> 'New' and p_search is null)
                  or exists (select 1 from fed_matches m where m.workspace_id = n.workspace_id and m.notice_id = n.notice_id and (p_search is null or m.search_id = p_search)))) y
         where (y.status <> 'New' or y.dup = 1)
           and (not on_ or y.status <> 'New' or y.source = 'Link' or coalesce(p_show, 'relevant') = 'all'
            or (coalesce(p_show, 'relevant') = 'relevant' and y.rel ->> 'hide' is null)
            or (p_show = 'filtered' and y.rel ->> 'hide' is not null))
         order by case when p_sort = 'due' then y.response_deadline end nulls last, y.posted_date desc nulls last, y.first_seen desc
         limit least(greatest(coalesce(p_limit, 400), 1), 1000)) x);
end $$;

-- counts: new items that pass the filter, per source, plus how many the filter hides
create or replace function public.fed_counts() returns jsonb
language plpgsql stable security definer set search_path = public, pg_catalog as $$
declare f jsonb := fed_filter_get(); on_ boolean; mn text[]; r jsonb;
begin
  if staff_ws() is null or not ws_has_app('opportunities') then return jsonb_build_object('new', 0, 'by_source', '{}'::jsonb, 'by_search', '{}'::jsonb, 'hidden', '{}'::jsonb); end if;
  on_ := coalesce((f ->> 'enabled')::boolean, true);
  select array_agg(distinct q) into mn from fed_searches s, unnest(s.naics) q where s.workspace_id = staff_ws() and s.active and s.source = 'SAM.gov';
  with n as (
    select n.source, n.source || '|' || lower(regexp_replace(coalesce(n.title, ''), '\s+', ' ', 'g')) || '|' || coalesce(n.response_deadline::date::text, '') k,
           n.notice_id, case when on_ then fed_rel(n, f, mn) ->> 'hide' end hide_
      from fed_notices n
     where n.workspace_id = staff_ws() and n.status = 'New'
       and (n.source in ('BidMatch', 'Web') or exists (select 1 from fed_matches m where m.workspace_id = n.workspace_id and m.notice_id = n.notice_id)))
  select jsonb_build_object(
    'new', (select count(distinct k) from n where hide_ is null and source in ('SAM.gov', 'Grants.gov')),
    'by_source', coalesce((select jsonb_object_agg(source, c) from (select source, count(distinct k) c from n where hide_ is null group by source) z), '{}'),
    'hidden', coalesce((select jsonb_object_agg(source, c) from (select source, count(distinct k) c from n where hide_ is not null group by source) z), '{}'),
    'by_search', coalesce((select jsonb_object_agg(search_id, c) from (select m.search_id, count(*) c from fed_matches m join n on n.notice_id = m.notice_id
                                     where m.workspace_id = staff_ws() and n.hide_ is null group by m.search_id) z), '{}'))
  into r from (select 1) one;
  return r;
end $$;

revoke execute on function public.fed_list(text, text, bigint, text, int, text), public.fed_counts(), public.fed_filter_get(), public.fed_filter_save(jsonb),
  public.fed_filter_exclude(text), public.fed_filter_default(uuid), public.fed_rel(public.fed_notices, jsonb, text[]) from public, anon;
grant execute on function public.fed_list(text, text, bigint, text, int, text), public.fed_counts(), public.fed_filter_get(), public.fed_filter_save(jsonb),
  public.fed_filter_exclude(text), public.fed_rel(public.fed_notices, jsonb, text[]) to authenticated;
