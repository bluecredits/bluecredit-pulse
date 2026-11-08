-- 2026-11-08o: "Active" funding applications and opportunities leave out ones whose deadline has passed without being submitted.
-- Submitted ones stay active (they're waiting on an outcome). Safe to run more than once.

create or replace function public.dashboard_data(p_owner text) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  t date := current_date;
  ao text[] := array['Identified', 'Qualifying', 'Pursuing', 'Submitted'];
  af text[] := array['Identified', 'Pursuing', 'Submitted'];
begin
  if not is_member() then raise exception 'Not a member'; end if;
  return jsonb_build_object(
    'kpis', jsonb_build_object(
      -- active = still in play: submitted (waiting on an outcome), or the deadline hasn't passed (or there isn't one)
      'active_opps', (select count(*) from opportunities where stage = any (ao) and (stage = 'Submitted' or deadline is null or deadline >= t)),
      'active_funding', (select count(*) from funding where status = any (af) and (status = 'Submitted' or deadline is null or deadline >= t)),
      'missed_funding', (select count(*) from funding where status in ('Identified', 'Pursuing') and deadline < t),
      'missed_opps', (select count(*) from opportunities where stage in ('Identified', 'Qualifying', 'Pursuing') and deadline < t),
      'submitted', (select count(*) from opportunities where stage = 'Submitted') + (select count(*) from funding where status = 'Submitted'),
      'won', (select count(*) from opportunities where stage = 'Won') + (select count(*) from funding where status = 'Won'),
      'open_actions', (select count(*) from actions where status = 'Open'),
      'overdue_actions', (select count(*) from actions where status = 'Open' and due_date < t),
      'followups_due', (select count(*) from contacts where next_step_date <= t
                         and coalesce(status, '') not in ('Do Not Contact', 'Dormant'))),
    'due_soon', coalesce((select jsonb_agg(x order by x.deadline) from (
        select 'opportunities' entity, id, title as name, agency org, deadline, stage status, owner, priority
          from opportunities where stage = any (ao) and deadline between t and t + 14
        union all
        select 'funding', id, name, organization, deadline, status, owner, null
          from funding where status = any (af) and deadline between t and t + 14) x), '[]'),
    'my_actions', coalesce((select jsonb_agg(a order by a.due_date nulls last) from (
        select * from actions where status = 'Open' and lower(coalesce(owner, '')) = lower(p_owner) limit 20) a), '[]'),
    'opp_by_stage', coalesce((select jsonb_agg(jsonb_build_object('k', stage, 'n', n)) from (
        select stage, count(*) n from opportunities group by stage) s), '[]'),
    'funding_by_status', coalesce((select jsonb_agg(jsonb_build_object('k', status, 'n', n)) from (
        select status, count(*) n from funding where coalesce(status, '') <> 'Catalog' group by status) s), '[]'),
    'recent', coalesce((select jsonb_agg(a order by a.ts desc) from (
        select * from activity order by ts desc limit 15) a), '[]'),
    'last_reviews', coalesce((select jsonb_object_agg(cadence, last) from (
        select cadence, max(review_date) last from reviews group by cadence) r), '{}'));
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
                 count(*) filter (where src = 'o' and st = any (ao) and (st = 'Submitted' or dl is null or dl >= t)) active_opps,
                 count(*) filter (where src = 'f' and st = any (af) and (st = 'Submitted' or dl is null or dl >= t)) active_funding,
                 count(*) filter (where st = 'Submitted') submitted,
                 count(*) filter (where st = 'Won') won
            from (select owner, stage st, 'o' src, deadline dl from opportunities
                  union all select owner, status, 'f', deadline from funding where coalesce(status, '') <> 'Catalog') u
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
