"""PoC: pfaedle's shapes against the straight stop-to-stop lines, as maps and numbers (poc/out)."""
import csv, json, math, os, sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

root = sys.argv[1]
src, out = os.path.join(root, 'gtfs-out'), os.path.join(root, 'out')
os.makedirs(out, exist_ok=True)
rd = lambda n: list(csv.DictReader(open(os.path.join(src, n), encoding='utf-8-sig')))
dist = lambda a, b: math.hypot((a[0] - b[0]) * 111320 * math.cos(math.radians(a[1])), (a[1] - b[1]) * 110540)
length = lambda pts: sum(dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))

routes = {r['route_id']: r for r in rd('routes.txt')}
trips = rd('trips.txt')
stops = {s['stop_id']: (float(s['stop_lon']), float(s['stop_lat'])) for s in rd('stops.txt')}
calls = {}
for st in rd('stop_times.txt'):
    calls.setdefault(st['trip_id'], []).append((int(st['stop_sequence']), stops[st['stop_id']]))
shapes = {}
for p in rd('shapes.txt'):
    shapes.setdefault(p['shape_id'], []).append((int(p['shape_pt_sequence']), (float(p['shape_pt_lon']), float(p['shape_pt_lat']))))
shapes = {k: [pt for _, pt in sorted(v)] for k, v in shapes.items()}

roads = []
with open(os.path.join(root, 'roads.geojsonseq'), encoding='utf-8') as f:
    for line in f:
        g = json.loads(line.lstrip('\x1e')).get('geometry') or {}
        if g.get('type') == 'LineString': roads.append(g['coordinates'])

colors = {'0': '#CF003D', '3': '#5E9E1F', '11': '#00829B', '2': '#004B90'}
features, lines = [], []
for t in trips:
    st = [pt for _, pt in sorted(calls.get(t['trip_id'], []))]
    sh = shapes.get(t.get('shape_id', ''), [])
    if len(st) < 2 or len(sh) < 2: lines.append(f"{t['trip_id']}: NO SHAPE"); continue
    ratio = length(sh) / max(length(st), 1)
    worst = max(min(dist(s, p) for p in sh) for s in st)
    r = routes[t['route_id']]
    lines.append(f"{r['route_short_name']:>4} {t['trip_id']:<22} stops {len(st):>3}  straight {length(st)/1000:6.1f} km  shape {length(sh)/1000:6.1f} km  ratio {ratio:4.2f}  farthest stop from shape {worst:5.0f} m")
    features.append({'type': 'Feature', 'properties': {'trip': t['trip_id'], 'line': r['route_short_name'], 'type': r['route_type']}, 'geometry': {'type': 'LineString', 'coordinates': sh}})
    t['_st'], t['_sh'] = st, sh

open(os.path.join(out, 'stats.txt'), 'w').write('\n'.join(lines) + '\n')
json.dump({'type': 'FeatureCollection', 'features': features}, open(os.path.join(out, 'shapes.geojson'), 'w'))

def draw(name, bbox, title):
    fig, ax = plt.subplots(figsize=(14, 14 * (bbox[3] - bbox[1]) / (bbox[2] - bbox[0]) / math.cos(math.radians(50.6))), dpi=110)
    for c in roads:
        if any(bbox[0] <= x <= bbox[2] and bbox[1] <= y <= bbox[3] for x, y in c[::5] or c):
            ax.plot([p[0] for p in c], [p[1] for p in c], color='#d8d8d8', lw=0.4, zorder=1)
    for t in trips:
        if '_sh' not in t: continue
        col = colors.get(routes[t['route_id']]['route_type'], '#888')
        ax.plot([p[0] for p in t['_st']], [p[1] for p in t['_st']], color='#ff4d4d', lw=0.6, ls='--', alpha=0.5, zorder=2)
        ax.plot([p[0] for p in t['_sh']], [p[1] for p in t['_sh']], color=col, lw=1.6, alpha=0.8, zorder=3)
        ax.scatter([p[0] for p in t['_st']], [p[1] for p in t['_st']], s=6, color='black', zorder=4)
    ax.set_xlim(bbox[0], bbox[2]); ax.set_ylim(bbox[1], bbox[3]); ax.set_aspect(1 / math.cos(math.radians(50.6)))
    ax.set_title(title + '  (colour: pfaedle shape, red dashed: straight stop-to-stop, dots: stops)'); ax.set_xticks([]); ax.set_yticks([])
    fig.savefig(os.path.join(out, name), bbox_inches='tight'); plt.close(fig)

draw('overview.png', (13.25, 50.30, 14.45, 50.85), 'DÚK sample lines')
draw('usti.png', (13.98, 50.635, 14.08, 50.685), 'Ústí nad Labem centre')
draw('usti-wide.png', (13.93, 50.60, 14.13, 50.72), 'Ústí nad Labem')
print('\n'.join(lines))
