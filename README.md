# Departs App - Static Data & GTFS Processing

This repository serves as the static data backend and CDN for [departs.app](https://departs.app), a real-time public transport departure board application for Prague (PID) and Brno (IDS JMK).

By leveraging **GitHub Actions** and **GitHub Pages**, this repository continuously fetches, processes, and hosts static transit data, offloading heavy processing and large files from the main application's frontend and Cloudflare Workers.

The data generated here is served publicly via `https://data.departs.app`.

## 🏗 Repository Structure

To maintain a clean and scalable pipeline, the repository is strictly divided into executable scripts and static data outputs:

- `/scripts` - Contains Node.js scripts used to fetch and process data.
- `/brno` - Output directory containing chunked JSON files for the Brno network.
- `/prague` - Output directory containing enrichment JSON files for the Prague network.
- `/.github/workflows` - CI/CD pipelines that run the scripts on scheduled intervals.

## 🏙 City Data Pipelines

### 🇨🇿 Brno (IDS JMK)
*Script:* `scripts/build-brno.mjs` | *Action:* `update-brno.yml` (Runs every 8 hours)

The Brno transport authority (Kordis) provides a traditional GTFS `.zip` file. Because parsing millions of rows inside a Cloudflare Worker at runtime is impossible, we process it ahead of time:
1. Downloads the latest `gtfs.zip` (only if the ETag changed).
2. Parses `routes`, `stops`, `trips`, `calendar`, and `stop_times`.
3. Pre-calculates a rolling 48-hour window of all scheduled departures.
4. Chunks the massive datasets into tiny `[stop_id].json` and `[trip_id].json` files.

This allows the main app to fetch only the exact bytes it needs for a specific stop instantly.

### 🇨🇿 Prague (PID)
*Script:* `scripts/build-prague.mjs` | *Action:* `update-prague.yml` (Runs every 8 hours)

Unlike Brno, Prague provides excellent real-time APIs (Golemio). However, we need structural "enrichment" data (e.g., mapping platform IDs to specific Metro lines or parent stations) that isn't available in real-time payloads.
1. Fetches static stops definitions from the PID open data portal.
2. Formats and shrinks the data into a fast O(1) lookup map.
3. Generates `stops-enrichment.json` which is aggressively cached by the `departs-app` edge workers.

## 🚀 Local Development

To run the pipelines locally:

```bash
# Install dependencies
npm install

# Run Brno GTFS processing
node scripts/build-brno.mjs

# Run Prague enrichment sync
node scripts/build-prague.mjs
```

## 📄 License

This project is licensed under the MIT License. Data is sourced from the respective open-data portals of PID (Prague) and Kordis (Brno).
