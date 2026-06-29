# Spec Matrix Builder

Extract and compare product specs across retailer PDPs, then generate a canonical spec list for your MongoDB database.

## How it works

1. Enter a product category (e.g. "coffee maker")
2. Paste one product page URL per retailer (same or similar product across each site)
3. The app fetches each page via Firecrawl, extracts specs using Claude, and builds a side-by-side matrix
4. The "Use this spec" column shows the best label and value to use in your database
5. Copy the JSON and hand it to your dev team

## Setup

### 1. Get your API keys

- **Firecrawl**: Sign up at [firecrawl.dev](https://firecrawl.dev) — ~$20/month, handles JS-rendered retail pages
- **Anthropic**: Get your key at [console.anthropic.com](https://console.anthropic.com)

### 2. Install dependencies

```bash
npm install
```

### 3. Set up environment variables

```bash
cp .env.example .env.local
```

Edit `.env.local` and add your keys:
```
FIRECRAWL_API_KEY=your_firecrawl_api_key_here
ANTHROPIC_API_KEY=your_anthropic_api_key_here
```

### 4. Run locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Deploy to Vercel

### Option A: Deploy from GitHub (recommended)

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → New Project → Import your repo
3. In the Vercel project settings, go to **Environment Variables** and add:
   - `FIRECRAWL_API_KEY`
   - `ANTHROPIC_API_KEY`
4. Deploy

### Option B: Deploy via Vercel CLI

```bash
npm i -g vercel
vercel
```

Then add your environment variables in the Vercel dashboard under Project Settings → Environment Variables.

## Notes

- Amazon URLs often get blocked even with Firecrawl — use Best Buy, Target, AJ Madison, Lowe's, Williams Sonoma, etc.
- For best results, use URLs for the same or very similar product across all retailers
- The app is stateless — no database, no auth. Outputs are copy-pasted to your dev team.

## Tech stack

- **Next.js 14** — frontend + API routes
- **Firecrawl** — scrapes JS-rendered retail PDPs
- **Claude (claude-sonnet-4-6)** — extracts specs from page content and builds the matrix
