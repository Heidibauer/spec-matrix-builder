# Spec Schema Builder

Enter a product category → get a structured list of the specs consumers care about most, grouped by category, prioritized by buying-decision importance.

## Setup

### 1. Get your Anthropic API key
Sign up at https://console.anthropic.com

### 2. Install
```bash
npm install
```

### 3. Configure
```bash
cp .env.example .env.local
# Add your ANTHROPIC_API_KEY to .env.local
```

### 4. Run locally
```bash
npm run dev
# Open http://localhost:3000
```

## Deploy to Vercel

1. Push this repo to GitHub
2. Import the repo at vercel.com → New Project
3. Add environment variable: `ANTHROPIC_API_KEY`
4. Deploy

## Output

For each product category you get:
- Specs grouped into logical categories (Capacity, Dimensions, Power, Materials, etc.)
- Each spec rated High / Medium / Low importance
- A one-liner explaining why that spec matters to a buyer
- Copy as CSV (for Excel) or JSON (for your dev team)
