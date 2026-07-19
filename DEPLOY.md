# DEPLOY.md — Mini-RAFT production bring-up (Layer 7)

> L7a (artifacts: prod Dockerfiles, `docker-compose.prod.yml`, this runbook) is done and
> verified locally — see `PROGRESS.md`. This document is **L7b**: the manual steps on the
> real Oracle Cloud VM + Cloudflare + Vercel, which need your accounts/card and can't be
> scripted from here. Run these yourself; ping for troubleshooting at any step.

## 1. Provision the Always-Free ARM VM

1. Sign up / log in at Oracle Cloud (card required for identity verification, **not charged**
   on Always Free — CLAUDE.md §4 constraint).
2. Create Compute instance: shape **VM.Standard.A1.Flex**, 2 OCPU / 12 GB (the full Always
   Free ARM allowance — one VM is enough for 3 replicas + gateway, per `PROJECT_PLAN.md` §6).
   Ubuntu 22.04 image. ARM capacity can be intermittent at create time — retry if it's out.
3. Open a public IP; in the VM's **Security List / NSG**, allow ingress on 22 (SSH) only.
   No need to open 3001-3003/8080 — the only public entry is the Cloudflare Tunnel (outbound
   from the VM, no inbound firewall rule needed for it).
4. SSH in, install Docker + the compose plugin:
   ```
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER   # re-login after this
   ```

## 2. Clone and configure

```
git clone <this repo> mini-raft && cd mini-raft
cp .env.example .env
```
Fill in `.env`:
- `AUTH_TOKEN` — `openssl rand -hex 32`
- `ALLOWED_ORIGINS` — the Vercel URL from step 4 (fill in after that step, or update + restart)
- `TUNNEL_TOKEN` — from step 3 below

## 3. Cloudflare Tunnel (public HTTPS/WSS entry)

Free Cloudflare account, no domain purchase needed (Cloudflare can issue a `*.trycloudflare.com`
-style hostname, or use a free domain if you have one).

1. Zero Trust dashboard → **Networks → Tunnels → Create a tunnel** → name it `mini-raft`.
2. Choose the Docker connector; copy the tunnel token it shows → paste into `.env` as
   `TUNNEL_TOKEN`.
3. Under **Public Hostname**, add a route: hostname → service `http://gateway:8080`
   (container-network address; `cloudflared` and `gateway` share `raft-net`). Cloudflare
   handles TLS termination and gives you `https://<hostname>` + WSS on the same hostname
   (`wss://<hostname>/ws`).

## 4. Bring the cluster up

```
./scripts/deploy-up.sh
```
Verify: `curl https://<tunnel-hostname>/health` → `200`. `docker compose -f
docker-compose.prod.yml ps` → all healthy.

## 5. Frontend on Vercel

1. Import the repo in Vercel, root directory `frontend/` (Vite preset, zero-config).
2. Env vars:
   - `VITE_WS_URL=wss://<tunnel-hostname>/ws`
   - `VITE_GATEWAY_HTTP_URL=https://<tunnel-hostname>`
   - `VITE_AUTH_TOKEN=<same as AUTH_TOKEN in .env>`
3. Deploy. Update `.env`'s `ALLOWED_ORIGINS` to the resulting `https://*.vercel.app` URL,
   then `./scripts/deploy-up.sh` again to pick it up (CORS allowlist, L6/D17).

## 6. Verify the L7 gate

- Open the Vercel URL, draw a stroke — it round-trips through the public gateway and commits.
- **Failover, remotely**: `docker compose -f docker-compose.prod.yml stop <leader container>`
  → a follower wins election, writes keep committing through the tunnel with no client change.
- **Reboot survival**: `sudo reboot` the VM → Docker's default restart policy + `docker compose`
  services (`restart: unless-stopped`) come back after Docker starts; confirm `commitIndex`
  and board state are unchanged (named volumes in `docker-compose.prod.yml` persist `DATA_DIR`
  across the reboot, not just the container restart).

## Notes / free-tier reality

- If Oracle ARM capacity is unavailable at signup, `PROJECT_PLAN.md` §6 names Fly.io as the
  documented fallback — flag before switching, it may bill beyond tiny scale.
- Replica ports (3001-3003) are published in `docker-compose.prod.yml` for direct debugging
  over SSH tunnel/`docker exec`, not meant to be internet-reachable — don't open them in the
  VM's security list.
