import { distanceM, type Point } from './geo.ts';

/**
 * Single-linkage clusters of points within `radiusM`, seeded in input order.
 * `idOf` names each point, so a point joins exactly one cluster.
 */
export function clusterByDistance<T extends Point>(points: readonly T[], radiusM: number, idOf: (p: T) => string): T[][] {
    const clusters: T[][] = [];
    const assigned = new Set<string>();
    for (const seed of points) {
        if (assigned.has(idOf(seed))) continue;
        const cluster: T[] = [seed];
        assigned.add(idOf(seed));
        for (let i = 0; i < cluster.length; i++) {
            for (const other of points) {
                if (assigned.has(idOf(other))) continue;
                if (distanceM(cluster[i]!, other) <= radiusM) {
                    cluster.push(other);
                    assigned.add(idOf(other));
                }
            }
        }
        clusters.push(cluster);
    }
    return clusters;
}
