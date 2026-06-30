# Spec Matrix Builder

Extract and compare product specs across retailer PDPs, then generate a canonical
spec list for your MongoDB database.

## How it works

1. Enter a product category (e.g. "coffee maker")
2. Paste one product page URL per retailer (same or similar product)
3. The app fetches each page via **Zyte** (handles bot protection automatically)
   and extracts all specs using Zyte's built-in AI product extraction
4. Claude organizes the specs into a grouped comparison matrix
5. Review the table, then copy the JSON/CSV for your dev team

## Why Zyte instead of Firecrawl

Firecrawl is excellent for crawling open content (docs, blogs) but ranks last
among all providers for protected retail sites in Proxyway's 2025 independent
benchmark. Best Buy uses DataDome, Target uses Akamai Bot Manager — both
block Firecrawl reliably. Zyte ranked #1 with a 93.14% success rate across
15 heavily protected sites including major US retailers.

## Setup

### 1. Get your API keys

**Zyte** (required for scraping):
- Sign up at https://app.zyte.com
- Free trial: $5 credit, no commitment
- Pay-as-you-go: from $1.01 per 1,000 browser requests

**Anthropic** (required for matrix building):
- Get your key at https://console.anthropic.com

### 2. Install

```bash
npm install
```

### 3. Configure

```bash
cp .env.example .env.local
# Edit .env.local and add your ZYTE_API_KEY and ANTHROPIC_API_KEY
```

### 4. Run locally

```bash
npm run dev
# Open http://localhost:3000
```

## Deploy to Vercel

1. Push to GitHub
2. Import the repo in vercel.com → New Project
3. Add environment variables in Vercel project settings:
   - `ZYTE_API_KEY`
   - `ANTHROPIC_API_KEY`
4. Deploy

## Notes

- Amazon URLs may still fail (they have the most aggressive bot protection of
  any retailer). For Amazon specifically, Bright Data is the most reliable
  option and has a free trial.
- For best results, use individual product page URLs (not category/search pages)
  for the same or very similar product across all retailers.
- The app is stateless — outputs are copy-pasted to your dev team, no database.
