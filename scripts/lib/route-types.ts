import type { RouteInfo } from './contract.ts';
import { routeOf, type RouteLookup } from './stops-file.ts';

/** The vehicle types the app and the Worker name a route by; the published files carry these, never GTFS codes. */
export type AppRouteType = 'metro' | 'train' | 'tram' | 'trolleybus' | 'bus' | 'ferry' | 'funicular' | 'unknown';

const NAMED = new Set<string>(['metro', 'train', 'tram', 'trolleybus', 'bus', 'ferry', 'funicular']);

/** A GTFS `route_type` (basic 0-12 or extended 100-999) as an app type; mirrors the Worker's `normalizeRouteType` (departs-app `functions/_core/utils/routeTypes.ts`). */
export function appRouteType(code: string | number): AppRouteType {
    const text = String(code).toLowerCase();
    if (NAMED.has(text)) return text as AppRouteType;
    const n = Number(code);
    if (n >= 100 && n <= 199) return 'train';
    if (n >= 700 && n <= 799) return 'bus';
    if (n >= 800 && n <= 899) return 'trolleybus';
    if (n >= 900 && n <= 999) return 'tram';
    switch (n) {
        case 0: return 'tram';
        case 1: return 'metro';
        case 2: return 'train';
        case 3: return 'bus';
        case 4: return 'ferry';
        case 7: return 'funicular';
        case 11: return 'trolleybus';
        default: return 'unknown';
    }
}

/** `routes.json` as published: every route's type an app type. */
export function publishedRoutes(routes: RouteLookup): Record<string, RouteInfo> {
    const entries = routes instanceof Map ? [...routes.keys()] : Object.keys(routes);
    return Object.fromEntries(entries.map(id => {
        const route = routeOf(routes, id)!;
        return [id, { ...route, type: appRouteType(route.type) }];
    }));
}
