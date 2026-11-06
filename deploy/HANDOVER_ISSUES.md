# Pulse go-live: issues for Chifundo (bluecredit_devops)

Milestone: **Pulse 2.0 — pulse.bluecredits.org**. Repo: bluecredits/bluecredit-pulse. Guide: `deploy/DEPLOY_CONTABO.md`.

## 1. Email sender for sign-ups and password resets (P0)
- [ ] Supabase → Authentication → Emails → SMTP: set a real sender (noreply@bluecredits.org via Google Workspace, Resend or SendGrid)
- [ ] Send a test sign-up to an outside address; confirm the email arrives and the link signs in
- [ ] Customize the Confirm signup / Reset password templates with "Pulse" wording
- Why: Supabase's built-in sender only reaches the Supabase team's own addresses, so other startups can't confirm accounts.

## 2. DNS and Contabo deploy for pulse.bluecredits.org (P0)
- [ ] A record pulse.bluecredits.org → 185.252.235.16 (AAAA 2a02:c207:2341:2234::1 optional)
- [ ] On the VPS: clone to /opt/bluecredit-pulse-src, run `sudo bash deploy/install.sh` twice (secrets in between)
- [ ] Confirm other sites (core, Hydro 8086, Flow 8087, Plume 8088, Cloud 8030) are untouched and healthy
- [ ] HTTPS certificate issued by install.sh (certbot, this domain only)
- [ ] Supabase Auth URL config: Site URL https://pulse.bluecredits.org/, redirect URLs for both pulse.bluecredits.org and the GitHub Pages address

## 3. Database update for Scheduler and Chief of Staff (P0)
- [ ] Supabase SQL Editor: run the latest `supabase/schema.sql` (safe to re-run; adds calendar, meetings, reminders, assistant tables)
- [ ] Don't re-run `bluecredit_workspace.sql` (already applied Nov 6, 2026)
- [ ] Run `supabase/fix_20261106_agreements_hash.sql` once (Nov 6, 2026) (agreements hashing without pgcrypto; fixes "function digest does not exist")
- [ ] After a week of normal use: `drop schema backup_20261106 cascade;` (pre-upgrade copy)

## 3b. Federal opportunities timer (P1)
- [ ] Supabase → Database → Extensions: turn on **pg_net** and **pg_cron** (Vault is on by default)
- [ ] Run the latest `supabase/schema.sql` (creates the `pulse-federal` cron job, every 5 minutes)
- [ ] Barasa pastes the SAM.gov API key in Federal → Settings; check "Database timer" shows all three On and Recent requests fill in
- [ ] Calendar reminder: SAM.gov API keys expire every 90 days

## 4. Google and Microsoft calendar apps (P1)
- [ ] Google Cloud: enable Calendar API, OAuth consent (External), Web client, redirect `https://pulse.bluecredits.org/fn/calendar/callback/google`
- [ ] Submit Google verification for the sensitive scopes (calendar.freebusy, calendar.events); add testers meanwhile
- [ ] Microsoft Entra: app registration (multi-tenant + personal), redirect `https://pulse.bluecredits.org/fn/calendar/callback/microsoft`, delegated Calendars.ReadWrite, User.Read, offline_access
- [ ] Put the IDs and secrets in /etc/bluecredit-pulse/pulse.env, re-run install.sh
- [ ] Test: connect Google, connect Outlook, team calendar shows busy times, book a meeting with Meet/Teams link

## 5. Chief of Staff (Claude) (P1)
- [ ] Anthropic API key in pulse.env (`ANTHROPIC_API_KEY`); keep `CHIEF_DAILY_LIMIT` at 200 per workspace to start
- [ ] Set a monthly spend limit in the Anthropic console
- [ ] Test the brief and Ask as an admin, a member and a contractor (contractor must only see their own items)

## 6. Supabase plan, backups and monitoring (P1)
- [ ] Move project `pulse` to Supabase Pro (daily backups, no pausing) before onboarding outside startups
- [ ] Uptime check on https://pulse.bluecredits.org/ and `/fn/chief` (expects HTTP 401 without sign-in)
- [ ] Turn on CAPTCHA for sign-ups (Supabase Auth → Attack protection, Cloudflare Turnstile) and add the widget to the sign-up forms

## 7. Terms of Service and Privacy Policy (P1, needs Barasa)
- [ ] Barasa drafts / approves Terms and Privacy (Pulse holds other companies' data; mention Claude processing for Chief of Staff and calendar access)
- [ ] Add pages and links on the sign-up card and footer

## 8. Agreements (e-sign) checks (P1)
- [ ] Barasa / counsel review the four templates' wording (`web/agreements/templates.js`) and BlueCredit's company details (Agreements → Templates)
- [ ] Send a test agreement to an outside email; sign on a phone; confirm the executed copy prints with the certificate
- [ ] Once email sending works (issue 1), consider emailing signing links and executed copies automatically (today: copy link / open in email)
- [ ] Optional: DocuSign or Adobe Acrobat Sign integration (needs an API account; "Upload signed copy" covers it meanwhile)
- [ ] If uploads grow, move `agreement_files` to Supabase Storage (private bucket, path per workspace)

## 9. Later (P2)
- [ ] Mail integration for Chief of Staff (Gmail / Outlook read + draft, same OAuth apps, new scopes)
- [ ] Billing (Stripe) per workspace once plans are decided; `workspaces.plan` is already there
- [ ] Dedicated-database option for customers who require their own instance
- [ ] Move repo to private if the code shouldn't stay public (GitHub Pages then needs a paid plan, or serve only from Contabo)
