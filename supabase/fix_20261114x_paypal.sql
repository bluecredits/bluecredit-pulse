-- ================================================================ fix x · PayPal billing (replaces Stripe)
-- The billing function (supabase/functions/billing) takes payment with PayPal Subscriptions:
--   workspaces.paypal_subscription_id = the company's active PayPal subscription (I-…); paid_until follows its next billing date
--   paypal_plans = the PayPal product and per-user plans the function creates on first use (one per plan and cycle, per sandbox/live)
-- Only the function (service role) touches these; nothing is granted to signed-in users.
alter table public.workspaces add column if not exists paypal_subscription_id text;
comment on column public.workspaces.paid_until is 'End of the paid period: set from PayPal (next billing date + 3 days grace) or by an operator for invoiced companies';

create table if not exists public.paypal_plans (
  env text not null check (env in ('sandbox', 'live')),
  key text not null,              -- 'product', or '<plan>-<cycle>' e.g. 'pro-month'
  plan_id text not null,          -- P-… (for key 'product': the product id)
  product_id text,
  created_at timestamptz not null default now(),
  primary key (env, key));
alter table public.paypal_plans enable row level security;
revoke all on public.paypal_plans from public, anon, authenticated;

create or replace function public.billing_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'plan', w.plan, 'effective', ws_plan_for(w.id), 'comped', w.comped, 'paid_until', w.paid_until,
    'trial_ends_at', w.trial_ends_at, 'trial_days_left', greatest(0, ceil(extract(epoch from (w.trial_ends_at - now())) / 86400))::int,
    'cycle', w.billing_cycle, 'billing_email', w.billing_email, 'note', w.plan_note,
    'provider', 'paypal', 'has_paypal', w.paypal_subscription_id is not null,
    'seats', (select count(*) from profiles p where p.workspace_id = w.id and p.active and p.role in ('admin', 'member', 'employee')),
    'contractors', (select count(*) from profiles p where p.workspace_id = w.id and p.active and p.role = 'contractor'),
    'operator', is_operator())
    from workspaces w where w.id = ws() $$;

create or replace function public.billing_workspaces() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when is_operator() then coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'plan', w.plan, 'effective', ws_plan_for(w.id),
    'comped', w.comped, 'paid_until', w.paid_until, 'trial_ends_at', w.trial_ends_at, 'note', w.plan_note, 'created_at', w.created_at,
    'paypal', w.paypal_subscription_id is not null,
    'seats', (select count(*) from profiles p where p.workspace_id = w.id and p.active and p.role in ('admin', 'member', 'employee'))) order by w.created_at), '[]') end
    from workspaces w $$;
revoke execute on function public.billing_status(), public.billing_workspaces() from public, anon;
grant execute on function public.billing_status(), public.billing_workspaces() to authenticated;
