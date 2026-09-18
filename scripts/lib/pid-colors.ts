/**
 * PID line colours, ported from departs-app `functions/_adapters/golemio/services/vehicles/colors.ts`.
 * Keep the two in sync: the Worker still colours departures and vehicles with its copy.
 */
const VEHICLE_COLORS = {
    METRO_A: '#00A562',
    METRO_B: '#F8B322',
    METRO_C: '#CF003D',
    METRO_DEFAULT: '#AD0B00',
    TRAM: '#7A0603',
    BUS: '#007DA8',
    TROLLEYBUS: '#80166F',
    TRAIN: '#251E62',
    FERRY: '#00B3CB',
    FUNICULAR: '#B2B943',
    NIGHT: '#262050',
    SUBSTITUTE: '#FF4500',
    FALLBACK: '#5A5A5A'
} as const;

/**
 * Determines if a route is a night route based on its number.
 * Trams 90-99 and Buses 900+ are considered night routes.
 */
const isNightRoute = (routeName: string | number): boolean => {
    const nameStr = String(routeName);
    const nameNum = parseInt(nameStr, 10);
    if (isNaN(nameNum)) return false;

    // Trams 90-99 (Exactly 2 digits)
    if (nameStr.length === 2 && nameNum >= 90 && nameNum <= 99) return true;

    // Buses 900-999 (Exactly 3 digits)
    if (nameStr.length === 3 && nameNum >= 900 && nameNum <= 999) return true;

    return false;
};

/**
 * Returns a hex color string for a given route type and name.
 * Uses PID official branding colors for Metro, Trams, and Buses.
 */
export const getVehicleColor = (routeType: string | undefined, routeName: string | undefined): string => {
    const type = routeType ?? '';
    const nameStr = String(routeName ?? '');
    const nameUpper = nameStr.toUpperCase();

    // 0. Line-Specific Overrides (Funicular LD)
    if (nameUpper === 'LD' || nameUpper.startsWith('LD')) {
        return VEHICLE_COLORS.FUNICULAR;
    }

    // 1. Metro Specifics (Priority)
    if (type === 'metro') {
        switch (nameUpper) {
            case 'A': return VEHICLE_COLORS.METRO_A;
            case 'B': return VEHICLE_COLORS.METRO_B;
            case 'C': return VEHICLE_COLORS.METRO_C;
        }
    }

    // 2. Substitute Lines (Lines starting with X)
    if (nameUpper.startsWith('X')) {
        return VEHICLE_COLORS.SUBSTITUTE;
    }

    // 3. Night Routes (Trams 90-99, Buses 900+)
    if (isNightRoute(nameStr)) {
        return VEHICLE_COLORS.NIGHT;
    }

    // 4. Fallback by Type
    switch (type) {
        case 'tram':
            return VEHICLE_COLORS.TRAM;
        case 'metro':
            return VEHICLE_COLORS.METRO_DEFAULT;
        case 'trolleybus':
            return VEHICLE_COLORS.TROLLEYBUS;
        case 'bus':
            return VEHICLE_COLORS.BUS;
        case 'train':
            return VEHICLE_COLORS.TRAIN;
        case 'ferry':
            return VEHICLE_COLORS.FERRY;
        case 'funicular':
            return VEHICLE_COLORS.FUNICULAR;
        default:
            return VEHICLE_COLORS.FALLBACK;
    }
};

