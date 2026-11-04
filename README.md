# Clipper Network analytics

A live page that tracks followers, views and top clips for every clipper account across
**YouTube, TikTok, Instagram, Facebook and X**. Team members sign in, connect accounts with a
"Connect" button, and the numbers update once a day.

- **Live page:** <https://44seven-media.github.io/clipper-analytics/> (sign-in required)
- **Sample view** with invented numbers: <https://44seven-media.github.io/clipper-analytics/?sample#dashboard>

## How it fits together

| Piece | Where | What it does |
|---|---|---|
| Live page | `web/`, published by GitHub Pages | Sign-in, dashboard, Accounts tab with Connect buttons |
| Supabase | `supabase/` | Sign-in, the stored numbers, and the Connect step that keeps each platform login |
| Daily job | `src/`, run by GitHub Actions | Every morning at about 6 AM Central, reads each account through the platform's official API and saves the numbers in Supabase |

This repo is public, but it only holds code. The numbers and the platform logins live in
Supabase, and only signed-in people on the team list can read the numbers. Nobody can read
the platform logins from the page.

## One-time setup

### 1. Create the Supabase project (free)

1. At <https://supabase.com/dashboard> create a project named **clipper-analytics**. Save the
   **database password** it asks you to choose.
2. **Authentication → Sign In / Providers → Email:** turn **off** "Allow new users to sign up".
   Only people you add can sign in.
3. **Authentication → URL Configuration:** set **Site URL** to
   `https://44seven-media.github.io/clipper-analytics/`. Invite and password-reset emails link there.

### 2. Add the Supabase details to GitHub

In this repo: **Settings → Secrets and variables → Actions**.

**Variables** tab:

| Name | Where to find it |
|---|---|
| `SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `SUPABASE_ANON_KEY` | Same page, the `anon` / publishable key (safe to publish) |
| `SUPABASE_PROJECT_REF` | The id in the project URL, e.g. `abcd1234efgh` |

**Secrets** tab:

| Name | Where to find it |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → `service_role` key. Keep it secret. |
| `SUPABASE_DB_PASSWORD` | The database password from step 1 |
| `SUPABASE_ACCESS_TOKEN` | <https://supabase.com/dashboard/account/tokens> → Generate new token |

Then run **Actions → Supabase → Run workflow** (creates the tables and Connect functions), and
**Actions → Live page → Run workflow** (turns on sign-in on the page).

### 3. Add yourself and your team

1. Supabase → **Authentication → Users → Add user → Create new user**. Enter the email and a
   password, and tick auto-confirm. For teammates, use **Send invitation** instead; they choose
   their own password from the email.
2. Supabase → **SQL Editor**, put each person on the team list:

   ```sql
   insert into team_members (email) values ('person@example.com');
   ```

Someone who can sign in but isn't on the list sees a page telling them to ask for access.

### 4. Turn on each platform's Connect button

Each platform needs a developer app. In every app, the **redirect / callback URL** is:

```
https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/connect-callback
```

Add the app's keys as GitHub **secrets**, then run **Actions → Supabase** again to hand them
to the Connect functions. A button whose platform isn't set up yet says so when clicked.

**Facebook & Instagram** (free). One sign-in adds every Page you pick and the Instagram
account linked to each.
1. <https://developers.facebook.com/apps> → Create app → type **Business**, connected to your
   business portfolio. Add **Facebook Login for Business**, and put the callback URL under
   Valid OAuth Redirect URIs.
2. Secrets: `META_APP_ID`, `META_APP_SECRET` (App settings → Basic).
3. While the app is in development mode, only people with a role on the app (Admin, Developer,
   Tester) can connect. Since you only read your own accounts, that's usually enough.
4. Each Instagram account must be a **Business or Creator** account linked to a Facebook Page.

**TikTok** (free, needs TikTok's app review).
1. <https://developers.tiktok.com> → create an app, add **Login Kit** with the scopes
   `user.info.basic`, `user.info.profile`, `user.info.stats` and `video.list`, and add the callback URL.
2. Secrets: `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`.
3. Submit for review. Until it's approved, the app's **Sandbox** works for accounts added there
   as target users.
4. Connect one TikTok account at a time. Log out of TikTok in your browser between accounts so
   the next sign-in asks for a different one.

**YouTube** (free).
1. <https://console.cloud.google.com> → create a project, enable **YouTube Data API v3**.
2. **APIs & Services → Credentials → Create credentials → API key**, restricted to the YouTube
   Data API. Secret: `YOUTUBE_API_KEY`. The daily job reads public channel numbers with it.
3. For the Connect button: **OAuth consent screen** (add yourself as a test user), then
   **Create credentials → OAuth client ID → Web application** with the callback URL.
   Secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
4. You can also skip Connect and add channels by handle on the Accounts tab.

**X** (paid).
1. <https://console.x.com> → create an app. Turn on **OAuth 2.0** as a confidential client
   (Web app) with the callback URL. Secrets: `X_CLIENT_ID`, `X_CLIENT_SECRET`.
2. Copy the app's **Bearer token**. Secret: `X_BEARER_TOKEN`. The daily job reads follower
   counts and post views with it.
3. Add credits. X charges per request. `x_recent_posts` in `config/accounts.toml` sets how many
   recent posts per account it reads each day (default 10; 0 for followers only).
4. You can also skip Connect and add X accounts by handle.

### 5. Connect the accounts

Open the live page → **Accounts** → **Connect**. The next morning's update fills in the
dashboard. To get numbers right away, run **Actions → Daily stats → Run workflow**.

## Using the page

- **Dashboard:** total followers, views, new followers, clips posted and average views per clip,
  each compared with the previous period. Follower growth over time, where the audience is by
  platform, views and new followers per day, a sortable account table with trend lines, the top
  clips, and the accounts that didn't update. Click any account for its own charts.
- **Accounts:** connect accounts, add YouTube or X accounts by handle, rename them, group them,
  pause tracking, or remove them. Removing an account deletes its history.
- **Filters** at the top of the dashboard (range, platforms, groups) apply to everything on it.

## How the numbers are counted

| Platform | Followers | Views per day | Clip views |
|---|---|---|---|
| YouTube | Subscribers | Change in channel's total views | Per video |
| TikTok | Followers | Change in total views of tracked videos | Per video |
| Instagram | Followers | Instagram's own daily "views" | Per post |
| Facebook | Page followers | Facebook's own daily Page views | Per Reel |
| X | Followers | Change in total views of tracked posts | Per post |

- Growth starts the day an account is connected. The platforms only give today's follower
  count, so the lines fill in day by day.
- On a day an account fails to update, the dashboard carries its last follower count so network
  totals don't dip, and lists the account under Data health with the reason.
- Each run refreshes the 30 most recent posts per account (`recent_posts` in
  `config/accounts.toml`). Older clips keep their last known numbers.
- TikTok logins last a year from their last use, so daily runs keep them alive. If one expires,
  the Accounts tab shows it; click Connect for that account again.

## Working on the code

```bash
python3.13 -m venv .venv && .venv/bin/pip install -e ".[dev]"
```

```bash
.venv/bin/pytest
```

- `web/`: the live page. `dashboard.js` draws the dashboard; `app.js` handles sign-in and
  the Accounts tab. Preview it locally with `python3 -m http.server --directory web` and open
  `http://localhost:8000/?sample`.
- `supabase/migrations/`: tables, access rules and the functions the daily job saves through.
- `supabase/functions/`: the Connect step (`connect-start`, `connect-callback`). Their tests
  run with `deno test --allow-env supabase/functions/_tests`.
- `src/clipper_analytics/`: the daily job. One collector per platform in `platforms/`.
- `clipper demo --json web/sample.json` regenerates the sample data.

Without Supabase settings, `clipper collect` falls back to CSV files in `data/` and
`clipper build` writes a standalone page to `dashboard/`. Both folders are git-ignored so no
numbers end up in this public repo.
