export interface Point { lat: number; lon: number }

export const round6 = (x: number): number => Number(x.toFixed(6));

/** Great-circle distance in metres. */
export function distanceM(a: Point, b: Point): number {
    const toRad = (x: number) => x * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 6_371_000 * 2 * Math.asin(Math.sqrt(h));
}

/** Metres east/north of `origin`, for the short-range vector maths around a single stop. */
export function localXY(origin: Point, point: Point): { x: number; y: number } {
    return {
        x: (point.lon - origin.lon) * 111_320 * Math.cos(origin.lat * Math.PI / 180),
        y: (point.lat - origin.lat) * 110_540,
    };
}

/**
 * Spreads points sharing an exact position around a small circle so each marker stays tappable.
 * Returns one coordinate pair per input, in input order; points that are alone keep their position.
 */
export function fanOutColocated(points: readonly Point[], offsetDeg: number): [number, number][] {
    const stacks = new Map<string, number[]>();
    points.forEach((p, i) => {
        const key = `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`;
        const stack = stacks.get(key);
        if (stack) stack.push(i); else stacks.set(key, [i]);
    });

    const out: [number, number][] = points.map(p => [p.lon, p.lat]);
    for (const stack of stacks.values()) {
        if (stack.length <= 1) continue;
        stack.forEach((pointIndex, idx) => {
            const p = points[pointIndex]!;
            const angle = (2 * Math.PI * idx) / stack.length;
            out[pointIndex] = [
                round6(p.lon + offsetDeg * Math.cos(angle)),
                round6(p.lat + offsetDeg * Math.sin(angle)),
            ];
        });
    }
    return out;
}
