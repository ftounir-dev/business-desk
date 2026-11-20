# Business Desk: setup guide

Your own morning brief app for ITE Congo. It updates itself three times a day (08:15, 13:30 and 18:30 Brazzaville time) with live prices, news and a short summary of what matters for ITE. It's free to host, installs on your iPhone home screen, and keeps working offline with the last brief it loaded.

**You need:** a computer for about 15 minutes, a free GitHub account, and (optional, recommended) an AI key for the written summary.

---

## 1. Create your GitHub account and repository

1. Go to **github.com** and sign up (free).
2. Click **+** (top right), then **New repository**.
3. Name it `business-desk`. Choose **Public** (free hosting needs a public repository; it holds only public market data and news, never your calculator figures or alerts, which stay on your phone).
4. Click **Create repository**.

## 2. Upload the files

1. On the new repository page, click **uploading an existing file**.
2. Unzip `business-desk.zip` on your computer. Drag in everything from the unzipped folder: `index.html`, `manifest.webmanifest`, `sw.js`, `config.json`, `README.md`, and the folders `data`, `icons` and `scripts`.
3. Click **Commit changes**.

The `.github` folder is hidden on most computers, so add the schedule by hand:

4. Click **Add file → Create new file**.
5. In the name box type exactly: `.github/workflows/update.yml`
6. Open `update.yml` from the unzipped folder (`.github/workflows/update.yml`; on Mac press Cmd+Shift+. in Finder to show hidden folders), copy all of it and paste it into the editor.
7. Click **Commit changes**.

## 3. Let the schedule save its updates

1. Go to **Settings → Actions → General**.
2. Under **Workflow permissions**, choose **Read and write permissions**. Click **Save**.

## 4. Add the AI summary key (recommended)

Without a key, the app still updates prices and news, and writes a simple automatic summary. With a key, Claude writes the "Overnight in 60 seconds" section in English and French, focused on ITE.

1. Go to **console.anthropic.com**, sign up, add a small credit (for example $10), and create an **API key**.
2. In your repository: **Settings → Secrets and variables → Actions → New repository secret**.
3. Name: `ANTHROPIC_API_KEY`. Value: paste the key. Click **Add secret**.

Cost: one summary uses a few thousand words of input, so three runs a day typically come to a few dollars a month. To cut cost, delete two of the three `cron` lines in `update.yml` and keep the morning one.

Prefer OpenAI? Add a secret `OPENAI_API_KEY`, and under the **Variables** tab add `OPENAI_MODEL` with the model name from your OpenAI account.

## 5. Turn on the website

1. **Settings → Pages**.
2. Under **Build and deployment**, Source: **Deploy from a branch**. Branch: **main**, folder **/ (root)**. Click **Save**.
3. After a minute the page shows your address, like `https://YOUR-NAME.github.io/business-desk/`.

## 6. Run the first update now

1. Click the **Actions** tab. If asked, click **I understand my workflows, go ahead and enable them**.
2. Click **Update Business Desk → Run workflow → Run workflow**.
3. After about a minute it turns green. Open your address: the brief now shows today's live data.

## 7. Install on your iPhone

1. Open your address in **Safari**.
2. Tap **Share → Add to Home Screen → Add**.

It now opens full screen like an app and refreshes each time you open it.

---

## Everyday use

- **Change what's tracked:** edit `config.json` on GitHub (pencil icon). You can change news searches, markets (Yahoo Finance tickers), the BEAC rate after each meeting, and diary dates.
- **Force a refresh:** Actions → Update Business Desk → Run workflow.
- **If the brief says it's more than a day old:** open Actions and look for a red run; tap it to see why. GitHub can pause scheduled runs on repositories with no activity for 60 days and emails you if it does; click **Enable workflow** to restart.

## Where the data comes from

- Prices: Yahoo Finance daily closes (EUR/USD, Brent, sugar No.11, CBOT wheat, COMEX aluminium, gold, US 10-year, and Africa FX: Nigerian naira, Ghana cedi, Congolese franc). USD/XAF is calculated from the fixed 655.957 EUR/XAF peg. This is a free, unofficial feed; if a price stops updating, the app keeps the others and notes it in `data/brief.json` under `log`.
- News: Google News searches set in `config.json`, last 4 days, in this order: Worldwide, Africa (West and Central: Nigeria, Ghana, Côte d'Ivoire, Senegal, Cameroon, Gabon, DRC, UEMOA/BCEAO), Congo & CEMAC, Markets, Beverages & packaging, CFO & treasury, Lebanon. The first three appear on the Today page.
- PET resin and BEAC rates have no free daily feed: the BEAC rate is kept in `config.json`.

Prices are last closes and can lag by a day. Not trading advice.
