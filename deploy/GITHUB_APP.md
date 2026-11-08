# Pulse for GitHub: one-time setup (Pulse operator)

Companies can always connect GitHub with a read-only token (Admin → Integrations). This page switches on the
**Connect GitHub** button: one click, the company picks repositories on GitHub, and changes reach Pulse within seconds.

You do this once for the whole Pulse server, not once per company. About 15 minutes.

## 1. Deploy the function

```bash
supabase functions deploy github --no-verify-jwt --project-ref dtnohwaxnnwqplmdtdeq
```

Its address is `https://dtnohwaxnnwqplmdtdeq.supabase.co/functions/v1/github`. "Verify JWT" must stay off: GitHub and the
database timer call it without a Supabase sign-in (it checks GitHub's signature and a shared secret instead).

## 2. Register the GitHub App

On GitHub: **bluecredits organization → Settings → Developer settings → GitHub Apps → New GitHub App**.

| Setting | Value |
|---|---|
| GitHub App name | `Pulse for GitHub` (the address becomes github.com/apps/pulse-for-github) |
| Homepage URL | `https://bluecredits.github.io/bluecredit-pulse/` (or pulse.bluecredits.org once it moves) |
| Callback URL | leave empty; untick "Expire user authorization tokens" and "Request user authorization (OAuth) during installation" |
| Setup URL | the function address above; tick **Redirect on update** |
| Webhook | Active; URL = the function address; Secret = a long random string (save it as `GITHUB_WEBHOOK_SECRET`) |
| Repository permissions | **Issues: Read-only**, **Metadata: Read-only** (added automatically). Nothing else. |
| Subscribe to events | **Issues**, **Milestone**, **Label** |
| Where can it be installed | **Any account** (so other companies on Pulse can install it) |

Create it, then on the app's page:
- Note the **App ID** and the public link name (slug), e.g. `pulse-for-github`.
- **Generate a private key**. A `.pem` file downloads. Keep it safe: it's what lets Pulse read issues.

## 3. Give the function its secrets

Make a relay secret first: `openssl rand -hex 24`.

```bash
supabase secrets set --project-ref dtnohwaxnnwqplmdtdeq \
  GITHUB_APP_ID=123456 \
  GITHUB_WEBHOOK_SECRET='the webhook secret from step 2' \
  PULSE_RELAY_SECRET='the relay secret' \
  PULSE_SITE_URL='https://bluecredits.github.io/bluecredit-pulse/' \
  GITHUB_APP_PRIVATE_KEY="$(cat pulse-for-github.*.private-key.pem)"
```

(Or paste each one in Supabase → Edge Functions → Secrets. The private key can go in as is, line breaks and all.)

## 4. Tell the database

In the Supabase SQL Editor (the relay secret must match step 3):

```sql
select public.gh_app_setup('pulse-for-github',
  'https://dtnohwaxnnwqplmdtdeq.supabase.co/functions/v1/github',
  'the relay secret');
```

Done. Admin → Integrations now shows **Connect GitHub**. Workspaces already on a token can switch whenever they like: their
links, tasks and people matches stay.

## How it fits together

- **Connect:** Pulse makes a one-time code and sends the admin to `github.com/apps/<slug>/installations/new?state=<code>`.
  GitHub sends them back to the function, which checks the install with GitHub, calls `gh_app_connect`, and returns them to
  Integrations.
- **Reading:** the database timer (`pulse-github`, every minute) asks the function to read issues, milestones and the
  repository list for an installation. The function signs an app token and only allows those read-only paths.
- **Changes:** GitHub sends Issues, Milestone and Label events to the function, which calls `gh_app_event`, and the linked
  projects sync straight away. Uninstalling the app on GitHub disconnects the workspace.

## Check

- `deno test --no-check -A supabase/functions/github/` runs the function's tests: signing, install callback, relay rules, webhooks.
- On GitHub, the app's **Advanced** tab lists recent webhook deliveries and their responses.
