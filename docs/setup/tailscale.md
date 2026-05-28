# Exposing the webhook server with Tailscale Funnel

The Sandy worker runs an HTTP server on **host port 3007** that receives GitHub
webhooks. GitHub needs a public HTTPS URL to deliver to. [Tailscale
Funnel][funnel] gives you one — a stable `https://<host>.<tailnet>.ts.net` URL
that forwards to a local port — without opening a router port or running a
reverse proxy.

Funnel is the recommended ingress. Anything that terminates TLS publicly and
forwards to `127.0.0.1:3007` works (Cloudflare Tunnel, an ngrok reserved domain,
a real reverse proxy), but the rest of these docs assume Funnel.

## 1. Install and authenticate Tailscale

Install Tailscale on the host and bring it up:

```bash
brew install tailscale
sudo tailscale up
```

Follow the printed URL to authenticate the host into your tailnet.

## 2. Enable Funnel for your tailnet

Funnel is off by default. In the [admin console][acl], confirm:

- **HTTPS certificates** are enabled (Settings → Feature previews / DNS).
- A **Funnel** node attribute / ACL grant covers this host. Tailscale's CLI
  prints the exact admin-console link to approve Funnel if your policy hasn't
  granted it yet — run the command in the next step and follow the link it
  gives you.

## 3. Forward the public URL to port 3007

Point Funnel at the worker's port. This serves your public `:443` from the local
HTTP server on **3007**:

```bash
sudo tailscale funnel --bg 3007
```

`--bg` runs it in the background and persists the configuration across reboots.
Check what's exposed:

```bash
tailscale funnel status
```

You should see your `https://<host>.<tailnet>.ts.net` URL mapped to
`http://127.0.0.1:3007`. That HTTPS URL is your **Webhook URL** — paste it into
the GitHub App config (see [`github-app.md`](./github-app.md) step 1), with no
extra path unless you've changed the worker's webhook route.

To stop exposing it:

```bash
sudo tailscale funnel --bg off
```

## 4. Verify end to end

1. Start the worker (manually with `pnpm dev`, or via the
   [launchd service](./launchd.md)) so something is actually listening on 3007.
2. Hit the Funnel URL from another machine:

   ```bash
   curl -i https://<host>.<tailnet>.ts.net/
   ```

   You should get an HTTP response from the worker (a non-webhook GET without a
   valid signature is expected to be rejected — a `4xx` here still proves the
   path is wired; a connection error or `502` means nothing is listening on
   3007).
3. In GitHub **App settings → Advanced → Recent Deliveries**, redeliver a
   webhook (or post `@bot review` on a test PR) and confirm a `2xx`.

> **Why 3007 specifically.** The worker binds 3007 by default and the GitHub App
> webhook is pointed at the Funnel URL that fronts it. If you change the port,
> change it in three places consistently: the worker's listen port, the Funnel
> target, and any health-check command — and keep the App's Webhook URL pointed
> at the Funnel front, which doesn't change.

## Next

Author [`.config/bot.yaml`](./bot-yaml.md), then install the
[launchd service](./launchd.md) so the worker (and thus port 3007) comes up on
boot.

[funnel]: https://tailscale.com/kb/1223/funnel
[acl]: https://login.tailscale.com/admin/acls
