'use strict';

// ── Constants ────────────────────────────────────────────────
const TICK_MS         = 100;   // 10 Hz — matches gps-sdr-sim update rate
const EARTH_R         = 6371000;
const GH_ROUTE_BASE   = '/api/route';   // proxied through server.js (key stays server-side)
const GH_MAX_PTS      = 5;             // GraphHopper free-tier per-request waypoint limit
const ELEV_BASE       = '/api/elevation';   // proxied through server.js to avoid CORS
const MAX_ELEV_PTS    = 100;   // OpenTopoData public limit per request
const FETCH_DEBOUNCE  = 1000;  // ms to wait after last waypoint change before fetching

// ── State ────────────────────────────────────────────────────
let ws        = null;
let connected = false;

let waypoints    = [];   // { id, lat, lng, alt, marker }
let nextId       = 0;
let routeGeo     = [];   // [{ lat, lng }] decoded from OSRM — used for display & interpolation
let routeLine    = null;
let trkptLayer   = null;  // L.layerGroup holding CircleMarkers when Show trkpt is on
let posMarker    = null;   // playback cursor (JS-side)
let simMarker    = null;   // simulator feedback (C-side processed position)
let simLastLLH   = null;   // { lat, lon, alt } of last feedback — null when no valid fix

let routeProfile    = 'foot';
const profileSpeeds = { foot: 5, bike: 10, car: 40 };
let routingMode     = 'route';  // 'route' = GraphHopper API | 'raw' = straight-line interpolation
let ghCredits       = null;   // { limit, remaining, resetTs }
let fetchTimer      = null;
let fetchController = null;
let fetchingRoute   = false;
let retryTimer      = null;  // interval ID for GH rate-limit countdown

let playing   = false;
let paused    = false;
let progress  = 0;        // metres travelled along routeGeo so far
let direction  = 1;       // +1 forward, -1 backward (bounce mode)
let repeatMode = 'off';   // 'off' | 'bounce' | 'loop'
let loopsDone  = 0;       // count of completed loops for finite loop count
let ticker    = null;

let stopRemainingMs = 0;  // ms left in current random stop
let stopCheckpoints = [];  // { dist } for each intermediate waypoint along route

// ── DOM refs ─────────────────────────────────────────────────
const el = id => document.getElementById(id);
const statusDot    = el('status-dot');
const statusText   = el('status-text');
const btnConnect   = el('btn-connect');
const btnPlay      = el('btn-play');
const btnPause     = el('btn-pause');
const btnStop      = el('btn-stop');
const btnClear     = el('btn-clear');
const btnGpx       = el('btn-gpx');
const btnGpxLoad   = el('btn-gpx-load');
const gpxFileInput = el('gpx-file-input');
const inSpeed      = el('input-speed');
const inAlt        = el('input-alt');
const repeatGroup  = el('repeat-group');
const loopCountRow = el('loop-count-row');
const inLoopCount  = el('input-loop-count');
const inJitter     = el('input-jitter');
const inStopProb   = el('input-stop-prob');
const inStopMin    = el('input-stop-min');
const inStopMax    = el('input-stop-max');
const inStopTrkpt  = el('input-stop-trkpt');
const inShowTrkpt  = el('input-show-trkpt');
const modeGroup    = el('mode-group');
const routingGroup = el('routing-group');
const routeStatus  = el('route-status');
const wpCount      = el('wp-count');
const wpListEl     = el('wp-list');
const inWpLat      = el('input-wp-lat');
const inWpLng      = el('input-wp-lng');
const btnWpAdd     = el('btn-wp-add');
const infoDist     = el('info-dist');
const infoTime     = el('info-time');
const infoTrkpt    = el('info-trkpt');
const infoProg     = el('info-prog');
const infoPos      = el('info-pos');
const infoSimPos   = el('info-sim-pos');
const mapCoords    = el('map-coords');

// ── Map ──────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true }).setView([25.033, 121.564], 14);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a> contributors',
}).addTo(map);

map.on('click',       e => addWaypoint(e.latlng.lat, e.latlng.lng));
map.on('contextmenu', e => { L.DomEvent.preventDefault(e); openSimPosPrompt(e.latlng.lat, e.latlng.lng); });
map.on('mousemove',   e => {
    const { lat, lng } = e.latlng;
    mapCoords.textContent = `${lat.toFixed(6)},  ${lng.toFixed(6)}`;
});

// ── Geometry helpers ─────────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
    const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lng2 - lng1) * Math.PI / 180;
    const a  = Math.sin(Δφ/2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) ** 2;
    return 2 * EARTH_R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function segmentDistances(pts) {
    // Returns cumulative distance array of length pts.length (starts at 0)
    const cum = [0];
    for (let i = 1; i < pts.length; i++)
        cum.push(cum[i-1] + haversine(pts[i-1].lat, pts[i-1].lng, pts[i].lat, pts[i].lng));
    return cum;
}

function totalRouteDistance() {
    const pts = activePts();
    if (pts.length < 2) return 0;
    return segmentDistances(pts).at(-1);
}

// The point set used for display, distance and interpolation.
// Uses the OSRM road geometry when available, falls back to straight-line waypoints.
// In loop mode, appends the first waypoint at the end so the closing leg is included.
function activePts() {
    if (routeGeo.length >= 2) return routeGeo;
    const pts = waypoints.map(w => ({ lat: w.lat, lng: w.lng }));
    if (repeatMode === 'loop' && pts.length >= 2) pts.push({ ...pts[0] });
    return pts;
}

function interpolateAt(dist) {
    const pts = activePts();
    if (pts.length === 0) return null;
    if (pts.length === 1) return { lat: pts[0].lat, lng: pts[0].lng, alt: defaultAlt() };

    // Altitude: linearly interpolate between user waypoints by fraction along route
    const total = totalRouteDistance();
    const frac  = total > 0 ? Math.min(dist / total, 1) : 0;
    const alt   = interpolateAlt(frac);

    let rem = Math.max(0, dist);
    for (let i = 0; i < pts.length - 1; i++) {
        const d = haversine(pts[i].lat, pts[i].lng, pts[i+1].lat, pts[i+1].lng);
        if (rem <= d || i === pts.length - 2) {
            const t   = d > 0 ? Math.min(rem / d, 1) : 0;
            const a   = pts[i], b = pts[i + 1];
            // Use SRTM elevation stored on the geometry point when available
            const segAlt = (a.alt != null && b.alt != null)
                ? a.alt + t * (b.alt - a.alt)
                : alt;  // fallback: waypoint-interpolated altitude
            return {
                lat: a.lat + t * (b.lat - a.lat),
                lng: a.lng + t * (b.lng - a.lng),
                alt: segAlt,
            };
        }
        rem -= d;
    }
    const last = pts.at(-1);
    return { lat: last.lat, lng: last.lng, alt: last.alt ?? alt };
}

function interpolateAlt(frac) {
    // Spread altitude linearly across waypoints
    if (waypoints.length === 0) return defaultAlt();
    if (waypoints.length === 1) return waypoints[0].alt;
    const idx = frac * (waypoints.length - 1);
    const i   = Math.min(Math.floor(idx), waypoints.length - 2);
    const t   = idx - i;
    return waypoints[i].alt + t * (waypoints[i+1].alt - waypoints[i].alt);
}

// ── OSRM routing ─────────────────────────────────────────────
function scheduleRouteFetch() {
    // Cancel any active rate-limit countdown before starting a new fetch cycle
    clearInterval(retryTimer);
    retryTimer = null;
    // Abort any in-flight GH request immediately so it stops consuming API quota
    fetchController?.abort();
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(fetchRoute, FETCH_DEBOUNCE);
}

// Fetch one GraphHopper segment and return its geometry as [{lat,lng}].
// Also updates the credits panel from the response headers.
async function fetchSegment(wps, profile, signal) {
    const points = wps.map(w => `${w.lat.toFixed(6)},${w.lng.toFixed(6)}`).join(';');
    const url    = `${GH_ROUTE_BASE}?profile=${profile}&points=${encodeURIComponent(points)}`;
    const res    = await fetch(url, { signal });
    const data   = await res.json();

    const credLimit    = res.headers.get('x-ratelimit-limit');
    const credRem      = res.headers.get('x-ratelimit-remaining');
    const credResetSec = res.headers.get('x-ratelimit-reset');
    const credCost     = res.headers.get('x-ratelimit-credits');
    if (credLimit && credRem) {
        ghCredits = {
            limit:     +credLimit,
            remaining: +credRem,
            resetSec:  credResetSec ? +credResetSec : null,
            lastCost:  credCost     ? +credCost     : null,
        };
        updateCreditsPanel();
    }

    if (!data.paths?.[0]) throw new Error(data.message || 'No route found');
    return data.paths[0].points.coordinates.map(([lng, lat]) => ({ lat, lng }));
}

async function fetchRoute() {
    if (routingMode === 'raw') {
        routeGeo = [];
        redrawPolyline();
        const n = waypoints.length;
        setRouteStatus(n >= 2 ? 'ok' : '', n >= 2 ? `Straight-line · ${fmtDist(totalRouteDistance())}` : '');
        fetchingRoute = false;
        refreshUI();
        return;
    }
    if (waypoints.length < 2) {
        routeGeo = [];
        redrawPolyline();
        setRouteStatus('', '');
        refreshUI();
        return;
    }

    // Cancel any in-flight request and create a local controller for THIS call.
    // Using a local reference is critical: if a newer fetchRoute call aborts this one,
    // the finally block below must check OUR controller (already aborted), not the
    // global fetchController (which now belongs to the newer call and is still active).
    fetchController?.abort();
    const controller = new AbortController();
    fetchController  = controller;
    fetchingRoute    = true;

    // In loop mode, append the first waypoint at the end so the routing engine
    // returns geometry for the closing leg (last → first).
    const routeWps = repeatMode === 'loop' && waypoints.length >= 2
        ? [...waypoints, waypoints[0]]
        : waypoints;

    // Split waypoints into overlapping segments of GH_MAX_PTS.
    // Adjacent segments share one junction point so the joined geometry is continuous.
    const segments = [];
    for (let i = 0; i < routeWps.length - 1; i += GH_MAX_PTS - 1) {
        segments.push(routeWps.slice(i, i + GH_MAX_PTS));
    }
    const isSplit = segments.length > 1;

    try {
        let allCoords = [];
        for (let s = 0; s < segments.length; s++) {
            setRouteStatus('loading', isSplit
                ? `Calculating route (segment ${s + 1}/${segments.length})…`
                : 'Calculating route…');
            const coords = await fetchSegment(segments[s], routeProfile, controller.signal);
            // Drop the first point of subsequent segments — it duplicates the junction
            allCoords = s === 0 ? coords : allCoords.concat(coords.slice(1));
        }
        routeGeo = allCoords;

        // Fetch real terrain elevation for each point along the road
        try {
            setRouteStatus('loading', 'Fetching elevation data…');
            await enrichWithElevation(controller.signal);
            const alts   = routeGeo.map(p => p.alt).filter(a => a != null);
            const elvStr = alts.length
                ? ` · ${Math.round(Math.min(...alts))}–${Math.round(Math.max(...alts))} m`
                : '';
            const label = isSplit ? `Road route (${segments.length} segments)` : 'Road route';
            setRouteStatus('ok', `${label} · ${fmtDist(totalRouteDistance())}${elvStr}`);
        } catch (elevErr) {
            if (elevErr.name === 'AbortError') throw elevErr;
            const label = isSplit ? `Road route (${segments.length} segments)` : 'Road route';
            setRouteStatus('ok', `${label} · ${fmtDist(totalRouteDistance())} (no elevation data)`);
        }
    } catch (e) {
        if (e.name === 'AbortError') return;   // superseded by a newer fetch
        routeGeo = [];
        if (e.message?.toLowerCase().includes('limit')) {
            // GH minutely rate limit hit — show countdown and auto-retry
            let secs = 15;
            setRouteStatus('warn', `GH rate limit — retrying in ${secs}s…`);
            clearInterval(retryTimer);
            retryTimer = setInterval(() => {
                secs--;
                if (secs <= 0) {
                    clearInterval(retryTimer);
                    retryTimer = null;
                    scheduleRouteFetch();
                } else {
                    setRouteStatus('warn', `GH rate limit — retrying in ${secs}s…`);
                }
            }, 1000);
        } else {
            setRouteStatus('warn', 'Routing unavailable — using straight line');
        }
    } finally {
        // Only clean up if this specific call is still the active one (not aborted by a newer call)
        if (!controller.signal.aborted) {
            fetchingRoute   = false;
            fetchController = null;
            redrawPolyline();
            refreshUI();
        }
    }
}

function setRouteStatus(type, text) {
    routeStatus.textContent = text;
    routeStatus.className   = `route-status${type ? ' ' + type : ''}`;
}

// Queries OpenTopoData for elevations along routeGeo and stores them as pt.alt.
// Downsamples to MAX_ELEV_PTS, then interpolates back to every point.
async function enrichWithElevation(signal) {
    if (routeGeo.length < 2) return;

    // Evenly-spaced sample indices, always including the last point
    const step    = Math.max(1, Math.floor(routeGeo.length / MAX_ELEV_PTS));
    const indices = [];
    for (let i = 0; i < routeGeo.length; i += step) indices.push(i);
    if (indices.at(-1) !== routeGeo.length - 1) indices.push(routeGeo.length - 1);

    const locations = indices
        .map(i => `${routeGeo[i].lat.toFixed(6)},${routeGeo[i].lng.toFixed(6)}`)
        .join('|');

    const res  = await fetch(`${ELEV_BASE}?locations=${encodeURIComponent(locations)}`, { signal });
    const data = await res.json();
    if (!data.results) throw new Error(data.error || 'elevation API returned no results');

    const elevs = data.results.map(r => r.elevation ?? 0);

    // Interpolate sampled elevations back onto every routeGeo point
    routeGeo.forEach((pt, i) => {
        const pos = i / step;
        const lo  = Math.min(Math.floor(pos), elevs.length - 2);
        const t   = pos - lo;
        pt.alt    = elevs[lo] + t * (elevs[lo + 1] - elevs[lo]);
    });
}

// ── Credits panel ─────────────────────────────────────────────
function updateCreditsPanel() {
    if (!ghCredits) return;
    const panel = el('panel-credits');
    const bar   = el('credits-bar');
    const text  = el('credits-text');

    panel.style.display = '';
    const { limit, remaining, resetSec, lastCost } = ghCredits;
    const used = limit - remaining;
    const pct  = Math.min(used / limit * 100, 100);

    bar.style.width = `${pct}%`;
    bar.className   = `credits-bar${pct >= 90 ? ' danger' : pct >= 70 ? ' warn' : ''}`;

    let resetStr = '';
    if (resetSec != null) {
        const h = Math.floor(resetSec / 3600);
        const m = Math.floor((resetSec % 3600) / 60);
        resetStr = ` · resets in ${h}h ${m}m`;
    }
    const costStr = lastCost != null ? ` (last request: ${lastCost})` : '';
    text.textContent = `${remaining} / ${limit} remaining${costStr}${resetStr}`;
}

// ── GPX export ───────────────────────────────────────────────
// Parse a GPX file and replace the current waypoints with the points it defines.
// Prefers <wpt> elements (discrete named waypoints). If none exist, falls back
// to <trkpt> from the first <trkseg>. Loading many trkpts as waypoints is
// possible but will burn GraphHopper credits — confirm with the user first.
async function loadGPX(file) {
    let text;
    try { text = await file.text(); }
    catch (e) { setRouteStatus('error', `Cannot read file: ${e.message}`); return; }

    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) {
        setRouteStatus('error', 'Invalid GPX file (XML parse error)');
        return;
    }

    const readPts = (nodeList) => Array.from(nodeList).map(n => {
        const lat = parseFloat(n.getAttribute('lat'));
        const lon = parseFloat(n.getAttribute('lon'));
        const eleN = n.querySelector('ele');
        const alt  = eleN ? parseFloat(eleN.textContent) : null;
        return { lat, lng: lon, alt };
    }).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));

    let pts = readPts(doc.querySelectorAll('wpt'));
    let source = 'wpt';
    if (pts.length === 0) {
        pts = readPts(doc.querySelectorAll('trkpt'));
        source = 'trkpt';
    }
    if (pts.length < 2) {
        setRouteStatus('error', 'GPX contains no usable points');
        return;
    }

    // Warn before turning a dense trkpt list into individual GH waypoints
    if (source === 'trkpt' && pts.length > 25 && routingMode === 'route') {
        const ok = confirm(
            `This GPX has ${pts.length} track points and no waypoints. ` +
            `Loading each as a routed waypoint will use ${Math.ceil((pts.length - 1) / 4)} ` +
            `GraphHopper requests. Continue?`
        );
        if (!ok) return;
    }

    // Clear existing state without touching route status (we'll set it below)
    stopPlayback();
    clearTimeout(fetchTimer);
    clearInterval(retryTimer);
    retryTimer = null;
    fetchController?.abort();
    fetchingRoute = false;
    waypoints.forEach(w => w.marker.remove());
    waypoints = [];
    routeGeo  = [];
    if (routeLine)  { routeLine.remove();  routeLine  = null; }
    if (trkptLayer) { trkptLayer.remove(); trkptLayer = null; }
    if (posMarker)  { posMarker.remove();  posMarker  = null; }

    // Bulk-add without triggering N debounced fetches — one at the end
    for (const p of pts) addWaypoint(p.lat, p.lng, p.alt ?? defaultAlt());

    // Fit the map to the loaded set
    map.fitBounds(pts.map(p => [p.lat, p.lng]), { padding: [40, 40] });
    setRouteStatus('ok', `Loaded ${pts.length} ${source} from ${file.name}`);
}

function downloadGPX() {
    const pts = activePts();
    if (pts.length < 2) return;

    const trkpts = pts.map(p => {
        const ele = p.alt != null ? `\n        <ele>${p.alt.toFixed(1)}</ele>` : '';
        return `      <trkpt lat="${p.lat.toFixed(8)}" lon="${p.lng.toFixed(8)}">${ele}\n      </trkpt>`;
    }).join('\n');

    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GPS-SDR-SIM Route Planner"
     xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Route</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;

    const blob = new Blob([gpx], { type: 'application/gpx+xml' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = 'route.gpx';
    a.click();
    URL.revokeObjectURL(a.href);
}

// ── Formatting ────────────────────────────────────────────────
function fmtDist(m) { return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`; }
function fmtTime(s) {
    if (!isFinite(s) || s < 0) return '—';
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}m ${String(Math.floor(s % 60)).padStart(2, '0')}s` : `${Math.floor(s)}s`;
}
function fmtLL(lat, lng) { return `${lat.toFixed(6)},  ${lng.toFixed(6)}`; }

// ── Icons ─────────────────────────────────────────────────────
function makeWpIcon(num, cls = '') {
    return L.divIcon({
        className: '',
        html: `<div class="wp-pin${cls ? ' ' + cls : ''}">${num}</div>`,
        iconSize: [26, 26], iconAnchor: [13, 13],
    });
}

const posIcon = L.divIcon({
    className: '',
    html: '<div class="pos-pin"></div>',
    iconSize: [18, 18], iconAnchor: [9, 9],
});

const simIcon = L.divIcon({
    className: '',
    html: '<div class="sim-pin"></div>',
    iconSize: [14, 14], iconAnchor: [7, 7],
});

// ── Waypoints ─────────────────────────────────────────────────
function defaultAlt() { return parseFloat(inAlt.value) || 10; }

async function fetchWaypointElevation(wp) {
    try {
        const res  = await fetch(`${ELEV_BASE}?locations=${wp.lat.toFixed(6)},${wp.lng.toFixed(6)}`);
        const data = await res.json();
        if (data.results?.[0]?.elevation != null) {
            wp.alt = data.results[0].elevation;
            refreshUI();
        }
    } catch { /* keep fallback alt */ }
}

function addWaypoint(lat, lng, alt = defaultAlt()) {
    const id     = nextId++;
    const num    = waypoints.length + 1;
    const marker = L.marker([lat, lng], {
        icon: makeWpIcon(num, num === 1 ? 'start' : ''),
        draggable: true,
    }).addTo(map);

    const wp = { id, lat, lng, alt, marker };
    waypoints.push(wp);

    fetchWaypointElevation(wp);   // populate real SRTM elevation asynchronously

    marker.on('click',       e => L.DomEvent.stopPropagation(e));
    marker.on('contextmenu', e => { L.DomEvent.stopPropagation(e); removeWaypoint(id); });
    marker.on('dragend', () => {
        const ll = marker.getLatLng();
        wp.lat = ll.lat;
        wp.lng = ll.lng;
        fetchWaypointElevation(wp);  // re-fetch elevation at new position
        routeGeo = [];               // invalidate cached road geometry
        scheduleRouteFetch();
    });

    renumberMarkers();
    scheduleRouteFetch();
}

function removeWaypoint(id) {
    const idx = waypoints.findIndex(w => w.id === id);
    if (idx < 0) return;
    waypoints[idx].marker.remove();
    waypoints.splice(idx, 1);
    routeGeo = [];
    renumberMarkers();
    scheduleRouteFetch();
}

function renumberMarkers() {
    const last = waypoints.length - 1;
    waypoints.forEach((w, i) => {
        const cls = i === 0 ? 'start' : i === last ? 'end' : '';
        w.marker.setIcon(makeWpIcon(i + 1, cls));
    });
}

function redrawPolyline() {
    if (routeLine)  { routeLine.remove();  routeLine  = null; }
    if (trkptLayer) { trkptLayer.remove(); trkptLayer = null; }

    const pts = activePts();
    if (pts.length >= 2) {
        routeLine = L.polyline(pts.map(p => [p.lat, p.lng]), {
            color: '#4a9eff', weight: 3, opacity: 0.85,
        }).addTo(map);
    }

    // Draw a bright yellow dot at each routed trkpt when the toggle is on.
    // Yellow contrasts sharply with the blue route line so every point stands out.
    if (inShowTrkpt.checked && routeGeo.length >= 2) {
        trkptLayer = L.layerGroup(routeGeo.map(p => L.circleMarker([p.lat, p.lng], {
            radius: 5, weight: 2, color: '#1a1d26', fillColor: '#ffd400',
            fillOpacity: 1, interactive: false,
        }))).addTo(map);
    }
}

function clearRoute() {
    stopPlayback();
    clearTimeout(fetchTimer);
    clearInterval(retryTimer);
    retryTimer = null;
    fetchController?.abort();
    fetchingRoute = false;
    waypoints.forEach(w => w.marker.remove());
    waypoints = [];
    routeGeo  = [];
    if (routeLine)  { routeLine.remove();  routeLine  = null; }
    if (trkptLayer) { trkptLayer.remove(); trkptLayer = null; }
    if (posMarker)  { posMarker.remove();  posMarker  = null; }
    setRouteStatus('', '');
    refreshUI();
}

// ── UI refresh ────────────────────────────────────────────────
function refreshUI() {
    const n     = waypoints.length;
    const total = totalRouteDistance();
    const spd   = (parseFloat(inSpeed.value) || 30) / 3.6;

    // Waypoint list
    wpCount.textContent = n;
    wpListEl.innerHTML  = '';
    waypoints.forEach((wp, i) => {
        const row = document.createElement('div');
        row.className = 'wp-item';
        row.innerHTML = `
          <div class="wp-num">${i + 1}</div>
          <div class="wp-info">
            <span class="wp-ll">${fmtLL(wp.lat, wp.lng)}</span>
            <span class="wp-alt">${wp.alt.toFixed(1)} m</span>
          </div>
          <button class="wp-del" title="Remove waypoint">✕</button>`;
        row.querySelector('.wp-del').addEventListener('click', e => {
            e.stopPropagation();
            removeWaypoint(wp.id);
        });
        row.addEventListener('click', () => map.panTo([wp.lat, wp.lng]));
        wpListEl.appendChild(row);
    });

    // Route info — scaled by the total number of traversals for repeat modes:
    //   loop   : one loop  = one traversal (start→end)      → n × total
    //   bounce : one loop  = two traversals (start→end→start) → 2n × total
    const loopN     = parseInt(inLoopCount.value, 10);
    const finiteN   = Number.isFinite(loopN) && loopN > 0 ? loopN : null;
    const perLoop   = repeatMode === 'bounce' ? 2 : 1;
    const scaled    = repeatMode !== 'off' && finiteN != null
        ? total * perLoop * finiteN : null;
    const infinite  = repeatMode !== 'off' && finiteN == null;

    if (fetchingRoute) {
        infoDist.textContent = '…';
        infoTime.textContent = '…';
    } else if (n < 2) {
        infoDist.textContent = '—';
        infoTime.textContent = '—';
    } else if (infinite) {
        infoDist.textContent = '∞';
        infoTime.textContent = '∞';
    } else if (scaled != null) {
        infoDist.textContent = `${fmtDist(scaled)} (${finiteN}×)`;
        infoTime.textContent = spd > 0 ? fmtTime(scaled / spd) : '—';
    } else {
        infoDist.textContent = fmtDist(total);
        infoTime.textContent = spd > 0 ? fmtTime(total / spd) : '—';
    }

    // Track-point count from the routed geometry — only meaningful in route mode
    infoTrkpt.textContent = routeGeo.length >= 2 ? String(routeGeo.length) : '—';

    if ((playing || paused) && total > 0) {
        infoProg.textContent = `${Math.min(progress / total * 100, 100).toFixed(1)}%`;
        const p = interpolateAt(progress);
        if (p) infoPos.textContent = fmtLL(p.lat, p.lng);
    } else {
        infoProg.textContent = '—';
        infoPos.textContent  = '—';
    }

    // GPX button
    btnGpx.disabled = activePts().length < 2;

    // Playback buttons
    const canStart = connected && n >= 2 && !fetchingRoute;
    btnPlay.disabled    = !canStart || playing;
    btnPlay.textContent = paused ? '▶ Resume' : '▶ Play';
    btnPause.disabled   = !playing;
    btnStop.disabled    = !playing && !paused;
}

// ── WebSocket / TCP bridge ────────────────────────────────────
function connectWS() {
    if (ws) return;
    ws = new WebSocket(`ws://${location.host}`);
    ws.addEventListener('open',    () => ws.send(JSON.stringify({ type: 'connect' })));
    ws.addEventListener('message', e => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'status')   onConnectionChange(msg.connected);
        if (msg.type === 'error')    showError(msg.message);
        if (msg.type === 'feedback') onSimFeedback(msg.lat, msg.lon, msg.alt);
    });
    ws.addEventListener('close', () => { ws = null; onConnectionChange(false); });
    ws.addEventListener('error', () => { ws = null; onConnectionChange(false); });
}

function disconnectWS() {
    stopPlayback();
    ws?.send(JSON.stringify({ type: 'disconnect' }));
    ws?.close();
    ws = null;
    onConnectionChange(false);
}

function sendPosition(lat, lng, alt) {
    if (ws?.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'position', lat, lon: lng, alt }));
}

function onConnectionChange(state) {
    connected = state;
    statusDot.classList.toggle('connected', state);
    statusText.textContent = state ? 'Connected' : 'Disconnected';
    btnConnect.textContent = state ? 'Disconnect' : 'Connect to Simulator';
    btnConnect.className   = `btn ${state ? 'btn-danger' : 'btn-primary'} w-full`;
    if (!state) {
        stopPlayback();
        if (simMarker) { simMarker.remove(); simMarker = null; }
        infoSimPos.textContent = '—';
        infoSimPos.classList.remove('clickable');
        simLastLLH = null;
    }
    refreshUI();
}

function onSimFeedback(lat, lon, alt) {
    if (!simMarker) {
        simMarker = L.marker([lat, lon], { icon: simIcon, zIndexOffset: 900 }).addTo(map);
        simMarker.bindTooltip('', { permanent: false, direction: 'top', offset: [0, -8] });
    } else {
        simMarker.setLatLng([lat, lon]);
    }
    simMarker.setTooltipContent(`Sim: ${lat.toFixed(6)}, ${lon.toFixed(6)}<br>${alt.toFixed(1)} m`);
    simLastLLH = { lat, lon, alt };
    infoSimPos.textContent = `${fmtLL(lat, lon)}  ${alt.toFixed(1)} m`;
    infoSimPos.classList.add('clickable');
}

// ── Sim-position prompt (right-click on map) ──────────────────
let simPosPopup = null;

function simPosPopupHTML(lat, lng, alt, loading) {
    const disabled = loading || !connected ? 'disabled' : '';
    const altText  = loading ? 'Fetching elevation…' : `${alt.toFixed(1)} m`;
    const note     = !connected ? '<div class="spp-warn">Not connected to simulator</div>' : '';
    return `<div class="spp">
        <div class="spp-title">Set Sim Position</div>
        <div class="spp-coord">${lat.toFixed(6)}, ${lng.toFixed(6)}</div>
        <div class="spp-alt">${altText}</div>
        ${note}
        <div class="spp-btns">
            <button class="spp-send" ${disabled}
                onclick="confirmSimPos(${lat},${lng},${alt})">Send</button>
            <button class="spp-cancel" onclick="cancelSimPos()">Cancel</button>
        </div>
    </div>`;
}

async function openSimPosPrompt(lat, lng) {
    let alt = defaultAlt();
    if (simPosPopup) { simPosPopup.remove(); simPosPopup = null; }

    simPosPopup = L.popup({ closeButton: false, autoClose: false, closeOnClick: false, className: 'sim-pos-popup' })
        .setLatLng([lat, lng])
        .setContent(simPosPopupHTML(lat, lng, alt, true))
        .openOn(map);

    try {
        const res  = await fetch(`${ELEV_BASE}?locations=${lat.toFixed(6)},${lng.toFixed(6)}`);
        const data = await res.json();
        if (data.results?.[0]?.elevation != null) alt = data.results[0].elevation;
    } catch { /* keep fallback */ }

    if (simPosPopup) simPosPopup.setContent(simPosPopupHTML(lat, lng, alt, false));
}

window.confirmSimPos = function(lat, lng, alt) {
    sendPosition(lat, lng, alt);
    if (simPosPopup) { simPosPopup.remove(); simPosPopup = null; }
};

window.cancelSimPos = function() {
    if (simPosPopup) { simPosPopup.remove(); simPosPopup = null; }
};

function showError(message) {
    statusText.textContent = `Error: ${message}`;
}

// ── Playback ──────────────────────────────────────────────────
function computeStopCheckpoints() {
    // Distances-along-route where random stops can trigger.
    //   Default   : intermediate user waypoints only (matches the Python script).
    //   Trkpt on  : every point in the routeGeo (route mode only) — lets stops happen
    //               anywhere along the road, not only at named waypoints.
    if (waypoints.length < 2) return [];
    const cumDist = segmentDistances(activePts());

    // Trkpt mode: every route point is a candidate stop, skipping the very first
    // and last so we don't stall at start/end.
    if (inStopTrkpt.checked && routeGeo.length >= 2) {
        return cumDist.slice(1, -1).map(d => ({ dist: d }));
    }

    if (waypoints.length <= 2) return [];

    if (routeGeo.length >= 2) {
        // Project each intermediate waypoint onto the nearest routeGeo point
        return waypoints.slice(1, -1).map(wp => {
            let minD = Infinity, minIdx = 0;
            for (let j = 0; j < routeGeo.length; j++) {
                const d = haversine(wp.lat, wp.lng, routeGeo[j].lat, routeGeo[j].lng);
                if (d < minD) { minD = d; minIdx = j; }
            }
            return { dist: cumDist[minIdx] };
        });
    }
    // Straight-line fallback: use waypoint segment cumulative distances
    const wpCum = segmentDistances(waypoints.map(w => ({ lat: w.lat, lng: w.lng })));
    return wpCum.slice(1, -1).map(d => ({ dist: d }));
}

function startPlayback() {
    if (!connected || waypoints.length < 2 || fetchingRoute) return;
    playing = true;
    paused  = false;
    stopRemainingMs = 0;
    stopCheckpoints = computeStopCheckpoints();
    loopsDone = 0;

    if (!posMarker) {
        const p = interpolateAt(progress);
        if (p) posMarker = L.marker([p.lat, p.lng], { icon: posIcon, zIndexOffset: 1000 }).addTo(map);
    }

    clearInterval(ticker);
    ticker = setInterval(tickPlayback, TICK_MS);
    refreshUI();
}

function pausePlayback() {
    if (!playing) return;
    playing = false;
    paused  = true;
    clearInterval(ticker);
    refreshUI();
}

function stopPlayback() {
    playing         = false;
    paused          = false;
    progress        = 0;
    direction       = 1;
    stopRemainingMs = 0;
    loopsDone       = 0;
    clearInterval(ticker);
    if (posMarker) { posMarker.remove(); posMarker = null; }
    refreshUI();
}

function tickPlayback() {
    const total = totalRouteDistance();
    const spd   = (parseFloat(inSpeed.value) || 5) / 3.6;

    if (total === 0) { stopPlayback(); return; }

    // ── Random stop: hold position until timer expires ────
    if (stopRemainingMs > 0) {
        stopRemainingMs = Math.max(0, stopRemainingMs - TICK_MS);
        const pos = interpolateAt(progress);
        if (pos) {
            sendPosition(pos.lat, pos.lng, pos.alt);
            posMarker?.setLatLng([pos.lat, pos.lng]);
        }
        refreshUI();
        return;
    }

    // ── Speed jitter: ±fraction of base speed each tick ──
    const jitter = Math.max(0, Math.min(0.99, parseFloat(inJitter.value) || 0));
    const jitterFactor = jitter > 0 ? 1 + (Math.random() * 2 - 1) * jitter : 1;
    const effectiveSpd = spd * jitterFactor;

    const prevProgress = progress;
    progress += effectiveSpd * direction * (TICK_MS / 1000);

    // Random-stop parameters — computed once, used at both endpoints and intermediates
    const stopProb  = Math.max(0, Math.min(1, parseFloat(inStopProb.value) || 0));
    const stopMinMs = (parseFloat(inStopMin.value) || 0) * 1000;
    const stopMaxMs = Math.max(stopMinMs, (parseFloat(inStopMax.value) || 0) * 1000);
    const rollStop  = () => stopProb > 0 && Math.random() < stopProb
        ? stopMinMs + Math.random() * (stopMaxMs - stopMinMs) : 0;

    // ── Endpoint handling ─────────────────────────────────
    // A "loop" is one full return to the starting position:
    //   loop mode  : reaching the end and resetting to 0
    //   bounce mode: reaching the end then returning to 0 (out AND back)
    // In bounce/loop modes, endpoints (start on return, end always) are also
    // valid random-stop candidates. The initial launch at progress=0 is naturally
    // skipped because we only enter the progress<=0 branch after bouncing back.
    const loopLimit = parseInt(inLoopCount.value, 10);
    const hasLimit  = Number.isFinite(loopLimit) && loopLimit > 0;

    if (progress >= total) {
        progress = total;
        if (repeatMode === 'loop') {
            loopsDone++;
            if (hasLimit && loopsDone >= loopLimit) {
                sendPosition(waypoints[0].lat, waypoints[0].lng, waypoints[0].alt);
                posMarker?.setLatLng([waypoints[0].lat, waypoints[0].lng]);
                stopPlayback();
                return;
            }
            // Optional pause at end/start (same physical spot) before restarting the loop
            const ms = rollStop();
            if (ms > 0) { stopRemainingMs = ms; /* hold at progress=total this tick */ }
            else        { progress = 0; }
        } else if (repeatMode === 'bounce') {
            direction = -1;
            // Optional pause at the end waypoint before reversing
            const ms = rollStop();
            if (ms > 0) stopRemainingMs = ms;
        } else {
            const last = waypoints.at(-1);
            sendPosition(last.lat, last.lng, last.alt);
            posMarker?.setLatLng([last.lat, last.lng]);
            stopPlayback();
            return;
        }
    } else if (progress <= 0) {
        progress = 0;
        if (repeatMode === 'bounce' && direction === -1) {
            loopsDone++;
            if (hasLimit && loopsDone >= loopLimit) {
                sendPosition(waypoints[0].lat, waypoints[0].lng, waypoints[0].alt);
                posMarker?.setLatLng([waypoints[0].lat, waypoints[0].lng]);
                stopPlayback();
                return;
            }
            // Optional pause at the start waypoint before heading out again
            const ms = rollStop();
            if (ms > 0) stopRemainingMs = ms;
        }
        direction = 1;
    }

    // ── Random stop at intermediate waypoints ─────────────
    if (stopRemainingMs === 0 && stopProb > 0 && stopCheckpoints.length > 0) {
        for (const cp of stopCheckpoints) {
            const crossed = (prevProgress < cp.dist && progress >= cp.dist) ||
                            (prevProgress > cp.dist && progress <= cp.dist);
            if (crossed && Math.random() < stopProb) {
                progress = cp.dist;
                stopRemainingMs = stopMinMs + Math.random() * (stopMaxMs - stopMinMs);
                break;
            }
        }
    }

    const pos = interpolateAt(progress);
    if (!pos) return;

    sendPosition(pos.lat, pos.lng, pos.alt);
    posMarker?.setLatLng([pos.lat, pos.lng]);
    refreshUI();
}

// ── Events ────────────────────────────────────────────────────
btnConnect.addEventListener('click',  () => connected ? disconnectWS() : connectWS());
btnPlay.addEventListener(   'click',  startPlayback);
btnPause.addEventListener(  'click',  pausePlayback);
btnStop.addEventListener(   'click',  stopPlayback);
btnClear.addEventListener(  'click',  clearRoute);
btnGpx.addEventListener(    'click',  downloadGPX);
btnGpxLoad.addEventListener('click', () => { gpxFileInput.value = ''; gpxFileInput.click(); });
gpxFileInput.addEventListener('change', e => {
    const f = e.target.files?.[0];
    if (f) loadGPX(f);
});

// Manual waypoint entry: add a waypoint at the typed lat/lon, pan the map,
// and clear the inputs so the next entry starts fresh.
function submitManualWaypoint() {
    const lat = parseFloat(inWpLat.value);
    const lng = parseFloat(inWpLng.value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)
        || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        inWpLat.focus();
        return;
    }
    addWaypoint(lat, lng);
    map.panTo([lat, lng]);
    inWpLat.value = '';
    inWpLng.value = '';
    inWpLat.focus();
}
btnWpAdd.addEventListener('click', submitManualWaypoint);
[inWpLat, inWpLng].forEach(inp => {
    inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') submitManualWaypoint();
    });
    // Auto-split Google-Maps-style "lat, lng" paste into both fields
    inp.addEventListener('paste', e => {
        const text = e.clipboardData?.getData('text')?.trim();
        const m = text?.match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
        if (!m) return;
        e.preventDefault();
        inWpLat.value = m[1];
        inWpLng.value = m[2];
        inWpLng.focus();
    });
});
inSpeed.addEventListener(   'input',  refreshUI);
inStopTrkpt.addEventListener('change', () => {
    // Live toggle during playback: recompute the checkpoint list immediately
    if (playing || paused) stopCheckpoints = computeStopCheckpoints();
});
inShowTrkpt.addEventListener('change', redrawPolyline);
infoSimPos.addEventListener('click', () => {
    if (simLastLLH) map.panTo([simLastLLH.lat, simLastLLH.lon]);
});

modeGroup.addEventListener('click', e => {
    const btn = e.target.closest('.mode-btn');
    if (!btn) return;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    routeProfile = btn.dataset.profile;
    inSpeed.value = profileSpeeds[routeProfile] ?? inSpeed.value;
    if (waypoints.length >= 2) {
        routeGeo = [];
        scheduleRouteFetch();
    }
});

repeatGroup.addEventListener('click', e => {
    const btn = e.target.closest('.mode-btn');
    if (!btn) return;
    repeatGroup.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const prev  = repeatMode;
    repeatMode  = btn.dataset.repeat;
    loopCountRow.style.display = repeatMode === 'off' ? 'none' : '';
    // Loop mode requires a closing leg in the routing geometry — refetch when toggling to/from loop
    if (routingMode === 'route' && (prev === 'loop') !== (repeatMode === 'loop') && waypoints.length >= 2) {
        routeGeo = [];
        scheduleRouteFetch();
    } else {
        redrawPolyline();
        refreshUI();
    }
});

inLoopCount.addEventListener('input', refreshUI);

routingGroup.addEventListener('click', e => {
    const btn = e.target.closest('.mode-btn');
    if (!btn) return;
    routingGroup.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    routingMode = btn.dataset.routing;

    // Show/hide profile buttons and credits panel — only relevant in route mode
    const isRoute = routingMode === 'route';
    modeGroup.closest('.field-row').style.display = isRoute ? '' : 'none';
    el('panel-credits').style.display = isRoute && ghCredits ? '' : 'none';

    // Abort any in-flight route request when switching to raw
    if (!isRoute) { fetchController?.abort(); fetchingRoute = false; }

    clearTimeout(fetchTimer);
    routeGeo = [];
    scheduleRouteFetch();
});

// Auto-locate the user on load (blue dot + accuracy circle, like OSM).
// Skips silently if geolocation is unavailable or the user denies permission.
// Does not recenter if the user has already interacted with the map.
function autoLocateOnLoad() {
    if (!navigator.geolocation) return;

    let userMoved = false;
    const markMoved = () => { userMoved = true; };
    map.once('dragstart zoomstart click', markMoved);

    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const { latitude: lat, longitude: lng, accuracy } = pos.coords;
            const icon = L.divIcon({
                className: '', html: '<div class="geo-pin"></div>',
                iconSize: [14, 14], iconAnchor: [7, 7],
            });
            L.marker([lat, lng], { icon, interactive: false, keyboard: false }).addTo(map);
            L.circle([lat, lng], {
                radius: accuracy, color: '#4a9eff', weight: 1,
                fillColor: '#4a9eff', fillOpacity: 0.1, interactive: false,
            }).addTo(map);
            if (!userMoved) map.setView([lat, lng], 16);
        },
        () => { /* permission denied or timeout — stay on the default view */ },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
}

// Bootstrap
refreshUI();
autoLocateOnLoad();
