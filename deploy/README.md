# Deploying Forge

Two environments, one setup (`deploy/docker-compose.yml`), different `deploy/.env`:

| | Production | Staging |
|---|---|---|
| Where | Azure VM | On-premises server |
| Reachable from | Company network / VPN only | Company network / VPN only |
| Example addresses | `forge.example.com`, `*.preview.forge.example.com` | `forge-staging.example.com`, `*.preview.forge-staging.example.com` |
| HTTPS (`TLS_MODE`) | `letsencrypt-azure` or `company-ca` | `internal` or `company-ca` |

```
browser ──HTTPS──► Caddy :443 ─┬─ forge.<domain>          → web :4310  (/api/* → orchestrator :8790)
                               ├─ forge.<domain>/api/ws   → orchestrator :8790 (live events)
                               └─ <id>.preview.<domain>   → orchestrator preview proxy :7777
                                                               └─► project sandbox containers (Docker)
Postgres :5433 (loopback only)
```

## 1. Server

**Azure VM (production)**
- Ubuntu Server 24.04 LTS, **Standard_D8s_v5** (8 vCPU, 32 GB) to start. Each running project uses about 1–1.5 GB of memory, and full-stack projects later about 4 GB.
- OS disk plus a **256 GB Premium SSD** data disk mounted at `/var/lib/docker`, which holds images, project workspaces and the database.
- **No public IP.** Put the VM in a subnet reachable from your VPN or office network. The network security group allows inbound 443 (and 80, for redirects) **only from those address ranges**, plus SSH from your admin range or Azure Bastion.
- Outbound internet is needed for: the Claude API (`api.anthropic.com`), GitHub, npm and Docker Hub (images and package installs), your in-house API, and Let's Encrypt (if used).
- Backups: enable Azure Backup or daily disk snapshots, and also run `scripts/backup.sh` (below).
- Secrets: keep `deploy/.env` readable by root only (`chmod 600`). Moving them into Azure Key Vault is a later improvement.

**On-premises server (staging):** the same OS and setup, with at least 8 cores, 16–32 GB of memory and 200 GB of disk.

**Both:** install Docker Engine with the Compose plugin (`curl -fsSL https://get.docker.com | sh`), plus `git` and `curl`.

## 2. DNS

Create these records pointing at the server's **private** IP, in your internal DNS or an Azure Private DNS zone:

- `forge.example.com` A → server IP
- `*.preview.forge.example.com` A → server IP (wildcard: one name per project preview)

## 3. HTTPS (choose one per server: `TLS_MODE` in `deploy/.env`)

- **`letsencrypt-azure`**: real, automatically renewed wildcard certificates, even though the server is VPN-only. Caddy proves domain ownership by writing a TXT record through Azure DNS. You need:
  - a **public** Azure DNS zone for the domain (only TXT records are written; the A records can stay private);
  - a service principal with the **DNS Zone Contributor** role on that zone, entered as `AZURE_*` in `.env`.
- **`company-ca`**: put `fullchain.pem` (covering `FORGE_DOMAIN` and `*.PREVIEW_DOMAIN`) and `privkey.pem` in `deploy/certs/`. Company devices already trust your CA.
- **`internal`**: Caddy's own CA. Fine for staging; browsers warn until the root certificate is trusted (see `caddy/tls/internal.caddy`).

## 4. Install

```bash
git clone <forge repo> /opt/forge && cd /opt/forge
cp deploy/.env.example deploy/.env && chmod 600 deploy/.env
# edit deploy/.env: domains, TLS_MODE, POSTGRES_PASSWORD, BETTER_AUTH_SECRET, ANTHROPIC_API_KEY,
# ALLOWED_EMAIL_DOMAINS, GH_TOKEN (and AZURE_* for letsencrypt-azure)
deploy/scripts/deploy.sh
```

`deploy.sh` builds the sandbox image, builds and starts the services, applies the database schema and checks health. Run it again after `git pull` to update. Then open `https://forge.example.com` and create the first account. Sign-up is limited to `ALLOWED_EMAIL_DOMAINS`.

## 5. Operations

- **Logs:** `docker compose -f deploy/docker-compose.yml logs -f orchestrator` (or `web`, `caddy`).
- **Backups:** `0 2 * * * /opt/forge/deploy/scripts/backup.sh /var/backups/forge` (database, imported repos, project workspaces; keeps 14 days). Copy them off the server, for example with azcopy to a storage account.
- **Restore the database:** `pg_restore -U forge -d forge --clean <file>` inside the postgres container.
- **Project sandboxes:** containers named `forge-proj-<id>`, with workspaces in volumes `forge-ws-<id>`.

## Security notes

- The orchestrator mounts the Docker socket to manage sandboxes. That gives root-level control of the host, which is why the server stays VPN-only and runs nothing else.
- Agents run inside sandbox containers (non-root, memory, CPU and process limits) and see the Anthropic API key while a run is active. Before wider rollout, route model calls through a key-holding proxy so the key never enters a sandbox.
- `GH_TOKEN` stays in the orchestrator container and is never passed to sandboxes. Prefer a dedicated GitHub service account with access to only the repositories teams import.
- Sign-in is email and password until Entra SSO (phase 4b) is configured.
