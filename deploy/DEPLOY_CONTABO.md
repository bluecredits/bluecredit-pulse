# Deploying Pulse to the Contabo VPS (pulse.bluecredits.org)

Pulse runs in two places:

| Part | Where | Notes |
|---|---|---|
| Website (`web/`) | Contabo: nginx, `/var/www/bluecredit-pulse` | also on GitHub Pages: https://bluecredits.github.io/bluecredit-pulse/ |
| Calendar connector (`supabase/functions/calendar`) | Contabo: `pulse-calendar.service`, 127.0.0.1:8091 | Deno; nginx `/fn/calendar` |
| Chief of Staff (`supabase/functions/chief`) | Contabo: `pulse-chief.service`, 127.0.0.1:8092 | Deno; nginx `/fn/chief`; calls Claude |
| Database and sign-ins | Supabase project `pulse` (dtnohwaxnnwqplmdtdeq) | `supabase/schema.sql` |

**This server also runs bluecredits-core, Hydro (8086), Flow (8087), Plume (8088) and Cloud (8030). Pulse must not touch
them.** `install.sh` only creates Pulse's own folder, nginx site, user and services; it reloads nginx only after
`nginx -t` passes, and never restarts anything else.

## One-time setup

1. **DNS:** add an A record `pulse.bluecredits.org → 185.252.235.16` (and AAAA `2a02:c207:2341:2234::1` if you use IPv6).
2. **Database:** in Supabase → SQL Editor, run the latest `supabase/schema.sql` (safe to re-run). It adds the
   Scheduler and Chief of Staff tables. For BlueCredit's own lists, `supabase/bluecredit_workspace.sql` was already run
   on Nov 6, 2026; don't re-run it unless you want to reset BlueCredit's lists.
3. **Supabase Auth → URL Configuration:** Site URL `https://pulse.bluecredits.org/`; Redirect URLs add
   `https://pulse.bluecredits.org/**` and keep `https://bluecredits.github.io/bluecredit-pulse/**`.
4. **Supabase Auth → Emails → SMTP Settings:** set a real sender (e.g. noreply@bluecredits.org via Google Workspace,
   Resend or SendGrid). Without it, sign-up confirmations and password resets only reach the Supabase team's own
   addresses, so other startups can't get in while "Confirm email" is on.
5. **Google OAuth client** (Google Cloud console → APIs & Services):
   - Enable *Google Calendar API*. OAuth consent screen: External; scopes `calendar.freebusy`, `calendar.events`, `openid`, `email`.
   - Credentials → OAuth client ID → Web. Authorized redirect URI: `https://pulse.bluecredits.org/fn/calendar/callback/google`.
   - Until Google verifies the app (sensitive scopes; takes a few weeks), add testers' emails on the consent screen.
6. **Microsoft app** (Entra admin center → App registrations → New):
   - Supported accounts: *any organizational directory and personal Microsoft accounts*.
   - Redirect URI (Web): `https://pulse.bluecredits.org/fn/calendar/callback/microsoft`. Create a client secret.
   - API permissions (Microsoft Graph, delegated): `offline_access`, `openid`, `email`, `User.Read`, `Calendars.ReadWrite`.
7. **Claude API key:** console.anthropic.com → API keys. Usage is capped per workspace per day (`CHIEF_DAILY_LIMIT`).

## Install

```bash
sudo -i
cd /opt && git clone https://github.com/bluecredits/bluecredit-pulse.git bluecredit-pulse-src   # or git pull if it's there
cd bluecredit-pulse-src
bash deploy/install.sh            # first run creates /etc/bluecredit-pulse/pulse.env and stops short of secrets
nano /etc/bluecredit-pulse/pulse.env   # fill SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, GOOGLE_*, MS_*
bash deploy/install.sh            # installs the site, services, timer, nginx site and the HTTPS certificate
```

The script ends with a health check: both functions should answer **HTTP 401** (running, asking for sign-in).

## Update after a push

```bash
cd /opt/bluecredit-pulse-src && git pull && sudo bash deploy/install.sh
```

## Check and troubleshoot

```bash
systemctl status pulse-calendar pulse-chief
journalctl -u pulse-calendar -u pulse-chief -n 100 --no-pager
systemctl list-timers pulse-calendar-sync.timer
curl -s -X POST https://pulse.bluecredits.org/fn/chief -d '{}'      # {"error":"Sign in first."} = healthy
```

- Calendar connect bounces back with an error: check the redirect URIs match exactly, and `SITE_URL` lists the
  address people use Pulse from.
- "Reconnect needed" on someone's calendar: their grant was revoked or expired; they click Reconnect.
- Changing `CALENDAR_SECRET` disconnects every calendar (tokens are encrypted with it).

## Undo

```bash
systemctl disable --now pulse-calendar pulse-chief pulse-calendar-sync.timer
rm /etc/systemd/system/pulse-calendar*.service /etc/systemd/system/pulse-chief.service /etc/systemd/system/pulse-calendar-sync.timer
rm /etc/nginx/sites-enabled/pulse.bluecredits.org && nginx -t && systemctl reload nginx
rm -rf /var/www/bluecredit-pulse /opt/bluecredit-pulse      # keep /etc/bluecredit-pulse if you may reinstall
```

## Alternative: Supabase Edge Functions

The same two functions also run as Supabase Edge Functions (`supabase functions deploy calendar --no-verify-jwt` and
`supabase functions deploy chief`, secrets via `supabase secrets set`). Then leave `functionsUrl` unset in
`web/config.js`, set `CALENDAR_FUNCTION_URL` to `https://dtnohwaxnnwqplmdtdeq.supabase.co/functions/v1/calendar`, and
use that address in the Google/Microsoft redirect URIs.

## Tests

```bash
deno test --no-check -A supabase/functions/     # 9 tests: OAuth, token refresh, free/busy, booking, assistant, limits
```
