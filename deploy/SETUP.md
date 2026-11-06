# One-time setup checklist

Everything below is done by hand, once, in the AWS console and on the instance. After this,
every push to `main` deploys automatically. Steps are ordered so each one has what it needs
from the one before. Region is **us-east-2 (Ohio)** throughout: this account's AWS project
is pinned to that region, so the console has no region switcher.

Placeholders used in `infra/*.json`: `<ACCOUNT_ID>` (12-digit account ID) and `<INSTANCE_ID>`
(from step 5). Replace them before pasting.

## 1. GitHub deploy identity (IAM)

The intended design was an OIDC identity provider plus a role that only this repo's `main`
branch can assume, so GitHub would hold no AWS credentials at all. The free-plan project
account sits under an AWS organization policy that explicitly denies
`iam:CreateOpenIDConnectProvider`, so that is not possible here. The fallback is a dedicated
IAM user with a single access key and the same least-privilege policy.

1. IAM → IAM users → Create user. Name `url-shortener-github-deploy`, **no** console access.
2. Skip permissions for now; come back after step 5 when the instance ID exists.

## 2. Database password (Parameter Store)

Systems Manager → Parameter Store → Create parameter:
name `/url-shortener/db-password`, tier Standard, type **SecureString**, default KMS key
(`aws/ssm`), value = a long random password. Use this same value when creating RDS.

## 3. Security groups (EC2 → Security Groups, default VPC)

| Name | Inbound | Why |
|---|---|---|
| `url-shortener-web` | 80 from 0.0.0.0/0 and ::/0; 443 from 0.0.0.0/0 and ::/0 | nginx |
| `url-shortener-db` | 5432 from source **`url-shortener-web`** (pick the SG, not an IP) | app → RDS |

No port 22 anywhere.

## 4. RDS PostgreSQL

Create database → Standard create → PostgreSQL → Free tier template.
- Identifier `url-shortener-db`, master user `shortener`, password = the value from step 2
- `db.t4g.micro`, 20 GB gp3, **storage autoscaling off**
- Default VPC, **Public access: No**, security group `url-shortener-db`
- Initial database name `urlshortener`
- Single-AZ, backups on with a 1-day retention (the free plan caps it there)
- Parameter group: default already enforces `rds.force_ssl = 1` on PostgreSQL 15+.

Note the endpoint hostname once it is available (`DB_HOST` in step 7).

## 5. EC2 instance

1. IAM → Roles → Create role → AWS service → EC2. Attach the managed policy
   `AmazonSSMManagedInstanceCore` (Session Manager + Run Command). Name it
   `url-shortener-instance-role`.
2. IAM → Policies → Create policy → JSON → paste `infra/ec2-instance-parameter-policy.json`
   (fill in `<ACCOUNT_ID>`), name it `url-shortener-read-db-password`, attach it to the
   instance role.
3. EC2 → Launch instance: Amazon Linux 2023, `t3.micro`, **no key pair**, default VPC,
   security group `url-shortener-web`, IAM instance profile `url-shortener-instance-role`.
   Advanced → Credit specification: **Standard**.
4. Note the instance ID (`i-...`).
5. Back in IAM: create policy from `infra/github-deploy-permissions.json` (fill in both
   placeholders), name it `url-shortener-github-deploy`, attach it to the IAM user from
   step 1 (user → Permissions → Add permissions → Attach policies directly).
6. User → Security credentials → Create access key ("Application running outside AWS").
   Copy the key ID and secret; the secret is shown once. They go into GitHub in step 8.

## 6. Elastic IP and DNS

1. EC2 → Elastic IPs → Allocate → Associate with the instance.
2. Namecheap → Advanced DNS → add **A record** host `go`, value = the Elastic IP, TTL 5 min.
3. Confirm with `dig +short go.shruthic.me` before running certbot.

## 7. On the instance (Systems Manager → Session Manager → Start session)

```bash
sudo -i

# Packages: Node 22 (pinned in .nvmrc), nginx, git, certbot
dnf install -y nodejs22 nginx git certbot python3-certbot-nginx
node -v    # expect v22.x

# Dedicated non-root user and the app directory
useradd --system --create-home --shell /bin/bash app
git clone https://github.com/shruthic1/url-shortener.git /opt/app
chown -R app:app /opt/app

# Config directory: RDS CA bundle + non-secret env file
mkdir -p /etc/url-shortener
curl -fsSo /etc/url-shortener/rds-ca-bundle.pem \
  https://truststore.pki.rds.amazonaws.com/us-east-2/us-east-2-bundle.pem
cp /opt/app/deploy/app.env.example /etc/url-shortener/app.env
vi /etc/url-shortener/app.env          # set DB_HOST to the RDS endpoint
chown root:app /etc/url-shortener/app.env
chmod 640 /etc/url-shortener/app.env

# systemd unit
install -o root -g root -m 644 /opt/app/deploy/url-shortener.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable url-shortener

# nginx (HTTP first; certbot adds HTTPS)
install -o root -g root -m 644 /opt/app/deploy/nginx.conf /etc/nginx/conf.d/url-shortener.conf
nginx -t
systemctl enable --now nginx

# First deploy by hand (installs deps, applies schema, starts the service)
bash /opt/app/deploy/deploy.sh "$(sudo -u app git -C /opt/app rev-parse HEAD)"
curl -s http://127.0.0.1:3000/health; echo

# TLS (needs DNS from step 6 to resolve and port 80 open)
certbot --nginx -d go.shruthic.me --redirect -m you@example.com --agree-tos --no-eff-email
systemctl enable --now certbot-renew.timer   # AL2023 installs the timer but does not start it
systemctl list-timers | grep certbot        # auto-renewal timer should now be listed
```

If the first `deploy.sh` fails at step 3, check `journalctl -u url-shortener -n 50`: the
usual causes are a wrong `DB_HOST`, the DB security group, or the parameter policy.

## 8. GitHub repository variables and secrets

Repo → Settings → Secrets and variables → **Actions** (not the Agents page, which is for
Copilot only).

Variables tab:

| Variable | Value |
|---|---|
| `EC2_INSTANCE_ID` | `i-...` |
| `AWS_REGION` | `us-east-2` |

Secrets tab:

| Secret | Value |
|---|---|
| `AWS_ACCESS_KEY_ID` | the IAM user's access key ID from step 5 |
| `AWS_SECRET_ACCESS_KEY` | the IAM user's secret access key |

## 9. First automated deploy

Push to `main` and watch Actions → "Test and deploy". The `deploy` job prints the
`deploy.sh` output from the instance and then checks `https://go.shruthic.me/health`.

## 10. Cost guard

Billing → Budgets → create a zero-spend or $1 budget with an email alert.
