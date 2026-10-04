> **决策记录。** 这份调研是为了回答「有没有不需要信用卡的永久免费云服务器」。
> 结论：**没有**——「永久免费 + 免信用卡 + 能跑 PyTorch 容器 + 一直在线」四者不可兼得。
> 因此项目提供两条路：有卡走 [deploy/README.md](../deploy/README.md)（Oracle Always Free），
> 没卡走 [deploy/alt-self-host-tunnel/](../deploy/alt-self-host-tunnel/README.md)（自己电脑 + Tailscale Funnel）。
> 下面是逐个官方页面的核对过程与出处，用作这个结论的依据。
# Free, card-free hosting for a persistent FastAPI + CPU-PyTorch service
**Date all sources checked: 2026-10-04.** Every claim below is from the vendor page linked next to it. Items I could not confirm on an official page are marked **NOT VERIFIED**.

## Target workload
~2.5 GB Docker image, Python 3.12 + CPU PyTorch + FastAPI, ~2 vCPU, 2–4 GB RAM, low traffic, must survive weeks near-idle, needs a stable public `https://` URL. Constraints: permanently free, **no credit/debit card at signup**.

## Headline answer

**No option satisfies all three constraints simultaneously.**

* Every permanent *always-on VM* free tier (Oracle Always Free, GCP e2-micro) requires a credit card at signup.
* Every card-free free tier is either a scale-to-zero container platform, too small for PyTorch (256–512 MB RAM), or time-limited.
* The only card-free way to run this workload permanently is **self-hosting on your own PC behind a free tunnel**, and of the free tunnels only **Tailscale Funnel** gives a stable `https://` hostname without a card.

**Explicit answer to "does ANY option give a permanent, always-on, card-free VM (not a scale-to-zero container platform)?"** → **No. None.** The two real permanent always-on VM offers both fail the card test (Oracle: card mandatory; GCP: billing account + card mandatory). Northflank's Sandbox tier advertises "Always-on-compute – no sleeping :)" with 2 free services, which is the closest structural fit, but its free-tier resource limits and card requirement are **NOT VERIFIED** (see notes).

## Comparison table

| Option | Card at signup? | Permanent? | Sleeps / scales to 0? | Free RAM/CPU/disk | Runs 2.5 GB Docker + PyTorch? | Stable public HTTPS? | Qualifies? |
|---|---|---|---|---|---|---|---|
| **Oracle Cloud Always Free** | **YES** (credit/debit; virtual/prepaid rejected) | **Yes**, "unlimited period of time" | No (real VM) — but **idle reclamation** after 7 days | A1 Arm: 2 OCPU + 12 GB; or 2× AMD micro 1 GB; 200 GB block; 10 TB egress/mo | **Yes** | Yes (public IPv4 + LB) | ❌ card |
| **Google Cloud** (Free Tier + Cloud Run) | **YES** — "you must provide a credit card or other payment method" | Free Tier "has no end date"; Free Trial 90 days/$300 | Cloud Run scales to zero (cold start) | e2-micro 1 GB, 30 GB disk, 1 GB egress/mo OR Cloud Run 180k vCPU-s + 360k GiB-s/mo | e2-micro: no (1 GB). Cloud Run: image OK but quota too small | Yes | ❌ card |
| **AWS** (new Free plan) | **NO** — "A payment method isn't required to sign up for most new customers" | **No** — Free plan credits expire **6 months** | n/a for the Free plan | Always Free = 30+ services, monthly limits only | **No** — no always-free container host | n/a | ❌ not permanent |
| **Microsoft Azure** free account | **YES** + phone — "provide a credit card or debit card and phone number" | No — $200 credit for **30 days**, some services 12 months; 65+ always-free services | Container Apps Consumption scales to zero | Container Apps always-free: 180k vCPU-s, 360k GiB-s, 2M req/mo (≈50 vCPU-h, ≈100 GiB-h) — not enough for always-on | Technically yes, quota-wise no | Yes | ❌ card + quota |
| **Hugging Face Spaces** | **YES in practice** — Docker Spaces now need PRO, and "You can only pay for the PRO subscription with a credit card" | Static Spaces yes; Docker/Gradio Spaces no | **Yes** — cpu-basic sleeps after **48 h** idle | cpu-basic: 2 vCPU / 16 GB / 50 GB ephemeral | Only on paid PRO | Yes (`*.hf.space`) | ❌ card (Docker tier) |
| **Render** free web service | **No** (card optional; without one they suspend instead of billing) | Yes (perpetual free plan) | **Yes** — spins down after **15 min** idle, ~1 min cold start | **0.1 CPU / 512 MB RAM** | **No** — 512 MB RAM | Yes | ❌ too small |
| **Koyeb** | **YES** — "$29 pre-authorization hold" + charged pro-rated Pro plan | Free service exists but signup defaults to Pro | n/a — never sleeps ("You will never be charged when using the free web Service") | **0.1 vCPU / 512 MB RAM / 2 GB SSD**, Frankfurt or Washington DC | **No** | Yes | ❌ card + too small |
| **Fly.io** | Card ends trial | **No** — "2 hours of machine runtime or 7 days of access" | Trial machines "automatically stop after running for 5 minutes" | Trial: 2 vCPU / 4 GB per machine | Only during trial | Yes | ❌ trial only |
| **Railway** | **No** card for Free plan | **No** — "30-day free trial with $5 credits, then $1 per month" | Yes | 1 vCPU / **0.5 GB RAM** / 0.5 GB volume after trial | **No** | Yes | ❌ credits + tiny |
| **Zeabur** | n/a | Free plan $0 but **no hosted compute** — only lets you manage "1 server you purchased and own elsewhere" | n/a | none included | **No** (bring your own server) | n/a | ❌ no compute |
| **Back4App Containers** | **NO** — "(no credit card required)" | Yes, $0/container/mo | **NOT VERIFIED** | **0.25 CPU / 256 MB RAM** / 100 GB transfer, USA only | **No** | Yes | ❌ too small |
| **Northflank** Sandbox | **NOT VERIFIED** | Sandbox tier is permanent | **"Always-on-compute – no sleeping :)"** | **NOT VERIFIED** (2 free services, 1 free DB, 2 free cron) | Unknown | Yes | ⚠️ worth probing |
| **Sevalla** | **NOT VERIFIED** ("Is a credit card required?" FAQ exists but not readable) | App hosting from **$5/mo**; only static sites are free | n/a | static: 1 GB/site, 100 GB bandwidth | **No** — apps are paid | n/a | ❌ |
| **Glitch** | — | **SHUT DOWN** — hosting ended July 2025 | — | — | — | — | ❌ dead |
| **Replit** free (Starter) | No | **No** — "This published link will automatically go down after 30 days" | Yes | n/a | **No** | Only 30 days | ❌ |
| **Deta Space** | — | **SHUT DOWN** — `deta.space` no longer resolves (Cloudflare 1016) | — | — | — | — | ❌ dead |
| **PythonAnywhere** Beginner (free) | **NOT VERIFIED** | Yes (free tier persists) | **Yes** — "Unused web apps will expire after 1 month" (was 3) | **512 MB disk**, 100 CPU-s/day, 1 web worker, 1 web app | **No** — 512 MB disk can't hold torch | Yes (`user.pythonanywhere.com`) | ❌ disk + monthly re-click |
| **GitHub Codespaces** | **No** — "If your account does not have a valid payment method on file, usage is blocked once you use up your quota" | Quota resets monthly, but **ToS forbids it** | **Yes** — 30 min default idle timeout, max 240 min; **12 h max lifetime** | Free personal: 120 core-h + 15 GB-month per month | Yes technically | Port-forward URL, not a durable service URL | ❌ ToS + 12 h cap |
| **Modal** | **YES** — "you must have a payment method on file in order to use Modal" | Monthly credit grant (amount **NOT VERIFIED**) | Scales to zero | n/a | Yes (custom images) | Yes | ❌ card |
| **Cloudflare Workers** | No | Yes | n/a | **128 MB memory, 10 ms CPU/invocation, 64 MiB bundle** | **No** — impossible | Yes | ❌ |
| **Cloudflare Containers** | No for Workers Free, but… | **No** — Containers **"Free: N/A"**, requires Workers Paid **$5/mo** | Container sleeps after timeout | Paid: 25 GiB-h + 375 vCPU-min/mo | Only on paid | Yes | ❌ paid |
| **Deno Deploy** | **NOT VERIFIED** | Free plan yes | **Yes** — "Idle apps automatically shut down after ~20–30 seconds" | 768 MB memory default, 10 h active CPU, 1M req/mo | **No** — JS/TS runtime, no Python/PyTorch | Yes (`*.deno.dev`) | ❌ |
| **Val Town** | **NOT VERIFIED** | Free plan yes | n/a | **1 min wall-clock per run**, no custom domains | **No** — JS/TS only | Not on free (no custom domains) | ❌ |
| **Cloudflare Tunnel (quick)** | No account, no card | Yes | n/a | n/a | n/a (tunnel) | **NO — "The hostname changes each time"** | ❌ unstable |
| **Cloudflare Tunnel (named)** | No card, but **account + a domain on Cloudflare required** | Yes | n/a | n/a | n/a | **Yes** | ⚠️ needs a domain |
| **Tailscale Funnel** | **No** | Yes — Personal plan "$0 Free forever" | n/a | n/a | n/a | **Yes — `https://<machine>.<tailnet>.ts.net`** | ✅ **best card-free fit** |
| **ngrok free** | **NOT VERIFIED** for the HTTP dev domain | Yes | No — "Free endpoints have no timeout" | 1 GB egress/mo, 20k req/mo, 3 endpoints | n/a | **Yes** — one auto-assigned stable dev domain | ⚠️ quota is tight |
| **localhost.run** | **No — "doesn't even require signup"** | Yes ("forever free") | n/a | "There is a speed limit" | n/a | **NO — "Domain names change regularly"** | ❌ unstable |
| **bore.pub** | No account | Yes | n/a | Public instance, no SLA | n/a | **NO — raw TCP `bore.pub:<port>`, random port** | ❌ not HTTPS/stable |

## Notes with exact wording

### Oracle Cloud Always Free — best permanent VM, but card is mandatory
Cards, quoted verbatim from <https://www.oracle.com/cloud/free/>:
> "Why do I need to provide credit or debit card information when I sign up for Oracle Cloud Free Tier? To provide free Oracle Cloud accounts to our valued customers, we need to ensure that you are who you say you are. We use your contact information and credit/debit card information for account setup and identity verification."

> "We accept credit cards and debit cards that function like credit cards. **We do not accept debit cards with a PIN or virtual, single-use, or prepaid cards.**"

→ **A virtual/prepaid card is explicitly rejected.** This is the answer to your specific question.

Permanence: Always Free services are "available for an unlimited period of time." Free specs (<https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm>):
* **Arm (VM.Standard.A1.Flex):** "the first 1,500 OCPU hours and 9,000 GB hours per month for free… For Always Free tenancies, this is equivalent to **2 OCPUs and 12 GB of memory**." Fully flexible; supports Docker fine.
* **AMD micro:** up to two VM.Standard.E2.1.Micro — **1/8 OCPU, 1 GB RAM** (too small alone).
* **200 GB** block volume; **10 TB/month** outbound data; 2 VCNs; one Flexible Load Balancer (10 Mbps); public IPv4 available.

Gotchas (all quoted from Oracle's own pages):
1. **Idle reclamation — the biggest risk for your use case.** "Idle Always Free compute instances may be reclaimed by Oracle. Oracle will deem virtual machine and bare metal compute instances as idle if, during a **7-day period**… CPU utilization for the 95th percentile is **less than 20%**; Network utilization is **less than 20%**; Memory utilization is **less than 20%** (applies to A1 shapes only)." A near-idle FastAPI service will very likely trip all three thresholds.
2. **"out of host capacity" errors** are officially acknowledged: "If you receive an 'out of host capacity' error when trying to create a Compute instance, this indicates a temporary lack of Always Free shapes in your home region."
3. "**Accounts left idle for 30 days or more may be deemed abandoned** and become eligible for suspension or termination."
4. "One Oracle Cloud Free Trial or Always Free account is permitted per person… Creating or attempting to create multiple free accounts is prohibited."
5. "Availability to Free Tier is subject to capacity limits."
6. Oracle "may periodically check the validity of your card, resulting in a temporary 'authorization' hold."
7. Always Free compute must be created in your **home region**; outbound TCP port 25 is blocked by default.

### Google Cloud — permanent free tier, but card required
From <https://cloud.google.com/free/docs/free-cloud-features>:
* "During the sign up, **you must provide a credit card or other payment method** that is valid for the period of the Free Trial."
* "**A Google Cloud billing account is required to access the Google Cloud Free Tier.**" → the card requirement gates the *Always Free* tier too, not just the trial.
* "The Free Tier **has no end date**, but Google reserves the right to change the offering… with 30 days' advance notice."
* Free Trial: $300 / 90 days; if you don't upgrade, "your Free Trial billing account will be closed and all of its associated projects and resources will be stopped", then permanently deleted after a 30-day grace period.
* **Compute Engine Free Tier:** "1 non-preemptible e2-micro VM instance per month" in `us-west1`, `us-central1`, or `us-east1`; 30 GB-months standard PD; **1 GB of outbound data transfer** from North America per month. e2-micro is 2 shared vCPU but only **1 GB RAM** — below your 2–4 GB need.
* **Cloud Run Free Tier (request-based billing):** 2 million requests, 360,000 GB-seconds memory, 180,000 vCPU-seconds, 1 GB egress from North America per month. Annualised that's ~50 vCPU-hours and ~100 GiB-hours/month — roughly 7% of what a 1 vCPU / 2 GB always-on service needs (≈730 vCPU-h, ≈1,460 GiB-h).
* Cloud Run scales to zero by design (cold start); **NOT VERIFIED** with a specific official cold-start figure for this image size.

### AWS — card-free signup, but the new-account plan is only 6 months
From <https://aws.amazon.com/free/free-tier-faqs/>:
* "**Q4. Does AWS require a payment method to sign up? No. A payment method isn't required to sign up for most new customers.** In some cases, we may request additional information, such as a payment method, to verify your identity."
* "The AWS Free Tier program allows new customers to build and experiment with AWS at no cost for **up to 6 months**. New customers receive up to $200 in AWS credits, $100 upon sign-up and up to $100 more…"
* "**Free Tier credits expire 6 months from the date you create your AWS account.**"
* "All customers, new and existing, can access over 30 services with always free offers. Services with an Always Free usage allow you to use the product for free up to specified limits **as long as you are an AWS customer**."
* From <https://aws.amazon.com/free/>: Free plan — "Access to all AWS services ✖ Limited to select services only"; "**Billed for the usage ✖ No charges incurred unless you upgrade to a Paid plan**". Always free is limited to 30+ services with monthly caps (none is a persistent container host).
* Note: the page references "the launch of the new sign-up experience in **October 2026**" — i.e. the Free plan/Paid plan split is brand new as of this month.

### Microsoft Azure — card + phone required, 30-day credit
From <https://azure.microsoft.com/en-us/free/free-account-faq/>:
* "Why do I need to provide a credit card or debit card and phone number? We use the **phone number and credit card or debit card for identity verification** to validate that account holders are real people and not bots. We don't charge your credit card or debit card anything when you sign up for Azure, but you may see a **one-dollar** (or equivalent) verification hold…"
* "Only credit cards are accepted in Hong Kong and Brazil."
* From <https://azure.microsoft.com/en-us/free/>: "$200 credit to use on Azure services within **30 days**"; "Free monthly amounts of 20+ popular services for **12 months** (new Azure customers only)"; "Free monthly amounts of **65+ always-free services**"; "During the signup verification process, there may be a temporary **$1 authorization** placed on your card."
* **Always-free Azure Container Apps:** "180,000 vCPU seconds, 360,000 GiB seconds, and 2 million requests" per month. Container Apps Consumption plan "can scale to zero, and you only pay for running apps" (<https://learn.microsoft.com/en-us/azure/container-apps/plans>). 180k vCPU-s = 50 vCPU-hours; 360k GiB-s = 100 GiB-hours → far short of always-on.
* **Always-free App Service:** "Up to 10 web or API apps with 1 GB storage and **1 hour per day**" — a daily CPU quota, plus **NOT VERIFIED** whether F1 supports custom domains/HTTPS (long-standing limitation, but I could not read it on an official page today).

### Hugging Face Spaces — the free Docker tier no longer exists
From the official docs source (<https://github.com/huggingface/hub-docs/blob/main/docs/hub/spaces-overview.md>):
> "Static Spaces are free for everyone. **Gradio and Docker Spaces run on compute and require a paid plan to create: PRO for personal accounts, Team or Enterprise for organizations.** Free personal accounts in good standing can still host up to 2 Gradio Spaces running on ZeroGPU."

Confirmed in <https://github.com/huggingface/hub-docs/blob/main/docs/hub/billing.md>: PRO includes the "Ability to create Gradio and Docker Spaces running on compute" and "**You can only pay for the PRO subscription with a credit card.**"

Still-true hardware facts if you pay: CPU Basic is **2 vCPU / 16 GB RAM / 50 GB ephemeral disk**; "Each Spaces environment is limited to 16GB RAM, 2 CPU cores and 50GB of (not persistent) disk space by default." Networking is restricted to ports 80, 443 and 8080.

Sleep, quoted: "If your Space runs on the default `cpu-basic` hardware, it will **go to sleep if inactive for more than a set time (currently, 48 hours)**. Anyone visiting your Space will restart it automatically." And: "**If you want your Space never to deactivate** or if you want to set a custom sleep time, **you need to upgrade to paid hardware.**"

Stable URL: yes — `SPACE_HOST` is e.g. `osanseviero-i-like-flan.hf.space`. Disk is ephemeral (lost on restart/stop).

### Render — genuinely card-free and perpetual, but only 0.1 CPU / 512 MB
From <https://render.com/docs/free> and its `.md` source:
* "**0.1 CPU / 512 MB RAM**" (`free` compute plan).
* "Render *spins down* a Free web service that goes **15 minutes** without receiving any inbound traffic… This process takes about **one minute**." (`/docs/faq.md` repeats: "take about a minute to spin back up".)
* "Render grants **750 Free instance hours** to each workspace per calendar month"; free instance hours reset monthly.
* "**Do not use them for production applications.**"
* "Render might restart a Free web service at any time."
* Card: not required. `render.com/docs/faq.md`: "If you haven't added a payment method and you would incur charges, Render instead disables your services for the duration of the current billing period." → card is optional, but no card means no ability to exceed free bandwidth/pipeline minutes.
* Gotcha: "Render may suspend a Free web service that initiates an uncommonly high volume of traffic over the public internet."
* **Disqualifier: 512 MB RAM cannot hold CPU PyTorch (torch wheel alone is ~200 MB compressed / ~800 MB+ installed, plus model + FastAPI).**

### Koyeb — free service still exists, but a card is mandatory and you get charged on signup
From <https://www.koyeb.com/docs/faqs/pricing>:
> "**Why does Koyeb require a credit card? We require a credit card to prevent fraud and abuse.** We verify the card you enter by placing a **$29 pre-authorization hold** and immediately canceling it."
> "**Am I charged when I enter my credit card? Yes.** Right after we place the $29 pre-authorization hold to verify your card, we also charge you the pro-rated amount for the plan you select. For instance, when signing up, the selected plan is Pro, so you will be charged the pro-rated amount for Pro…"
> "**Is there a free tier?** Each organization has access to: One **free** web Service in the Frankfurt or Washington, D.C. regions with **512MB of RAM, 0.1 vCPU, and 2GB of SSD**. One free PostgreSQL database limited to 5 hours of active time and 1GB of storage."
> "**You will never be charged when using the free web Service.**"
> "You must always have at least one valid form of payment associated with your account."

The free service does not sleep (a positive), but card + 512 MB RAM disqualify it. Koyeb also announced it is "joining Mistral AI" (banner on <https://www.koyeb.com/pricing>), which is a platform-continuity risk.

### Fly.io — trial only, and trial machines auto-stop
From <https://docs.fly.io/about/free-trial/>:
> "A free trial on Fly.io includes **2 hours of machine runtime or 7 days of access**, whichever comes first."
> "**Trial Machines are set to automatically stop after running for 5 minutes.**"
> "**adding a card ends the free trial** and your usage starts counting toward your bill from that point on."
* Legacy free allowances were sunset: "Fly.io has deprecated plans as of **October 7, 2024**, but is still honoring them for users who purchased them prior to that date" (<https://docs.fly.io/about/discontinued-plans/>). New signups get no free tier.

### Railway — no permanent free tier
From <https://railway.com/pricing>: Free plan "Start with a **30-day free trial with $5 credits, then $1 per month**"; after trial "Up to **1 vCPU / 0.5 GB RAM** per service", 0.5 GB volume, 5 projects → then 1, 5 services → then 3. 0.5 GB RAM is far too small for PyTorch. (You also asked whether a card is needed — the pricing page states "No credit card required" under the Free plan.)

### Zeabur / Back4App / Northflank / Sevalla
* **Zeabur** (<https://zeabur.com/pricing>): the Free plan ($0/mo) contains **no hosted compute**. Its only compute line is "Manageable own servers: 1 — Servers you purchased and own elsewhere (including devices connected via Wonder Mesh) — not bought from Zeabur". It's a control panel for servers you already own. Not a host.
* **Back4App Containers** (<https://www.back4app.com/pricing/container-as-a-service>): Free = $0/container/month, "0.25 CPU / **256 MB RAM** / 100 GB Transfer / Shared CPU… Custom Docker containers… USA Region". Card explicitly not needed — FAQ: "you can spin up your Dockerized software project at no charge (**no credit card required**)" and "Back4app Web Deployment has a Free tier (**no credit card required**)". **Sleep behaviour: NOT VERIFIED** (couldn't find an official statement). 256 MB RAM makes it unusable for PyTorch regardless.
* **Northflank** (<https://northflank.com/pricing>): the **Sandbox** tier is the most interesting structural fit I found — "**Always-on-compute – no sleeping :)**", "2× free services", "1× free database", "2× free cron jobs". Their paid compute table shows `nf-compute-200` = 2 vCPU / 4 GB at $48/mo, i.e. the platform can clearly run your image if you pay. **NOT VERIFIED:** the resource limits of the free Sandbox services, and whether a card is required at signup — their docs pages render only the sidebar to my fetcher, and `/free-tier` returns 404. **This is the one option worth manually probing.**
* **Sevalla** (<https://sevalla.com/pricing/>): application hosting starts at **$5/month** ("Free trial is available"); only **static site** hosting is free (1 GB/site, 100 GB bandwidth). There is a "Is a credit card required?" FAQ entry but the answer text is not in the served HTML — **NOT VERIFIED**.

### Glitch / Replit / Deta / PythonAnywhere
* **Glitch — shut down.** Official post "Until we meet again 👋", dated **July 23, 2025** (<https://blog.glitch.com/post/goodbye-glitch>): "Earlier this month our team began the very difficult work of **ending support for project hosting** on Glitch. That work has now mostly been completed." Users could download projects "until the beginning of 2026". Dead.
* **Replit free (Starter)** — does **not** keep a server always on. From <https://docs.replit.com/billing/plans/starter-plan>: "One free published app… **This published link will automatically go down after 30 days.**" Published apps also carry a "Made with Replit" badge. Autoscale deployment and additional apps require paid Core.
* **Deta Space — shut down.** `https://deta.space/` no longer resolves (Cloudflare **Error 1016 Origin DNS error**, observed 2026-10-04). Deta's cloud services are gone.
* **PythonAnywhere Beginner (free)** (<https://www.pythonanywhere.com/pricing/>): **512 MB** private file storage, **100 CPU-seconds/day**, 1 web app at `your-username.pythonanywhere.com`, 1 web worker, up to 2 consoles, **no SSH**, outbound internet restricted to "Specific sites via HTTP(S) only", no MySQL, no scheduled/always-on tasks. From <https://blog.pythonanywhere.com/221/>: "**Unused web apps will expire after 1 month, rather than 3 months**" as of January 2026, and "For new users, scheduled tasks and MySQL database access will now be in the Developer tier." The free tier persists, but you must log in and click to keep the app alive **monthly**, and **512 MB cannot hold a CPU PyTorch install**. Card requirement for the free tier: **NOT VERIFIED**.

### GitHub Codespaces — explicitly forbidden for this by ToS
* Free quota (<https://docs.github.com/en/billing/concepts/product-billing/github-codespaces>): GitHub Free personal accounts get **120 core-hours and 15 GB-month** per month. "**If your account does not have a valid payment method on file, usage is blocked once you use up your quota.**" → no card needed.
* Idle timeout (<https://docs.github.com/en/codespaces/setting-your-user-preferences/setting-your-timeout-period-for-github-codespaces>): default **30 minutes**, configurable **5–240 minutes**. "Regardless of your idle timeout setting, a codespace has a **maximum lifetime of 12 hours**."
* **ToS position** — quoted verbatim from <https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features> (Codespaces section): Codespaces should not be used for "…any activity that places a burden on our servers, where that burden is disproportionate to the benefits provided to users (for example, don't use Codespaces as a content delivery network, as part of a serverless application, or **to host any kind of production-facing application**); or any other activity unrelated to the development or testing of the software project associated with the repository."
* → Using a codespace as your extension's persistent backend is a **ToS violation**, and the 12-hour max lifetime makes it technically impossible anyway.
* (Interesting detail: GitHub's own docs note that *terminal output* from served requests resets the idle timer — "if you publish a web app on a port from a codespace and page requests generate output in a terminal on the codespace, then each time terminal output occurs the timeout will be reset" — but the 12-hour cap still kills it.)
* AWS's equivalent restriction is the same shape (Actions "should not be used for… any other activity unrelated to the production, testing, deployment, or publication of the software project").

### Modal — good fit technically, but card is mandatory
From <https://modal.com/docs/guide/billing>: "Note that **you must have a payment method on file in order to use Modal.** If you would like to remove your payment method and delete your Workspace, please contact support@modal.com."
* Modal supports custom container images (`modal.Image.from_registry` / Dockerfile) and can carry CPU PyTorch, and `@modal.fastapi_endpoint` gives a stable public HTTPS URL, scaling to zero when idle.
* **The exact free monthly credit amount is NOT VERIFIED** — <https://modal.com/pricing> is JS-rendered and I could not read a "$X/month free" figure from an official page today. Do not rely on the commonly cited $30/month figure without checking.

### Cloudflare — Workers can't, Containers are paid
* **Workers Free** (<https://developers.cloudflare.com/workers/platform/limits/>): **128 MB memory**, **10 ms CPU per invocation**, **64 MiB** uncompressed bundle, 100k requests/day. Running CPU PyTorch in a Worker is impossible — no native wheels, no filesystem, and the memory/CPU caps are orders of magnitude short.
* **Cloudflare Containers** (<https://developers.cloudflare.com/containers/platform/pricing/>): the pricing table row is unambiguous — **"Free | N/A | N/A | N/A"**, i.e. Containers are **not available on the free plan**; they require the **$5/month Workers Paid** plan. Instance types do go up to `standard-3` (2 vCPU / 8 GiB / 16 GB disk) and image size may equal instance disk space, so the *shape* fits — but it isn't free.
* Card at signup for the Cloudflare account itself: not required for the free plan (**NOT VERIFIED** with an explicit quote).
* **ToS** — from the Service-Specific Terms, CDN section (<https://www.cloudflare.com/service-specific-terms-application-services/>): "Unless you are an Enterprise customer, Cloudflare offers specific Paid Services (e.g., the Developer Platform, Images, and Stream) that you must use in order to serve video and other large files via the CDN. Cloudflare reserves the right to disable or limit your access to or use of the CDN… if you use or are suspected of using the CDN without such Paid Services to **serve video or a disproportionate percentage of pictures, audio files, or other large files**." → A JSON API for a browser extension is fine; don't push lots of images/video through it. There is **no clause prohibiting** using Cloudflare Tunnel to expose a self-hosted API.

### Deno Deploy / Val Town — cannot run PyTorch
* **Deno Deploy** (<https://deno.com/deploy/pricing>): Free plan $0/mo — 1M requests/mo, 20 GiB egress, **10 h active CPU**, 150 GiB-hr memory, 768 MB default memory, 10 GiB revision storage, 10 apps, 3-day log retention. "**Idle apps automatically shut down after ~20-30 seconds.**" It is a JavaScript/TypeScript runtime — **no Python, no PyTorch**. Card requirement: **NOT VERIFIED**.
* **Val Town** (<https://www.val.town/pricing>): Free plan $0 — "**1 min** wall clock time / run", "**No** custom domains", 100,000 runs/day, 3-day log retention. TypeScript/Deno only — **no Python/PyTorch**, and no custom domain on free. Card requirement: **NOT VERIFIED**.

### Self-hosting + free tunnel (the only card-free path that works)
| Tunnel | Card/account? | Stable URL? | Limits / gotchas |
|---|---|---|---|
| **Cloudflare Quick Tunnel** | "You do not need a Cloudflare account or domain." | **NO** — "**The hostname changes each time you create a Quick Tunnel.**" Also "The URL stops working when you stop the `cloudflared` process." | "no uptime guarantee"; "up to 200 in-flight requests… additional requests return a 429"; **"do not support Server-Sent Events (SSE)"**. Officially "for testing and development". |
| **Cloudflare Named Tunnel** | Account required; **no card** for the free plan | **YES** (`app.example.com` via CNAME to `<TUNNEL_ID>.cfargotunnel.com`) | Prerequisites, quoted: "A Cloudflare account" **and** "**A domain on Cloudflare (required to publish applications)**". So you need a domain (~$10/yr) — not free, but no card-style recurring commitment. Runs as a service (Windows: `cloudflared.exe service install <TOKEN>`). |
| **Tailscale Funnel** | **No card.** Personal plan: "**$0 Free forever**" | **YES** — stable hostname of the form `https://<machine-name>.<tailnet>.ts.net` | "Tailscale Funnel is **available for all plans**." "Tailscale Funnel is currently in **beta**." Personal plan limits: unlimited user devices, up to 6 users, up to 3 ACL groups, up to 50 tagged resources. Funnel creates "a unique Funnel URL" bound to the device, so it survives tunnel restarts as long as the machine name/tailnet don't change. Public HTTPS with automatic TLS. HTTPS must be enabled for the tailnet. |
| **ngrok free** | Account required; card required only for TCP addresses ("Random with credit card verification") — **NOT VERIFIED** whether the HTTP dev domain needs a card | **YES** — "The free plan includes **one automatically assigned dev domain** (for example, `your-assigned-name.ngrok-free.app`) **tied to your account**." | "**Free endpoints have no timeout—they can stay online indefinitely.**" But quotas are tight: **1 GB/month** data out, **20,000 HTTP requests/month**, 5,000 TCP connections/month, up to 3 online endpoints, 1 dev domain, 4,000 req/min, no TLS endpoints. Free tier shows an **interstitial page on HTML browser traffic** (API/programmatic access is unaffected; bypass with an `ngrok-skip-browser-warning` header). |
| **localhost.run** | **No** — "it doesn't even require signup for short-lived tunnels" | **NO** — "**Domain names change regularly.**" | "There is a speed limit." Both limits "are in place to prevent phishing sites". Stable/faster domains require a paid Custom Domain plan. Free domain can be made to "last longer" by signing up and adding an SSH key, but is still not stable. |
| **bore.pub** | **No account needed** | **NO** — README: expose your port "at `bore.pub:<PORT>`, where **the port number is assigned randomly**." `--port` can request a specific port but "the command will fail if this port is not available". | Raw **TCP only**, no TLS termination → no `https://` URL. No SLA, no published limits. |

## Practical recommendation

1. **If a card is truly impossible** → **self-host on your PC + Tailscale Funnel** (free forever, no card, stable `https://<machine>.<tailnet>.ts.net`, real 2 vCPU/2–4 GB because it's your own hardware). Caveats: your PC must stay awake and `tailscaled` must keep running; Funnel is in beta; keep the service bound to localhost and let Funnel handle TLS. Cloudflare Tunnel (named) is the more production-grade alternative if you're willing to buy a domain; Cloudflare Quick Tunnels are not viable (unstable hostname, no SSE, 429 at 200 in-flight requests).
2. **If you can supply a real credit card** (must not be virtual/prepaid for Oracle) → **Oracle Cloud Always Free Arm A1**, 2 OCPU / 12 GB / 200 GB, permanent, always-on, Docker + PyTorch easily. **Mitigate the idle-reclamation rule** (CPU <20%, network <20%, memory <20% over 7 days on A1 shapes) by keeping baseline CPU/memory above those thresholds — this is the single most likely way to lose the instance.
3. **Worth one manual check:** **Northflank Sandbox** — it's the only found platform that advertises "Always-on-compute – no sleeping :)" on a free tier with 2 free services. Verify its free resource limits and card policy directly at <https://app.northflank.com/signup> before dismissing it.
4. **Everything else fails** for this specific workload: too little RAM (Render 512 MB, Koyeb 512 MB, Back4App 256 MB, Railway 0.5 GB, GCP e2-micro 1 GB), expired (AWS 6 months, Azure 30/365 days, Fly 7 days, Railway 30 days, Replit 30 days), paid-only (HF Docker Spaces via PRO, Cloudflare Containers via $5/mo), impossible (Workers 128 MB/10 ms, Deno/Val Town JS-only), forbidden (Codespaces ToS), or dead (Glitch, Deta Space).

## Things I could NOT verify from an official source
* Northflank Sandbox free-tier resource limits and card policy.
* Modal's exact free monthly credit amount.
* Whether ngrok's free HTTP dev domain requires a card (only the TCP-address row mentions card verification).
* Whether Back4App Containers' free tier sleeps, and after how long.
* Sevalla's "Is a credit card required?" FAQ answer text.
* PythonAnywhere free-tier card requirement.
* Deno Deploy and Val Town card requirements.
* Whether Cloudflare's free account signup requires a card (no explicit statement found).
* Azure App Service F1's custom-domain/HTTPS limitation (widely reported, not read on an official page today).
* A specific official cold-start latency figure for Cloud Run with a ~2.5 GB image.
