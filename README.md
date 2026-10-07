# Departs App - Static Data & GTFS Processing

This repository serves as the static data backend and CDN for [departs.app](https://departs.app), a real-time public transport departure board application for Prague (PID), Brno (IDS JMK), Prešov (DPMP) and Ústecký kraj (DÚK).

By leveraging **GitHub Actions** and **GitHub Pages**, this repository continuously fetches, processes, and hosts static transit data, offloading heavy processing and large files from the main application's frontend and Cloudflare Workers.

The data generated here is served publicly via `https://data.departs.app`.

## 🏗 Repository Structure

Scripts and published data live on separate branches.

**`master`** — the pipeline:

- `/scripts` - TypeScript build scripts, run directly by Node (no build step).
- `/scripts/lib` - Shared pipeline code: chunk contract, service-day calendar, geometry, feed readers, output writers.
- `/.github/workflows` - CI/CD pipelines that run the scripts on scheduled intervals.

**`data`** — the published output, served at `https://data.departs.app` via GitHub Pages:

- `/brno`, `/prague`, `/presov`, `/duk` - Chunked JSON per network. Each has a `map-stops.json`: the final map stop list the app loads directly and `/api/<city>/stops` passes through unchanged.

The `data` branch holds a single commit, which each workflow amends and force-pushes. Don't commit
there by hand or branch from it.

## 🏙 City Data Pipelines

Every GTFS-stack city (Brno, Prešov, DÚK) publishes the same files through the shared writers in `scripts/lib`:
- `schedule/<HH>.json`: the trips a vehicle may be matched to in that hour, with their routes (`buildScheduleFiles`).
- `trip_buckets/<n>.json`: each trip's stops plus `$days` and `$trips` (window, day flags, route), and the days each onward connection runs (`buildTripBuckets`).
- `departure_buckets/`, `routes.json`, `parent_child_map.json`, `map-stops.json`.
- `stop_index/<n>.json`: each stop's station or platforms, so a departures request reads only the stops it names (`buildStopIndex`).
- `feed_index/`: lookups a single network's realtime feed needs (Brno `trip_alias_runs.json`, DÚK `station_names.json`).
- `rail_trips/<n>.json` (DÚK): trains by train number, with their stations and the Portabo platform each opens.

### 🇨🇿 Brno (IDS JMK)
*Script:* `scripts/build-brno.ts` | *Action:* `update-brno.yml` (Runs every 8 hours)

The Brno transport authority (Kordis) provides a traditional GTFS `.zip` file. Because parsing millions of rows inside a Cloudflare Worker at runtime is impossible, we process it ahead of time:
1. Downloads the latest `gtfs.zip` (only if the ETag changed).
2. Parses `routes`, `stops`, `trips`, `calendar`, and `stop_times`.
3. Pre-calculates a rolling 48-hour window of all scheduled departures.
4. Chunks the massive datasets into tiny `[stop_id].json` and `[trip_id].json` files.
5. Writes `map-stops.json`, the final stop list with stations as centroids (every GTFS city does this through `writeCityFiles`).

This allows the main app to fetch only the exact bytes it needs for a specific stop instantly.

### 🇨🇿 Prague (PID)
*Script:* `scripts/build-prague.ts` | *Action:* `update-prague.yml` (Runs daily)

Prague's departures, vehicles and trip times come live from Golemio, so this builds only what Golemio lacks, from one download of the PID GTFS:
1. Fetches the PID stop groups from the PID open data portal and enriches the GTFS stops with their lines and names, then groups platforms into stations and centroids and writes `map-stops.json`.
2. Writes `routes.json` and the route shapes (`trip_shape_buckets/`, `shape_buckets/`).
3. Writes held connections and through-running into `connection_buckets/`.

Points of sale are a separate weekly build (`scripts/build-prague-pos.ts`).

### 🇸🇰 Prešov (DPMP)
*Script:* `scripts/build-presov.ts` | *Action:* `update-presov.yml` (Runs daily)

DPMP publishes a monthly GTFS `.zip` via the Mesto Prešov ArcGIS portal. The output mirrors Brno's file set, with a few feed-specific steps:
1. Strips the monthly `feed_version` prefix from trip and service ids.
2. Synthesises parent stations by grouping same-named platforms, since the feed has none.
3. Derives request stops from the `*` stop-name suffix and injects official DPMP line colors.
4. Carries `direction_id` on each trip in `schedule/<HH>.json`, used to match the realtime CSV to trips.

### 🇨🇿 Ústecký kraj (DÚK)
*Script:* `scripts/build-duk.ts` | *Action:* `update-duk.yml` (Runs daily)

The kraj currently publishes no GTFS, so timetables come from the national CIS JŘ export in JDF: bus lines (`portal.cisjr.cz/pub/JDF/JDF.zip`) and urban rail, i.e. trolleybuses, trams and funiculars (`portal.cisjr.cz/pub/draha/mestske/JDF.zip`). The output mirrors Prešov's file set:
1. Keeps the kraj's lines: line numbers starting `51`, `52`, `55`–`59` (its licensing offices), tagged with the DÚK system code `30421` in `LinExt.txt`, or calling at any stop in one of its districts (PID and other cross-border lines).
2. Reads JDF 1.9, 1.10 and 1.11 layouts and evaluates the pevné/časové kódy (including Czech public holidays) for yesterday, today and tomorrow.
3. On each day applies only a line's most recently started timetables, since CIS files every change as a new timetable valid to the licence end; where those share a trip number, a detour wins.
4. Uses Portabo nodes (the ids the DÚK realtime feed reports) as stops, matched to JDF stops by name, since JDF has no coordinates or national stop ids. Bare names on city lines (JDF type A/B) are treated as streets of the line's town and only match near the rest of the line; matches forcing an implausible detour are rejected and the line re-resolved without them.
5. Names trips `<spoj>-<line>-<timetable>` so the app maps realtime `CISLineID` + `RouteID` onto them. No shapes are produced.
6. Emits one station (`centroid-<node>`) per Portabo node and one platform (`<node>-<post>`) per post, exactly as `GetStations` lists them, except the virtual post 999 where a node has real ones; posts on the exact same point are fanned out on a ~12 m circle as for Brno, and rail/ferry posts (90+) carry no platform number. Departures are not built per platform: the app takes them from Portabo's live board of each post. Departures chunks stay keyed by the bare node and carry the platform each trip is expected at.
7. Names lines by `LinExt` (X, XU28), a small override table (LD, MHD) or the last three digits, and colours Ústí city lines as DPmÚL does.
8. Draws each trip through an estimated platform per stop (right of the direction of travel), since JDF names only the stop.

Trains are published only as NeTEx (`ftp.cisjr.cz/netex/`) and are not built yet. Stops Portabo lacks or places at a placeholder position (most Most/Litvínov city stops) stay in trip timelines with an empty `stop_id` and no coordinates.

## 🚀 Local Development

To run the pipelines locally:

```bash
# Install dependencies
npm install

# Run Brno GTFS processing
npm run build:brno

# Run Prešov GTFS processing
npm run build:presov

# Run Ústecký kraj JDF processing
npm run build:duk

# Run Prague enrichment sync
npm run build:prague
```

## 📄 License

**Scripts** (`/scripts`, workflows): MIT License, see [LICENSE](LICENSE).

**Data** (`/brno`, `/duk`, `/prague`, `/presov`, served at `https://data.departs.app`): adapted from the sources below and published under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), except the Lissy route shapes and the DÚK train timetables (see below). When you reuse it, credit the original sources as listed and departs.app as the adapter, and state your own changes. The data are provided as is, without warranty; their providers do not endorse departs.app or this repository.

| Output | Source (credit) | Licence | Changes made here |
| --- | --- | --- | --- |
| `/prague` | [PID open data](https://pid.cz/o-systemu/opendata/), stop list (ROPID) | CC BY 4.0 | Stops reduced to an id → station, line and zone lookup (`stops-enrichment.json`). |
| `/brno` | [Jízdní řád IDS JMK ve formátu GTFS](https://data.brno.cz/datasets/379d2e9a7907460c8ca7fda1f3e84328) (Statutární město Brno, KORDIS JMK) | CC BY 4.0 | Filtered to a rolling 48-hour window, restructured into per-stop and per-trip JSON chunks, parent stations and platforms grouped. |
| `/brno` | Route shapes from the Lissy API (FIT VUT Brno); the [Lissy](https://github.com/Jorgen98/Lissy) tool itself is GPL-3.0 | Used and redistributed with the author's explicit permission; not covered by this repository's CC BY 4.0 | Attached to trips as simplified shapes. |
| `/presov` | [GTFS – MHD Prešov](https://www.arcgis.com/home/item.html?id=f1033ca6c2f4461d9aba285e1c7cb079) (Dopravný podnik mesta Prešov, a.s.) | CC BY 4.0 | Monthly id prefixes stripped, parent stations synthesised, request stops and line colours added, three-day window chunked to JSON. |
| `/duk` | [Jízdní řády veřejné linkové dopravy (CIS JŘ, JDF)](https://data.gov.cz/datová-sada?iri=https%3A%2F%2Fdata.gov.cz%2Fzdroj%2Fdatové-sady%2F66003008%2F1463646434) (Ministerstvo dopravy ČR) | [Open data without copyright or database rights](https://data.gov.cz/podmínky-užití/neobsahuje-autorská-díla/) (CC0 equivalent) | Filtered to the kraj's lines, calendars evaluated, stop names matched to Portabo nodes, trips placed on platforms, lines named and coloured; operator and other personal data are not carried over. |
| `/duk` | [Ústecký kraj open data (Portabo)](https://lkod.portabo.cz/datasets): stops (`cis/GetStations`) | [Open data without copyright or database rights](https://data.gov.cz/podmínky-užití/neobsahuje-autorská-díla/) | One station per node and one platform per post; platforms on the same point fanned out on the map. |
| `/duk` | [Spojenka – Data jízdních řádů](https://www.spojenka.cz/jrdata) (GTFS) | Free for non-commercial use only, without warranty, as its publisher states; not covered by this repository's CC BY 4.0 | Trains calling in the kraj on three days, keyed by train number, stations tied to the nearest Portabo platform (`rail_trips/`). |

The CC BY 4.0 sources require attribution and an indication of changes; the Czech open-data sources require neither, but are credited all the same. departs.app shows the same credits in its Settings, next to the realtime feeds it reads directly.
