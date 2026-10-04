import { CHUNKING, stopIndexShardId, type ParentChildMap, type StopIndexFile } from './contract.ts';

/** `stop_index/` shards from the parent-child map, one per shard id including empty ones, so no lookup 404s. */
export function buildStopIndex(parentChildMap: ParentChildMap): Map<string, StopIndexFile> {
    const shards = new Map<string, StopIndexFile>();
    for (let i = 0; i < CHUNKING.STOP_INDEX_SHARDS; i++) shards.set(String(i), {});
    for (const station in parentChildMap) {
        const platforms = parentChildMap[station]!;
        shards.get(stopIndexShardId(station))![station] = [null, ...platforms];
        for (const platform of platforms) shards.get(stopIndexShardId(platform))![platform] = [station];
    }
    return shards;
}
