import fs from 'fs';
import { execSync } from 'child_process';

const oldJsonStr = execSync('git show e574746ab:brno/trip_routes.json').toString();
const newJsonStr = fs.readFileSync('brno/trip_routes.json', 'utf8');

const oldMap = JSON.parse(oldJsonStr);
const newMap = JSON.parse(newJsonStr);

let count = 0;
for (const [tripId, newRoute] of Object.entries(newMap)) {
    const oldRoute = oldMap[tripId];
    if (oldRoute && oldRoute !== newRoute) {
        console.log(`TripID ${tripId} changed from Route ${oldRoute} to Route ${newRoute}`);
        count++;
        if (count >= 10) break;
    }
}
if (count === 0) console.log("No differences found!");
