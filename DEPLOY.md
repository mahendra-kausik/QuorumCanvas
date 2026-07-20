# DEPLOY.md — Mini-RAFT production bring-up (Layer 7)

> L7a (artifacts: prod Dockerfiles, `docker-compose.prod.yml`, this runbook) is done and
> verified locally — see `PROGRESS.md`. This document is **L7b**: the manual steps on the
> real GCP VM + Cloudflare + Vercel, which need your accounts/card and can't be scripted from
> here. Run these yourself; ping for troubleshooting at any step.

## 1. Provision the VM (GCP, free trial credits)

1. Sign up / log in at Google Cloud Console. New accounts get a **Free Trial billing
   account preloaded with $300 credit, valid 90 days** — usable on any region/instance size,
   and GCP does **not** auto-charge past it: resources stop and the trial account closes when
   the credit or the 90 days run out (CLAUDE.md §4 constraint — no surprise billing).
2. Compute Engine → **Create instance**: machine type **`e2-small`** (2 vCPU / 2 GB RAM —
   comfortably fits 3 replicas + gateway + `cloudflared` with no swap file needed), region
   **asia-south1 (Mumbai)**, **Ubuntu 22.04 LTS** boot disk (default balanced persistent disk,
   e.g. 20-30 GB — survives reboot, holds the named Docker volumes). Confirm the instance is
   billed to the Free Trial billing account (draws the $300 credit, not a paid one).
3. Firewall: allow ingress on **tcp:22 (SSH) only** (GCP's default `default-allow-ssh` network
   tag covers this, or add a rule). No need to open 3001-3003/8080 — the only public entry is
   the Cloudflare Tunnel (outbound from the VM, no inbound firewall rule needed for it).
4. SSH in, install Docker + the compose plugin:
   ```
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER   # re-login after this
   ```

## 2. Clone, authenticate to Artifact Registry, and configure

Images are **built + pushed to GCP Artifact Registry locally** (a 2GB VM can't afford
`npm ci`+`tsc` for 3 services concurrently) — the VM only ever `pull`s, it never builds.

```
git clone https://github.com/mahendra-kausik/QuorumCanvas.git mini-raft && cd mini-raft
cp .env.example .env
```
Authenticate Docker on the VM to Artifact Registry (no `gcloud` install needed — uses the
VM's attached service-account identity via the metadata server; the instance must have been
created with the `cloud-platform` access scope):
```
docker login -u oauth2accesstoken \
  -p "$(curl -s -H 'Metadata-Flavor: Google' \
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')" \
  https://asia-south1-docker.pkg.dev
```
Fill in `.env`:
- `AUTH_TOKEN` — `openssl rand -hex 32`
- `ALLOWED_ORIGINS` — the Vercel URL from step 4 (fill in after that step, or update + restart)
- `TUNNEL_TOKEN` — only if using the named-tunnel profile (step 3); leave blank for quick tunnel

## 3. Cloudflare Tunnel (public HTTPS/WSS entry)

Two options — pick based on whether you have a Cloudflare account/domain:

**Quick tunnel (no account needed, used here):** nothing to set up — `cloudflared-quick`
(profile `quicktunnel`) opens a token-free tunnel and prints an ephemeral
`https://<random>.trycloudflare.com` hostname to its own logs on startup. Tradeoff: the
hostname **changes** if the container restarts (incl. a VM reboot) — re-fetch it from logs
each time (step 4).

**Named tunnel (stable hostname, needs a free Cloudflare account + a domain you own):**
1. Zero Trust dashboard → **Networks → Tunnels → Create a tunnel** → name it `mini-raft`.
2. Choose the Docker connector; copy the tunnel token it shows → paste into `.env` as
   `TUNNEL_TOKEN`.
3. Under **Public Hostname**, add a route: hostname → service `http://gateway:8080`
   (container-network address; `cloudflared` and `gateway` share `raft-net`). Cloudflare
   handles TLS termination and gives you `https://<hostname>` + WSS on the same hostname
   (`wss://<hostname>/ws`). Use the `tunnel` profile instead of `quicktunnel` in step 4.

## 4. Bring the cluster up

```
./scripts/deploy-up.sh quicktunnel
```
(or `./scripts/deploy-up.sh tunnel` for the named-tunnel profile above). This pulls the
prebuilt images from Artifact Registry — no build step on the VM.

Get the public URL (quick tunnel only — skip for a named tunnel, you already know the hostname):
```
docker compose -f docker-compose.prod.yml logs cloudflared-quick | grep trycloudflare.com
```
Verify: `curl https://<url>/health` → `200`. `docker compose -f docker-compose.prod.yml ps` →
all healthy.

## 5. Frontend on Vercel

1. Import the repo in Vercel, root directory `frontend/` (Vite preset, zero-config).
2. Env vars:
   - `VITE_WS_URL=wss://<url>/ws`
   - `VITE_GATEWAY_HTTP_URL=https://<url>`
   - `VITE_AUTH_TOKEN=<same as AUTH_TOKEN in .env>`
3. Deploy. Update `.env`'s `ALLOWED_ORIGINS` to the resulting `https://*.vercel.app` URL,
   then `./scripts/deploy-up.sh quicktunnel` again to pick it up (CORS allowlist, L6/D17).

## 6. Verify the L7 gate

- Open the Vercel URL, draw a stroke — it round-trips through the public gateway and commits.
- **Failover, remotely**: `docker compose -f docker-compose.prod.yml stop <leader container>`
  → a follower wins election, writes keep committing through the tunnel with no client change.
- **Reboot survival**: `sudo reboot` the VM → Docker's default restart policy + `docker compose`
  services (`restart: unless-stopped`) come back after Docker starts; confirm `commitIndex`
  and board state are unchanged (named volumes in `docker-compose.prod.yml` persist `DATA_DIR`
  across the reboot, not just the container restart). With the quick-tunnel profile, the
  reboot also restarts `cloudflared-quick` with a **new** URL — re-fetch it (step 4) and
  re-point Vercel; this is the state-survives-but-URL-doesn't tradeoff of the token-free path.

## Notes / free-tier reality

- This runs on the **GCP $300/90-day free trial**, not an always-free tier — the deployment is
  meant to be live for a season (e.g. placement interviews), not permanently. Track the trial
  end date; at ~$25-36/mo for `e2-small` (with sustained-use discount), 3 months draws roughly
  $75-80 of the $300, so the 90-day window runs out before the credit does. **Delete the
  instance** (Compute Engine → the instance → Delete) once you're done demoing, to stop credit
  burn and avoid any chance of the trial rolling into a paid account.
- Replica ports (3001-3003) are published in `docker-compose.prod.yml` for direct debugging
  over SSH tunnel/`docker exec`, not meant to be internet-reachable — don't open them in the
  VM's firewall rules.
