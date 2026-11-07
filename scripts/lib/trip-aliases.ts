/** Trip id -> KORDIS run (`Linka/CVlaku`) of one timetable export. */
export type CourseGeneration = Record<string, string>;

/**
 * Each older export's trip ids mapped onto the current export's trip for the same run, newest export first.
 *
 * A generation's id that maps onto itself is left out: that reading is the current export's own. Ids are
 * recycled across exports, so the same id can redirect differently in each generation; the app decides per
 * feed snapshot which generation the realtime feed is on.
 */
export function aliasGenerations(older: readonly CourseGeneration[], currentByCourse: ReadonlyMap<string, string>): Array<Record<string, string>> {
    return older.map((generation) => {
        const aliases: Record<string, string> = {};
        for (const [tripId, course] of Object.entries(generation)) {
            const current = currentByCourse.get(course);
            if (current && current !== tripId) aliases[tripId] = current;
        }
        return aliases;
    });
}

/**
 * The generations folded into one table, the newest generation that redirects an id winning: the single
 * table departs-app read before it took one table per generation.
 */
export function mergedAliases(generations: ReadonlyArray<Record<string, string>>): Record<string, string> {
    const merged: Record<string, string> = {};
    for (const generation of generations) {
        for (const [tripId, current] of Object.entries(generation)) merged[tripId] ??= current;
    }
    return merged;
}
