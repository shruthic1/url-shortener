# CLAUDE.md

## Project

A URL shortener built for a DevOps take-home assignment. The app is deliberately simple:
the assignment is judged on how well it is deployed and run, not on features.
"A simple app that's deployed well beats a complex one that barely runs."

Assignment requirements:
- Public web page served from a Linux EC2 instance
- A database the app writes to and reads from
- A health check page at `/health` showing whether the app and its database connection work
- No secrets in the repo, only the ports the app needs, stay inside the AWS Free Tier
- I must be able to explain everything deployed, so keep code readable and dependencies minimal

## Working agreement

- Use plan mode for each task and wait for approval before implementing.
- Do not create, modify, or query AWS resources. I do all AWS console work myself.
  You write code, scripts, config files, and policy documents for me to review and apply.
- Do not add dependencies beyond those listed below without asking first.
- Do not add anything listed under Non-goals.
- When a decision isn't covered here, ask rather than guess.

## Architecture

Request path:
browser → DNS (Namecheap A record `go.shruthic.me` → Elastic IP) → web security group
(inbound 80/443 only) → nginx on EC2 (TLS via Let's Encrypt, HTTP→HTTPS redirect,
reverse proxy) → Express on `127.0.0.1:3000` → DB security group (5432 from web SG only)
→ RDS PostgreSQL (not publicly accessible).

- Region: us-east-2, default VPC
- EC2: t3.micro (standard credit mode), Amazon Linux 2023
- RDS: PostgreSQL, db.t4g.micro, single-AZ, 20 GB, SSL required
- Secrets: DB password in SSM Parameter Store (SecureString), read at startup via the
  EC2 instance role using the AWS SDK. Never in files, env files on the server, or logs.
- Process management: systemd, app runs as non-root user `app` from `/opt/app`
- Admin access: SSM Session Manager (no SSH, no port 22, no key pair)
- CI/CD: GitHub Actions → least-privilege IAM user (access key in GitHub secrets) →
  SSM Run Command runs `deploy/deploy.sh <commit SHA>` on the instance → workflow verifies
  `https://go.shruthic.me/health` returns 200. OIDC was the original design; the free-plan
  account's organization policy denies creating an OIDC provider, so it is a "before real
  customers" item.

## Stack

- Node.js LTS (pin in `package.json` `engines` and `.nvmrc`), CommonJS or ESM, be consistent
- Express 5
- `pg` (node-postgres) with a single shared `Pool`
- `@aws-sdk/client-ssm` for Parameter Store
- Dev only: `supertest`; tests use the built-in runner (`node --test`)
- Local env loading: Node's built-in `--env-file=.env` flag (no dotenv)
- Frontend: plain HTML, CSS, and browser JavaScript in `public/`, served by `express.static`

## Non-goals (do not build)

Redis or any cache, separate services, Docker, an ORM, a migration framework, user
accounts or auth, a frontend framework, rate limiting, custom codes, link editing or
deletion. Several of these are deliberate "before real customers" items for the demo.

## API contract

- `GET /` serves `public/index.html`: a form to shorten a URL, the result with a copy
  button, and a list of recent links with click counts.
- `POST /api/shorten`, body `{"url": "..."}`
  - `201` → `{"code", "short_url", "long_url"}`
  - `400` → `{"error": "..."}` for invalid input
- `GET /api/links` → `200` with the 10 most recent links:
  `[{"code", "short_url", "long_url", "used_count", "created_at"}]`
  (Public list exists to demonstrate DB reads in the demo; removing it is a
  "before real customers" item.)
- `GET /:code` (only when code matches `^[A-Za-z0-9]{7}$`)
  - Atomically increment and fetch in one query:
    `UPDATE links SET used_count = used_count + 1 WHERE short_code = $1 RETURNING long_url`
  - `302` with `Location: <long_url>` if found, `404` otherwise
- `GET /health`
  - Runs `SELECT 1` with a 2-second timeout
  - `200` → `{"app": "ok", "database": "ok"}`
  - `503` → `{"app": "ok", "database": "error"}`
- Anything else → `404`

## Short codes

- 7 characters from a–z, A–Z, 0–9, generated with `crypto.randomInt`
- Insert with `short_code` as primary key; on unique-violation (Postgres error `23505`),
  regenerate and retry, max 3 attempts, then return `500`
- Shortening the same long URL twice creates two separate codes

## URL validation

- Parse with the built-in `URL` class, not a regex
- Allow only `http:` and `https:` protocols
- Max length 2048 characters
- Reject URLs whose hostname is the app's own host (from `BASE_URL`) to prevent loops

## Database

Single table, defined in `db/schema.sql` using idempotent statements:

```sql
CREATE TABLE IF NOT EXISTS links (
  short_code  CHAR(7) PRIMARY KEY,
  long_url    TEXT NOT NULL,
  used_count  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Applied by `scripts/migrate.js`, which reuses the app's DB connection code (so it gets the
password the same way the app does). `deploy.sh` runs it on every deploy; it must be safe
to run repeatedly.

## Configuration (environment variables)

| Variable | Local dev | On EC2 (in `/etc/url-shortener/app.env`) |
|---|---|---|
| `PORT` | 3000 | 3000 |
| `HOST` | 127.0.0.1 | 127.0.0.1 |
| `BASE_URL` | http://localhost:3000 | https://go.shruthic.me |
| `DB_HOST` | localhost | RDS endpoint |
| `DB_PORT` | 5432 | 5432 |
| `DB_NAME` | urlshortener | urlshortener |
| `DB_USER` | shortener | shortener |
| `DB_PASSWORD` | in local `.env` | not set |
| `DB_PASSWORD_PARAM` | not set | `/url-shortener/db-password` |
| `DB_SSL` | false | true |
| `DB_SSL_CA_PATH` | not set | path to the RDS CA bundle on the instance |
| `AWS_REGION` | not set | us-east-2 |

Password resolution: if `DB_PASSWORD_PARAM` is set, fetch it from Parameter Store with
decryption at startup; otherwise use `DB_PASSWORD`. Fail fast with a clear error if neither.
When `DB_SSL=true`, verify the server certificate using the CA bundle
(`rejectUnauthorized: true`); never disable verification.
Provide `.env.example` with placeholder values. `.env` must be gitignored.
On EC2 the non-secret variables live in one file, `/etc/url-shortener/app.env`
(`root:app`, mode 640, template in `deploy/app.env.example`). The systemd unit loads it with
`EnvironmentFile=` and `deploy.sh` sources it before the migration, so both always see the
same settings. It never contains the password, only the Parameter Store name.

## Runtime behavior

- `app.set('trust proxy', 1)` because nginx is in front
- Bind to `HOST` (127.0.0.1), never 0.0.0.0
- Graceful shutdown on `SIGTERM` and `SIGINT`: stop accepting connections, finish in-flight
  requests, close the pool, exit
- Log to stdout/stderr only (journald captures it): one line per request with method,
  path, status, and duration; log errors with stack traces; never log secrets or full
  connection strings
- Parameterized queries only, never string concatenation

## Deployment files (`deploy/`)

- `deploy.sh <sha>`: run as root by SSM. As user `app` in `/opt/app`: fetch and check out
  the exact SHA, `npm ci --omit=dev`, source `/etc/url-shortener/app.env` and run
  `node scripts/migrate.js`; then `systemctl restart url-shortener` and wait for the local
  `/health` to return 200. Use `set -euo pipefail`; exit non-zero on any failure;
  print clear step-by-step output (it appears in the GitHub Actions log).
- `url-shortener.service`: systemd unit, `User=app`, `WorkingDirectory=/opt/app`,
  `EnvironmentFile=/etc/url-shortener/app.env`, `Restart=on-failure`, enabled on boot.
- `app.env.example`: template for `/etc/url-shortener/app.env` with the EC2 values above.
- `SETUP.md`: ordered one-time checklist of console and instance steps, for me to follow.
- `nginx.conf`: server block for `go.shruthic.me` on port 80 proxying to
  `http://127.0.0.1:3000` with `Host`, `X-Real-IP`, `X-Forwarded-For`, and
  `X-Forwarded-Proto` headers. Certbot will add the HTTPS block and redirect, so write the
  HTTP version only.

## CI/CD (`.github/workflows/deploy.yml`)

- Trigger: push to `main` (plus `workflow_dispatch`)
- `concurrency` group so deploys never overlap
- Job `test`: Postgres service container, `npm ci`, apply schema, `npm test`
- Job `deploy` (needs `test`): `permissions: contents: read`;
  `aws-actions/configure-aws-credentials` with `aws-access-key-id` and
  `aws-secret-access-key` from GitHub secrets; `aws ssm send-command`
  with `AWS-RunShellScript` targeting the instance, running `deploy.sh $GITHUB_SHA`;
  wait for completion; print the command output; fail if the command failed; then curl
  `https://go.shruthic.me/health` with retries and fail unless it returns 200
- Repository variables (not secrets) for `EC2_INSTANCE_ID` and `AWS_REGION`; repository
  secrets for `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (the IAM user's only key)
- Pin third-party actions to version tags

Also write, in `infra/`, the IAM documents for me to apply by hand:
- `github-deploy-permissions.json`: attached to the IAM user `url-shortener-github-deploy`;
  `ssm:SendCommand` on only the instance ARN and the
  `AWS-RunShellScript` document; `ssm:GetCommandInvocation` and
  `ssm:ListCommandInvocations`
- `ec2-instance-parameter-policy.json`: `ssm:GetParameter` on only
  `/url-shortener/db-password`

## Repo layout

```
src/server.js         starts Express, graceful shutdown
src/app.js            routes (exported for tests, no listen)
src/db.js             pool, password resolution, SSL config
src/shortcode.js      code generation
src/validate.js       URL validation
scripts/migrate.js    applies db/schema.sql
db/schema.sql
public/               index.html, app.js, styles.css
test/
deploy/               deploy.sh, url-shortener.service, nginx.conf, app.env.example, SETUP.md
infra/                IAM policy documents
.github/workflows/deploy.yml
.env.example  .nvmrc  .gitignore  README.md  CLAUDE.md
```

## Testing

- Every route has tests: valid shorten, invalid URLs (bad protocol, too long, self-loop),
  redirect increments the count, unknown code 404, malformed code path 404, recent links
  list, health 200 when DB is up
- Tests run against a real Postgres (local, or the CI service container), never mocks;
  use a separate test database and clean the table between tests
- `npm test` must pass before any task is considered done

## README (written last)

How to run locally, how it's deployed (each AWS resource and why), how CI/CD works, a
Mermaid architecture diagram of the request path plus the deploy path, and a
"before real customers" section: ALB + Auto Scaling group, RDS Multi-AZ, custom VPC with
private subnets, Secrets Manager rotation, monitoring and alerts on /health, Docker,
rate limiting, a real migration tool, removing the public links list.
