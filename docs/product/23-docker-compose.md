# Docker Compose deployment

A complete, copy-pasteable Docker Compose deployment of DeltaGlider Proxy. The
files in this guide are also in the repo under
[`examples/docker-compose/`](https://github.com/beshu-tech/deltaglider_proxy/tree/main/examples/docker-compose).

## How it works

DeltaGlider expands `${env:NAME}` and `${env:NAME:-default}` references **inside
its config file, in-process, when it loads** — the in-program replacement for an
external `envsubst` step. So you ship a **secret-free** `deltaglider_proxy.yaml`
with `${env:...}` placeholders, supply the values as environment variables, and
the proxy fills them at startup. An unset placeholder (with no default) fails the
proxy loudly rather than starting with a blank secret.

> The `env:` prefix is required. It keeps these load-time config placeholders
> distinct from the request-time IAM permission templates (`${iam:username}`,
> `${iam:access_key_id}`). A bare `${...}` is left untouched.

Three files:

- **`deltaglider_proxy.yaml`** — the config; secret values are `${env:...}`
  placeholders. Commit it.
- **`secrets.env`** — your real secret values (`KEY=value`). **Never commit it.**
- **`docker-compose.yml`** — runs the proxy with the config mounted and the
  secrets supplied via `env_file`.

## 1. The config

```yaml
# deltaglider_proxy.yaml — secret-free, safe to commit
storage:
  backends:
    - name: primary
      type: s3
      endpoint: ${env:S3_ENDPOINT}
      region: ${env:S3_REGION:-us-east-1}
      force_path_style: ${env:S3_PATH_STYLE:-false}   # true for MinIO / non-AWS
      access_key_id: ${env:S3_ACCESS_KEY_ID}
      secret_access_key: ${env:S3_SECRET_ACCESS_KEY}
  default_backend: primary

access:
  # A single bootstrap SigV4 pair to get started (add per-user IAM later
  # from the admin GUI, or switch to declarative mode — see below).
  access_key_id: ${env:PROXY_ACCESS_KEY_ID}
  secret_access_key: ${env:PROXY_SECRET_ACCESS_KEY}

advanced:
  listen_addr: 0.0.0.0:9000
  max_object_size: 536870912   # 512 MiB
```

## 2. The secrets

```bash
# secrets.env — your real values; gitignored, never committed.
# This is a docker-compose env_file: KEY=value, taken literally (no shell quoting).

DGP_BOOTSTRAP_PASSWORD_HASH=   # bcrypt hash; see "Admin password" below

S3_ENDPOINT=https://s3.eu-central-1.amazonaws.com
S3_REGION=eu-central-1
S3_PATH_STYLE=false
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=

PROXY_ACCESS_KEY_ID=
PROXY_SECRET_ACCESS_KEY=
```

## 3. The compose file

```yaml
services:
  # One-time: make the config volume writable by the proxy's non-root user (999)
  # so it can create its encrypted config DB. (A fresh named volume is root-owned.)
  init-perms:
    image: beshultd/deltaglider_proxy:${DGP_IMAGE_TAG:-latest}
    user: "0:0"
    entrypoint: ["/bin/sh", "-c", "chown 999:999 /etc/deltaglider_proxy && chmod 750 /etc/deltaglider_proxy"]
    volumes:
      - dgp-config:/etc/deltaglider_proxy
    restart: "no"

  deltaglider:
    image: beshultd/deltaglider_proxy:${DGP_IMAGE_TAG:-latest}
    depends_on:
      init-perms:
        condition: service_completed_successfully
    env_file:
      - secrets.env
    environment:
      DGP_CONFIG: /etc/deltaglider_proxy/deltaglider_proxy.yaml
    ports:
      - "9000:9000"
    volumes:
      - ./deltaglider_proxy.yaml:/etc/deltaglider_proxy/deltaglider_proxy.yaml:ro
      - dgp-config:/etc/deltaglider_proxy    # encrypted config DB — back this up
      - dgp-data:/data                       # delta/reconstruction scratch
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/_/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    restart: unless-stopped

volumes:
  dgp-config:
  dgp-data:
```

## 4. Run it

```bash
cp secrets.env.example secrets.env   # then fill secrets.env
docker compose up -d
docker compose logs -f deltaglider
```

The S3 API and the admin GUI are both on port `9000`:

- S3 API: `http://localhost:9000` (sign with `PROXY_ACCESS_KEY_ID` /
  `PROXY_SECRET_ACCESS_KEY`)
- Admin GUI: `http://localhost:9000/_/` (log in with the bootstrap password)

Validate the config before shipping (catches a missing `${env:...}` early):

```bash
deltaglider_proxy config lint deltaglider_proxy.yaml
```

## Admin password

`DGP_BOOTSTRAP_PASSWORD_HASH` is a **bcrypt hash**, not plaintext. Generate it:

```bash
# inside the image:
docker run --rm beshultd/deltaglider_proxy:latest --set-bootstrap-password
# or with htpasswd:
htpasswd -nbBC 12 "" 'your-password' | tr -d ':\n' | sed 's/^\$2y/\$2b/'
```

## Filesystem backend instead of S3

For a self-contained deployment with no external object store, replace the
`storage.backends` block with a filesystem backend and mount a data volume:

```yaml
storage:
  filesystem: /data
```

## Managing users as code (declarative IAM)

To manage users/groups from the YAML instead of the admin GUI, set
`access.iam_mode: declarative` and list `iam_users` / `iam_groups`. The YAML
becomes the source of truth (admin-API IAM mutations return 403) and is
reconciled into the DB on every `config apply`. Per-user prefixes use the
`${iam:username}` template:

```yaml
access:
  iam_mode: declarative
  access_key_id: ${env:PROXY_ACCESS_KEY_ID}
  secret_access_key: ${env:PROXY_SECRET_ACCESS_KEY}
  iam_users:
    - name: ci-uploader
      access_key_id: ci-uploader
      secret_access_key: ${env:USER_CI_UPLOADER_SECRET}
      enabled: true
      permissions:
        - effect: Allow
          actions: [read, write, list]
          resources: ["releases/builds/*"]
  iam_groups:
    - name: engineers
      permissions:
        - effect: Allow
          actions: [read, write, delete]
          resources: ["scratch/${iam:username}/*"]
```

See [Declarative IAM](reference/declarative-iam.md) for the full model.

## Persistence & backups

The `dgp-config` volume holds the **encrypted config DB**
(`deltaglider_config.db`) — your IAM users, groups, and OAuth providers. Back it
up. The `dgp-data` volume is scratch (caches + delta-reconstruction buffers);
object data itself lives in your S3 backend, not in these volumes.
