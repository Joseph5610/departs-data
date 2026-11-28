import type { ParentChildMap } from './contract.ts';

/** The id a station is published under, from the feed's station id and its platforms' ids. */
export type StationIdRule = (feedId: string, platforms: readonly string[]) => string;

/**
 * Each station's published id: a key that survives the feed's re-exports, so links and favorites keep
 * working. The app and the Worker treat it as opaque.
 * Stations the rule maps onto one id (a renamed stop exported under both its old and new node) keep their feed ids.
 * Throws when two stations, or a station and a platform, would still share an id: both key a departure bucket's `$stations` and the app's stop list.
 */
export function stableStationIds(parentChildMap: ParentChildMap, rule: StationIdRule): Map<string, string> {
    const platformIds = new Set(Object.values(parentChildMap).flat());
    const ruled = new Map(Object.entries(parentChildMap).map(([feedId, platforms]) => [feedId, rule(feedId, platforms)]));
    const claims = new Map<string, number>();
    for (const id of ruled.values()) claims.set(id, (claims.get(id) ?? 0) + 1);
    const ids = new Map<string, string>();
    const owner = new Map<string, string>();
    for (const [feedId, ruledId] of ruled) {
        const id = claims.get(ruledId)! > 1 ? feedId : ruledId;
        const taken = owner.get(id) ?? (platformIds.has(id) ? `platform ${id}` : undefined);
        if (taken) throw new Error(`Station ${feedId} would be published as ${id}, already ${taken}`);
        owner.set(id, feedId);
        ids.set(feedId, id);
    }
    return ids;
}

/** The parent-child map under the published station ids. */
export function withStationIds(parentChildMap: ParentChildMap, ids: ReadonlyMap<string, string>): ParentChildMap {
    return Object.fromEntries(Object.entries(parentChildMap).map(([feedId, platforms]) => [ids.get(feedId) ?? feedId, platforms]));
}
