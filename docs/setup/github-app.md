# Registering the Sandy GitHub App

Sandy talks to GitHub as a **GitHub App** — not a personal access token. The App
gives Sandy a stable identity ("Sandy" appears as the comment author), scoped
per-installation permissions, and webhook delivery for the events that trigger a
Review.

This walkthrough registers the App, sets its permissions and webhook events,
installs it on the repositories you want reviewed, and captures its credentials
into `.config/.env`.

> You set the webhook **URL** here too. If you haven't configured ingress yet,
> register the App with a placeholder URL now and come back to fill in the real
> Funnel URL after [`tailscale.md`](./tailscale.md). The webhook **secret** you
> generate below is needed regardless.

## 1. Create the App

Register the App against the account (or organization) that owns the
repositories you want reviewed:

- **Personal account:** <https://github.com/settings/apps/new>
- **Organization:** `https://github.com/organizations/<org>/settings/apps/new`

Fill in:

| Field | Value |
|-------|-------|
| **GitHub App name** | `Sandy` (must be globally unique; if taken, use e.g. `Sandy-<your-handle>`) |
| **Homepage URL** | Your Sandy repo URL, or anything — not load-bearing |
| **Webhook → Active** | ✅ checked |
| **Webhook URL** | Your Tailscale Funnel URL (see [`tailscale.md`](./tailscale.md)). Placeholder OK for now. |
| **Webhook secret** | A long random string — generate with `openssl rand -hex 32` and **save it** |

The webhook path Sandy listens on is the root of the worker's HTTP server. Set
the **Webhook URL** to your Funnel URL with no extra path (e.g.
`https://your-host.tailXXXX.ts.net/`) unless you have changed the route in the
worker config.

## 2. Set permissions

Under **Permissions → Repository permissions**, set exactly these four. Leave
everything else at **No access** — Sandy needs nothing more in Phase 1.

| Permission | Access | Why |
|------------|--------|-----|
| **Pull requests** | **Read & write** | Read PR metadata and diffs; post inline comments + the summary comment. |
| **Contents** | **Read-only** | Clone and fetch registered Repos to local disk. |
| **Issues** | **Read-only** | Required to subscribe to the **Issue comment** event in step 3 — GitHub gates that event on the Issues permission, even though `@bot review` arrives as a comment on a PR. Without it, "Issue comment" won't appear in the events list. Read-only suffices; Sandy never writes to Issues. |
| **Metadata** | **Read-only** | Mandatory baseline; GitHub auto-selects it. |

## 3. Subscribe to webhook events

Under **Subscribe to events**, check exactly these four:

| Event | Drives |
|-------|--------|
| **Pull request** | PR opened / closed / `draft → ready` transitions. Close clears `reviewActive`; ready-for-review is a Review trigger (Sticky Opt-In). |
| **Issue comment** | `@bot review` mention on a PR conversation (the opt-in trigger). Gated on the **Issues** permission from step 2 — if you don't see this event in the list, you haven't granted Issues (Read-only) yet. |
| **Pull request review comment** | Reactions/replies on Sandy's inline Findings (the trailer-driven reaction loop). Subscribe now so deliveries arrive from day one, but Phase 1 has no Reactions table — persisting reactions and feeding the learning loop is Phase 3. |
| **Push** | New commits on an opted-in PR retrigger a Review automatically (Cancel-on-Supersede if one is already in flight). |

These four events and the three permissions above are exactly what the worker's
webhook dispatcher expects. Adding more events is harmless but unused; removing
any of these will silently break a trigger.

## 4. Choose installation scope

Under **Where can this GitHub App be installed?**, pick **Only on this account**
for a personal self-hosted setup. Then click **Create GitHub App**.

## 5. Capture the App ID, private key, and webhook secret

On the App's settings page after creation:

1. Note the **App ID** (shown near the top, e.g. `App ID: 1234567`).
2. Scroll to **Private keys → Generate a private key**. A `.pem` file downloads.
   GitHub names it after the App's slug and the date —
   `sandy.<date>.private-key.pem` for the name `Sandy`, or
   `sandy-<your-handle>.<date>.private-key.pem` if you used that alternate name.
   GitHub never shows the key again — store it safely. Move it under `.config/`
   (the `sandy*` glob below matches either name; if you renamed the file or have
   more than one match, substitute the actual downloaded filename):

   ```bash
   mkdir -p .config
   mv ~/Downloads/sandy*.*.private-key.pem .config/sandy-app.private-key.pem
   ```

3. You already saved the **webhook secret** from step 1.

This doc is the single place that **creates** `.config/.env` (gitignored — see
the repo `.gitignore`). Create it with the full set of keys Sandy reads, so no
later step has to recreate the file and clobber another's value — the other docs
only fill in their own line:

```bash
# .config/.env — Sandy instance secrets
# GitHub App (this doc)
GITHUB_APP_ID=1234567
GITHUB_APP_PRIVATE_KEY_PATH=.config/sandy-app.private-key.pem
GITHUB_WEBHOOK_SECRET=the-openssl-rand-hex-32-value-from-step-1

# Convex deployment URL — see convex.md ("Where the URL goes")
CONVEX_URL=https://your-deployment.convex.cloud

# Learning-loop Finding embeddings.
OPENAI_API_KEY=sk-...

# Optional alternate Agent vendor auth. The default Codex setup can still use
# your host `codex login` (see sandcastle-image.md); set Anthropic only if you
# switch an Agent to vendor: claude.
#   ANTHROPIC_API_KEY=sk-ant-...
```

> **One file, set in pieces.** If you followed the [setup order](./README.md),
> [`convex.md`](./convex.md) ran before this doc; whichever doc you reach first,
> create `.config/.env` and the later docs just set their own line above. Set
> `CONVEX_URL` to the value Convex printed. `OPENAI_API_KEY` is required for
> Phase 3 Finding embeddings even when the default Codex Agent authenticates
> through your host `codex login`; add `ANTHROPIC_API_KEY` only if you switch an
> Agent to Claude.

> **Private key format.** Sandy reads the key from the path above. If you prefer
> to inline the key instead of pointing at a file, that's an instance choice the
> worker's config supports in a later issue; the path form is the documented
> default. Keep `.config/` out of version control, or give it its own private
> nested git repo (see the root [`README.md`](../../README.md) "Configuration").

## 6. Install the App on your repositories

From the App settings page, open **Install App** (left sidebar) → **Install** on
your account → choose **Only select repositories** and pick every Repo you plan
to register in `bot.yaml`. Sandy reviews a Repo only if the App is installed on
it **and** the Repo is declared in [`.config/bot.yaml`](./bot-yaml.md).

To add a Repo later, return here and update the installation's repository
selection — no need to recreate the App.

## 7. Verify

Once the worker is running and the Funnel is live ([`launchd.md`](./launchd.md),
[`tailscale.md`](./tailscale.md)), GitHub's **App settings → Advanced → Recent
Deliveries** shows each webhook POST and its response. A `2xx` from your Funnel
URL means delivery and signature verification succeeded. The worker rejects any
request whose `X-Hub-Signature-256` is missing or doesn't match
`GITHUB_WEBHOOK_SECRET`, so a `401` there points at a secret mismatch.

## Next

Continue to [`tailscale.md`](./tailscale.md) to expose port **3007**, then author
[`bot-yaml.md`](./bot-yaml.md).
