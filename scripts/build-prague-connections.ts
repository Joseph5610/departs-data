import type AdmZip from 'adm-zip';
import type { LiveConnectionsFile, LiveContinuationRow, LiveTripConnections } from './lib/contract.ts';
import { fetchZip, readTable } from './lib/feed.ts';
import { getServiceDays, timeToOffsetMs } from './lib/time.ts';
import { readServiceDates } from './lib/calendar.ts';
import { readHeldConnections, tripStopKey } from './lib/connections.ts';
import { outputDir, writeJson } from './lib/emit.ts';
import { buildMetroExits, type MetroPattern } from './lib/pid-metro.ts';
import fs from 'node:fs';

/**
 * Prague (PID) connections from the official PID GTFS.
 *
 * Departures and trip stop times come live from Golemio, whose trip and stop ids are the GTFS ones,
 * so this only emits what Golemio lacks: held connections (`transfers.txt`) and through-running
 * between lines (`block_id`) as `connections.json`, and the nearest metro car to each exit as
 * `metro-exits.json`.
 */
const CONFIG = {
    CITY: 'prague',
    TIMEZONE: 'Europe/Prague',
    GTFS_URL: 'https://data.pid.cz/PID_GTFS.zip',
    /** Today and tomorrow, matching the window of the other networks. */
    DAY_OFFSETS: [0, 1],
    /** Connections held for less than this are planned only and not emitted. */
    MIN_CONNECTION_WAIT_S: 1,
    OUTPUT_FILE: 'connections.json',
    METRO_OUTPUT_FILE: 'metro-exits.json',
    /** GTFS `route_type` of the metro. */
    METRO_ROUTE_TYPE: '1',
    /** Abort threshold guarding against an empty or truncated upstream feed. */
    MIN_ACTIVE_TRIPS: 10000,
} as const;

const TABLES = {
    routes: { required: ['route_id', 'route_short_name', 'route_type'] },
    trips: { required: ['trip_id', 'route_id', 'service_id', 'trip_headsign'], optional: ['block_id'] },
    stopTimes: { required: ['trip_id', 'stop_id', 'stop_sequence', 'arrival_time', 'departure_time'] },
} as const;

interface Trip { route_id: string; service_id: string; headsign: string; block_id: string }

async function main(): Promise<void> {
    const zip: AdmZip = await fetchZip(CONFIG.GTFS_URL, 'GTFS_ZIP');

    const routes = new Map<string, { line: string; type: string }>();
    for (const r of readTable(zip, 'routes.txt', TABLES.routes)) routes.set(r.route_id, { line: r.route_short_name, type: r.route_type });

    const trips = new Map<string, Trip>();
    for (const t of readTable(zip, 'trips.txt', TABLES.trips)) {
        trips.set(t.trip_id, { route_id: t.route_id, service_id: t.service_id, headsign: t.trip_headsign, block_id: t.block_id ?? '' });
    }

    const days = getServiceDays(CONFIG.TIMEZONE, CONFIG.DAY_OFFSETS);
    const dayPos = new Map(days.map((d, i) => [d.str, i]));
    const serviceDates = readServiceDates(zip, days);
    const serviceFlags = new Map<string, number>();
    for (const [serviceId, dates] of serviceDates) {
        let flags = 0;
        for (const d of dates) flags |= 1 << dayPos.get(d.str)!;
        serviceFlags.set(serviceId, flags);
    }
    const flagsOf = (tripId: string): number => serviceFlags.get(trips.get(tripId)?.service_id ?? '') ?? 0;
    const isActive = (tripId: string): boolean => flagsOf(tripId) !== 0;

    let activeCount = 0;
    for (const tripId of trips.keys()) if (isActive(tripId)) activeCount++;
    console.log(`Found ${activeCount} active trips across ${days.map(d => d.str).join(', ')}`);
    if (activeCount < CONFIG.MIN_ACTIVE_TRIPS) throw new Error(`Safety Check Failed: only ${activeCount} active trips. Aborting to prevent data wipeout.`);

    const { outgoing, incoming } = readHeldConnections(zip, isActive, CONFIG.MIN_CONNECTION_WAIT_S);

    // --- STOP TIMES: only the times at connection stops and each through-running trip's first departure ---
    const times = new Map<string, { arrival: string; departure: string; seq: string }>();
    const firstDeparture = new Map<string, { seq: number; time: string }>();
    const metroStops = new Map<string, Array<[number, string]>>();
    for (const st of readTable(zip, 'stop_times.txt', TABLES.stopTimes)) {
        const route = routes.get(trips.get(st.trip_id)?.route_id ?? '');
        if (route?.type === CONFIG.METRO_ROUTE_TYPE) {
            let list = metroStops.get(st.trip_id);
            if (!list) { list = []; metroStops.set(st.trip_id, list); }
            list.push([Number(st.stop_sequence), st.stop_id]);
        }
        const key = tripStopKey(st.trip_id, st.stop_id);
        if (outgoing.has(key) || incoming.has(key)) {
            times.set(key, { arrival: st.arrival_time || st.departure_time, departure: st.departure_time || st.arrival_time, seq: st.stop_sequence });
        }
        if (trips.get(st.trip_id)?.block_id && isActive(st.trip_id)) {
            const seq = Number(st.stop_sequence);
            const prev = firstDeparture.get(st.trip_id);
            if (!prev || seq < prev.seq) firstDeparture.set(st.trip_id, { seq, time: st.departure_time });
        }
    }

    const out: Record<string, LiveTripConnections> = {};
    const entry = (tripId: string): LiveTripConnections => (out[tripId] ??= { d: flagsOf(tripId) });
    const lineOf = (tripId: string) => routes.get(trips.get(tripId)!.route_id) ?? { line: '?', type: '' };

    for (const list of outgoing.values()) {
        for (const c of list) {
            const departure = times.get(tripStopKey(c.toTrip, c.toStop))?.departure;
            const fromSeq = times.get(tripStopKey(c.fromTrip, c.fromStop))?.seq;
            if (!departure || !fromSeq) continue;
            const { line, type } = lineOf(c.toTrip);
            const bySequence = (entry(c.fromTrip).out ??= {});
            (bySequence[fromSeq] ??= []).push([c.toTrip, line, type, trips.get(c.toTrip)!.headsign, departure, c.minTransferS, c.maxWaitS, flagsOf(c.toTrip)]);
        }
    }
    for (const list of incoming.values()) {
        for (const c of list) {
            const arrival = times.get(tripStopKey(c.fromTrip, c.fromStop))?.arrival;
            if (!arrival) continue;
            const { line, type } = lineOf(c.fromTrip);
            const byStop = (entry(c.toTrip).in ??= {});
            (byStop[c.toStop] ??= []).push([c.fromTrip, line, type, arrival, c.minTransferS, c.maxWaitS, flagsOf(c.fromTrip)]);
        }
    }
    for (const trip of Object.values(out)) {
        for (const rows of Object.values(trip.out ?? {})) rows.sort((a, b) => timeToOffsetMs(a[4]) - timeToOffsetMs(b[4]));
        for (const rows of Object.values(trip.in ?? {})) rows.sort((a, b) => timeToOffsetMs(a[3]) - timeToOffsetMs(b[3]));
    }

    // --- THROUGH-RUNNING: PID sets block_id only where the vehicle continues with its passengers ---
    const blocks = new Map<string, string[]>();
    for (const tripId of firstDeparture.keys()) {
        const blockId = trips.get(tripId)!.block_id;
        let list = blocks.get(blockId);
        if (!list) { list = []; blocks.set(blockId, list); }
        list.push(tripId);
    }
    let continuations = 0;
    for (const list of blocks.values()) {
        list.sort((a, b) => timeToOffsetMs(firstDeparture.get(a)!.time) - timeToOffsetMs(firstDeparture.get(b)!.time));
        for (let i = 0; i < list.length - 1; i++) {
            const next = list[i + 1]!;
            const { line, type } = lineOf(next);
            const row: LiveContinuationRow = [next, line, type, trips.get(next)!.headsign, firstDeparture.get(next)!.time];
            entry(list[i]!).continues = row;
            continuations++;
        }
    }

    const file: LiveConnectionsFile = { days: days.map(d => d.str), trips: out };
    const dir = outputDir(CONFIG.CITY);
    fs.mkdirSync(dir, { recursive: true });
    const size = writeJson(dir, CONFIG.OUTPUT_FILE, file);
    console.log(`Wrote ${CONFIG.OUTPUT_FILE}: ${Object.keys(out).length} trips, ${continuations} continuations, ${(size / 1024).toFixed(0)}KB`);

    // --- METRO EXITS: one pattern per distinct stop sequence is enough ---
    const patterns = new Map<string, MetroPattern>();
    for (const [tripId, list] of metroStops) {
        list.sort((a, b) => a[0] - b[0]);
        const platforms = list.map(([, stopId]) => stopId);
        const line = lineOf(tripId).line;
        patterns.set(`${line}|${platforms.join(',')}`, { line, platforms });
    }
    const metro = buildMetroExits(zip, patterns.values());
    const metroSize = writeJson(dir, CONFIG.METRO_OUTPUT_FILE, metro);
    console.log(`Wrote ${CONFIG.METRO_OUTPUT_FILE}: ${Object.keys(metro.platforms).length} platforms, ${Object.keys(metro.keys).length} keys, ${(metroSize / 1024).toFixed(0)}KB`);
}

main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
