# Running the lead pipeline on your own server (Oracle Cloud free tier, AWS Lightsail or EC2)

The app needs a server that stays on: it keeps a database file, catches Facebook and website leads as
they arrive, and runs reminders and the two-week sweep. Static-site hosting (AWS Amplify, S3 +
CloudFront, Netlify and the like) can't run it. Any small Ubuntu server can, and the setup script here
does the whole install.

These steps use Oracle Cloud's Always Free tier. On AWS, make an **Ubuntu 24.04** instance in
**Lightsail** or **EC2** instead and pick up at step 3; the rest is the same.

## 1. Make the server (Oracle Cloud console)

1. Sign up at cloud.oracle.com (a card is needed to verify you; Always Free resources aren't charged).
   Your **home region** can't be changed later; pick **US West (San Jose)** or **US West (Phoenix)**.
2. **Compute → Instances → Create instance.**
   - **Image:** Canonical Ubuntu 24.04 (or 22.04).
   - **Shape:** Ampere `VM.Standard.A1.Flex` with 1 OCPU and 6 GB memory (Always Free). If it says
     there's no capacity, try another availability domain or `VM.Standard.E2.1.Micro`.
   - **Networking:** keep "Assign a public IPv4 address" on.
   - **SSH keys:** "Generate a key pair for me" and **download the private key**. You need it to log in.
3. After it starts, copy the instance's **Public IP address**.

Oracle can reclaim Always Free servers that sit nearly idle. Upgrading the account to Pay As You Go
stops that and still costs nothing while you stay within the free limits.

## 2. Open the web ports (Oracle console)

**Networking → Virtual cloud networks →** your VCN **→ Subnets →** the public subnet **→ Security
Lists → Default Security List → Add Ingress Rules**, twice:

| Source CIDR | IP protocol | Destination port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

(On AWS Lightsail: the instance's **Networking** tab, add HTTPS; HTTP is open already. On EC2: the
security group needs inbound 80 and 443.)

## 3. Point the domain at the server (Namecheap)

**Advanced DNS → Add New Record → A Record:** Host `leads`, Value = the server's public IP, TTL
Automatic, then the green check. If you added a `leads` CNAME for Fly earlier, delete it first.

## 4. Log in to the server (Windows PowerShell)

```powershell
ssh -i "$HOME\Downloads\ssh-key-YYYY-MM-DD.key" ubuntu@PUBLIC_IP
```

Use your key's real file name. If Windows says the key's permissions are too open, run this once and try
again:

```powershell
icacls "$HOME\Downloads\ssh-key-YYYY-MM-DD.key" /inheritance:r /grant:r "$($env:USERNAME):(R)"
```

## 5. Let the server read the GitHub repo

The repo is private, so give this server its own read-only key. On the server:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/github -N "" -C "bob-moses-leads server"
printf 'Host github.com\n  IdentityFile ~/.ssh/github\n' >> ~/.ssh/config
cat ~/.ssh/github.pub
```

Copy the line it prints. On GitHub: **sales_leads_load → Settings → Deploy keys → Add deploy key**,
paste it, leave "Allow write access" off, **Add key**.

## 6. Download the app and run the setup

```bash
sudo mkdir -p /opt/bob-moses-leads && sudo chown ubuntu: /opt/bob-moses-leads
git clone git@github.com:dylanreins-boop/sales_leads_load.git /opt/bob-moses-leads
sudo bash /opt/bob-moses-leads/deploy/oracle/setup.sh leads.bobmosescc.com
```

Type `yes` if git asks about GitHub's fingerprint. The setup asks for your admin name and password, then
installs Node.js 22, the app service and Caddy (the web server that gets the https certificate on its
own), opens ports 80/443, and sets up nightly backups. It ends with "Done. The app is running."

Open **https://leads.bobmosescc.com** and sign in, then add everyone else from the **Team** button.

## Day to day

| To… | Run on the server |
|---|---|
| Get the latest version | `bash /opt/bob-moses-leads/deploy/oracle/update.sh` |
| See what the app is doing | `journalctl -u bob-moses-leads -f` |
| Add email, Facebook or website keys | `sudo nano /etc/bob-moses-leads.env`, then `sudo systemctl restart bob-moses-leads` |
| Restart the app | `sudo systemctl restart bob-moses-leads` |
| Run a backup now (and see if it works) | `sudo bash /opt/bob-moses-leads/deploy/oracle/backup.sh` |

## Off-server backups (recommended)

Every night the server keeps a copy of the database for 14 days. To also keep copies **off** the server
(so nothing is lost if the server is), send them to a cloud bucket. On Lightsail that's about $1 a month.

1. **Lightsail console → Storage → Create bucket.** Pick the same region as your server (e.g. Oregon,
   `us-west-2`), the smallest plan, and a name like `bob-moses-leads-backups`.
2. Open the bucket → **Permissions → Access keys → Create access key.** Copy the **Access key ID** and
   the **Secret access key** (the secret is only shown once).
3. On the server:
   ```bash
   sudo bash /opt/bob-moses-leads/deploy/oracle/backup-setup.sh
   ```
   Enter the bucket name, the region (`us-west-2`), leave Endpoint blank, and paste the two keys. It runs a
   first backup right away.
4. In the app, **Team** shows the last off-server backup at the top (it turns red if one fails or a day
   is missed).

Each night it uploads the database (`db/leads-YYYY-MM-DD.db.gz`, kept 30 days) and any new photos and
signatures (`photos/`). Any S3-compatible service works too (AWS S3, Backblaze B2, Cloudflare R2: fill in
their Endpoint).

**Restoring:** download the newest `db/leads-….db.gz` from the bucket, then on the server:

```bash
gunzip leads-YYYY-MM-DD.db.gz
sudo systemctl stop bob-moses-leads
sudo cp leads-YYYY-MM-DD.db /var/lib/bob-moses-leads/leads.db && sudo chown leads: /var/lib/bob-moses-leads/leads.db
sudo rm -f /var/lib/bob-moses-leads/leads.db-wal /var/lib/bob-moses-leads/leads.db-shm
sudo systemctl start bob-moses-leads
```

**Where things live:** the database and photos are in `/var/lib/bob-moses-leads`, nightly backups (14
days) in `/var/backups/bob-moses-leads`, and settings in `/etc/bob-moses-leads.env`. Copy a backup off
the server now and then, e.g. from PowerShell:
`scp -i <key> ubuntu@PUBLIC_IP:/var/backups/bob-moses-leads/leads-YYYY-MM-DD.db .`
