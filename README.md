# Clipper Network analytics

Tracks followers, views and top clips for every clipper account across **YouTube, TikTok,
Instagram, Facebook and X**, once a day, and draws it all on one dashboard.

- **Dashboard:** [`dashboard/index.html`](dashboard/index.html). Open it in any browser.
- **History:** [`data/`](data/). Plain CSV files, one row per account per day, so nothing is
  locked inside a tool.
- **Accounts:** [`config/accounts.toml`](config/accounts.toml). Add a block per account.
- **Updates:** a GitHub Action runs every morning at about 6 AM Central (Actions tab → "Daily
  stats"), commits the new numbers, and rebuilds the dashboard.

Every number comes from each platform's own official API. Nothing is scraped.

## Seeing the dashboard

The repo is private, so GitHub won't show the page itself. Clone the repo with **GitHub
Desktop**, click **Fetch origin → Pull origin** to get the latest numbers, and double-click
`dashboard/index.html`. It needs an internet connection for the chart library.

To preview the layout with invented numbers before any account is connected:

```bash
clipper demo
```

Then open `demo/dashboard.html`. The `demo/` folder is git-ignored and never touches the real data.

## What the dashboard shows

- **Total followers** across the network, with growth over the selected range.
- **Views**, **new followers**, **clips posted** and **average views per clip**, each compared
  with the previous period.
- **Follower growth** over time, and **where the audience is** split by platform.
- **Views per day** and **new followers per day**, stacked by platform.
- **Accounts table**, sortable by any column, with a trend line per account. Click an account
  to open its own charts and top clips.
- **Top clips**, either the most viewed in the range or the ones gaining fastest since yesterday.
- **Data health**: any account that didn't update, and why (expired token, wrong handle…).

Filters at the top (7 days, 30 days, 90 days, 1 year, all time; platforms; groups) apply to everything.

## Setup

### 1. Install (on your Mac, once)

```bash
cd "/Users/mattgraham/Real AF/clipper-analytics"
```

```bash
python3.13 -m venv .venv && .venv/bin/pip install -e ".[dev]"
```

```bash
cp .env.example .env && chmod 600 .env
```

Fill in `.env` as you go through the platforms below. It's git-ignored. Every value in it
also goes into GitHub: **repo → Settings → Secrets and variables → Actions → New repository secret**,
same name. `.venv/bin/clipper check` shows which platforms are ready.

You can set up one platform at a time. Platforms without credentials are skipped, not failed.

### 2. YouTube (free, about 10 minutes)

1. Go to <https://console.cloud.google.com>, create a project (e.g. "Clipper analytics").
2. **APIs & Services → Library**, enable **YouTube Data API v3**.
3. **APIs & Services → Credentials → Create credentials → API key.** Restrict it to the
   YouTube Data API v3.
4. Save it as `YOUTUBE_API_KEY`.

Each channel uses about 3 of the 10,000 free daily quota units, so this covers thousands of channels.

### 3. Facebook Pages and Instagram (free, about 30 minutes)

One token covers both. Each Instagram account must be a **Business or Creator** account
**linked to a Facebook Page** (Instagram app → Settings → Account type and tools).

1. At <https://developers.facebook.com/apps> create an app of type **Business**, connected to
   your Meta Business portfolio.
2. In **Meta Business Suite → Settings → Users → System users**, add a system user (Admin).
3. **Assign assets**: give it every clipper Page and Instagram account (view/insights access).
4. **Generate token** for your app, expiry **Never**, with these permissions:
   `pages_show_list`, `pages_read_engagement`, `read_insights`, `instagram_basic`,
   `instagram_manage_insights`, `business_management`.
5. Save it as `META_ACCESS_TOKEN`.
6. List what the token can see, ready to paste into `accounts.toml`:

   ```bash
   .venv/bin/clipper discover meta
   ```

Because you're only reading accounts your own business owns, the app normally doesn't need Meta
app review. When you add a new Page or Instagram account later, assign it to the system user too.

### 4. TikTok (free, needs TikTok's app review)

TikTok only shares account stats after each account logs in once and approves access.

1. At <https://developers.tiktok.com> create an app. Add **Login Kit** and the scopes
   `user.info.basic`, `user.info.profile`, `user.info.stats` and `video.list`.
2. Add a **redirect URI**. It can be any `https://` page you control. It only has to load, because
   you'll copy its address after logging in. Save it as `TIKTOK_REDIRECT_URI`.
3. Save the app's **Client key** and **Client secret** as `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET`.
4. Submit the app for review. Until it's approved, you can use the app's **Sandbox** with the
   accounts added there as target users.
5. Create the key that encrypts the saved TikTok logins, and save it as `CLIPPER_TOKEN_KEY`:

   ```bash
   .venv/bin/clipper keygen
   ```

6. For each TikTok account in `accounts.toml`, connect it once (log into that TikTok account in
   your browser first):

   ```bash
   .venv/bin/clipper auth tiktok realaf-clips-tt
   ```

7. Commit and push `data/tokens.enc`. It's encrypted, and the daily job keeps it fresh.

A TikTok connection lasts a year from its last use, so daily runs keep it alive. If an account
shows "TikTok connection expired" under Data health, run step 6 again for it.

### 5. X (paid)

1. At <https://console.x.com> create an app and copy its **Bearer token**.
2. Add credits. X charges per request. All X accounts' follower counts come from one request
   a day. Views per post cost more, so `x_recent_posts` in `accounts.toml` sets how many recent
   posts per account to read (default 10; set 0 for followers only).
3. Save it as `X_BEARER_TOKEN`.

### 6. Add the accounts and run

Add every account to [`config/accounts.toml`](config/accounts.toml), then try it locally:

```bash
.venv/bin/clipper collect
```

Commit and push. From then on the GitHub Action runs every morning. To run it right away:
**Actions → Daily stats → Run workflow**.

## How the numbers are counted

| Platform | Followers | Views per day | Clip views |
|---|---|---|---|
| YouTube | Subscribers | Change in channel's total views | Per video |
| TikTok | Followers | Change in total views of tracked videos | Per video |
| Instagram | Followers | Instagram's own daily "views" | Per post |
| Facebook | Page followers | Facebook's own daily Page views | Per Reel |
| X | Followers | Change in total views of tracked posts | Per post |

- Growth starts the day an account is added. The APIs only give today's follower count, not
  history, so the lines fill in day by day.
- On a day an account fails to update, the dashboard carries its last follower count so
  network totals don't dip, and lists the account under Data health.
- Each run refreshes the most recent `recent_posts` posts per account (default 30). Older clips
  keep their last known numbers.
- Meta renames insight metrics from time to time. The collectors try the current names first,
  fall back to older ones, and note it on the dashboard if none work.

## Commands

| Command | What it does |
|---|---|
| `clipper check` | Lists accounts per platform and which credentials are missing |
| `clipper collect` | Fetches today's numbers and rebuilds the dashboard (`--only <id or platform>`) |
| `clipper build` | Rebuilds the dashboard from saved data |
| `clipper demo` | Builds a sample dashboard from invented numbers |
| `clipper discover meta` | Lists the Pages and Instagram accounts the Meta token can see |
| `clipper auth tiktok <id>` | Connects a TikTok account |
| `clipper keygen` | Creates a `CLIPPER_TOKEN_KEY` |

Run them as `.venv/bin/clipper …`, or activate the environment first with `source .venv/bin/activate`.

## Development

```bash
.venv/bin/pytest
```

Code lives in `src/clipper_analytics/`: one collector per platform in `platforms/`, the CSV
history in `store.py`, the daily run in `collect.py`, and the dashboard page in
`dashboard_template.html`.
