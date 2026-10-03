# Self-hosted deployment (VPS)

`server.js` reproduces the part of the Vercel runtime this project uses: static files from `public/`,
`/api/<name>` → `api/<name>.js` (`req.query`, JSON `req.body`, `res.status().json()`), response headers
and per-function `maxDuration` from `vercel.json`. No extra dependencies.

```
Internet → nginx :443 (vhost amnezia-web, TLS, rate limits)
         → 127.0.0.1:13100 → container amnezia-web :3000 → node server.js → api/* + public/*
```

The application is stateless: everything needed to rebuild it is in Git. The host is shared with
other services — never add `default_server` to the vhost and never touch other vhosts/containers.

## Layout on the VPS

| Path | Content |
| --- | --- |
| `/opt/amnezia-web/releases/<sha>/` | `git archive` of a commit (+ `REVISION`), last 3 kept |
| `/opt/amnezia-web/current` → `releases/<sha>` | active release; `current.rev` holds the sha |
| image `amnezia-web:<sha>` | built per release, kept with the release for instant rollback |
| `/etc/nginx/sites-available/amnezia-web` | copy of `deploy/nginx-amnezia.conf` |
| `/etc/nginx/snippets/amnezia-proxy.conf` | copy of `deploy/nginx-amnezia-proxy.conf` |
| `/var/log/nginx/amnezia-web.{access,error}.log` | vhost logs |
| `/etc/letsencrypt/live/<host>/` | certificate (webroot `/var/lib/letsencrypt`, `certbot.timer`) |
| `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh` | `nginx -t && systemctl reload nginx` after renewal |

## Deploy / rollback

Only committed code is deployed (`git archive`), so a dirty working tree never leaks to the server.

```bash
deploy/deploy.sh                 # deploy HEAD
deploy/deploy.sh <sha|tag>       # deploy a specific revision; also the rollback command
```

`remote-activate.sh` builds `amnezia-web:<sha>` (skipped if it exists), recreates the container
(~2–3 s of 502 during the swap), waits for Docker health and automatically reactivates the previous
release if the new one is unhealthy.

## Operations cheat sheet (on the VPS)

```bash
cat /opt/amnezia-web/current.rev                                  # deployed revision
docker ps --filter name=amnezia-web --format '{{.Status}}'        # state + health
docker inspect -f 'restarts={{.RestartCount}} started={{.State.StartedAt}}' amnezia-web
docker logs --tail 100 amnezia-web                                # app logs (rotated 3x10 MB)
docker stats --no-stream amnezia-web                              # memory / CPU
docker restart amnezia-web                                        # restart only this app
curl -s http://127.0.0.1:13100/api/status                         # app health, bypassing nginx
nginx -t && systemctl reload nginx                                # never restart/stop nginx
certbot certificates -d valokda-amnezia.185-77-219-233.sslip.io   # certificate expiry
df -h / && free -m && du -sh /var/log/nginx

# traffic summary from the vhost log
L=/var/log/nginx/amnezia-web.access.log
awk '{print $7}' $L | sort | uniq -c | sort -rn          # status codes (4xx/5xx/429)
awk '{print $5}' $L | sed 's/?.*//' | sort | uniq -c | sort -rn | head -20   # paths
awk '{print $1}' $L | sort | uniq -c | sort -rn | head -10                   # client IPs
```

## Disaster recovery on a clean VPS

Nothing application-specific lives only on the server except the TLS key (re-issuable) and the vhost
(in Git). Steps:

1. Install Docker (with compose plugin), nginx, certbot; open 80/443.
2. Point DNS to the new IP (for sslip.io the host name itself changes with the IP).
3. `mkdir -p /opt/amnezia-web/releases /var/lib/letsencrypt`; copy `deploy/nginx-amnezia-proxy.conf`
   to `/etc/nginx/snippets/amnezia-proxy.conf`.
4. Install a temporary HTTP-only vhost serving `/.well-known/acme-challenge/` from
   `/var/lib/letsencrypt`, then `certbot certonly --webroot -w /var/lib/letsencrypt -d <host>`.
5. Install `deploy/nginx-amnezia.conf` (with the new host), `nginx -t && systemctl reload nginx`.
6. Add `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh` (see table above), `chmod +x`.
7. Locally: `DEPLOY_HOST=root@<new-ip> deploy/deploy.sh <sha>`.

## Attach the permanent domain

1. DNS `A` record → VPS IP.
2. Change `server_name` and certificate paths in `nginx-amnezia.conf` (and the host in `deploy.sh`).
3. Issue the certificate (step 4 above), install the vhost, `nginx -t && systemctl reload nginx`.
4. Update absolute URLs: `public/index.html` (canonical, og:url, og:image, JSON-LD),
   `public/sitemap.xml`, `public/robots.txt`, `package.json` `homepage`, README links.
5. Optionally keep the sslip.io host as a 301 redirect to the new domain.

## Local run

```bash
PORT=3000 node server.js
```
