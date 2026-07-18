'use strict';

const express    = require('express');
const { WebSocketServer } = require('ws');
const net        = require('net');
const http       = require('http');
const https      = require('https');
const path       = require('path');

const HTTP_PORT  = 3000;
const GPS_HOST   = '127.0.0.1';
const GPS_PORT   = 6000;

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

let GH_KEY = '';
try { GH_KEY = require('./keys').graphhopper; } catch {}

// Proxy routing queries to GraphHopper (keeps API key server-side)
app.get('/api/route', (req, res) => {
    const { profile, points } = req.query;
    if (!points) return res.status(400).json({ error: 'missing points' });
    if (!GH_KEY)  return res.status(503).json({ error: 'no GraphHopper key configured' });

    const ptParams = points.split(';').map(p => `point=${encodeURIComponent(p)}`).join('&');
    const url = `https://graphhopper.com/api/1/route?${ptParams}&profile=${profile}&points_encoded=false&locale=en&key=${GH_KEY}`;

    https.get(url, { headers: { 'User-Agent': 'gps-sdr-sim-route-planner' } }, (upstream) => {
        let body = '';
        upstream.on('data', chunk => body += chunk);
        upstream.on('end', () => {
            // Forward GraphHopper rate-limit headers so the UI can show credit usage
            const rlHeaders = [
                'x-ratelimit-limit', 'x-ratelimit-remaining',
                'x-ratelimit-reset', 'x-ratelimit-credits',
            ];
            rlHeaders.forEach(h => { if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]); });
            try { res.json(JSON.parse(body)); }
            catch { res.status(502).json({ error: 'invalid response from routing API' }); }
        });
    }).on('error', e => res.status(502).json({ error: e.message }));
});

// Proxy elevation queries to OpenTopoData (avoids browser CORS restrictions)
app.get('/api/elevation', (req, res) => {
    const locations = req.query.locations;
    if (!locations) return res.status(400).json({ error: 'missing locations parameter' });

    const url = `https://api.opentopodata.org/v1/srtm30m?locations=${encodeURIComponent(locations)}`;

    https.get(url, { headers: { 'User-Agent': 'gps-sdr-sim-route-planner' } }, (upstream) => {
        let body = '';
        upstream.on('data', chunk => body += chunk);
        upstream.on('end', () => {
            try {
                res.json(JSON.parse(body));
            } catch {
                res.status(502).json({ error: 'invalid response from elevation API' });
            }
        });
    }).on('error', e => {
        res.status(502).json({ error: e.message });
    });
});

wss.on('connection', (ws) => {
    let tcp = null;
    let lineBuffer = '';   // accumulates partial lines from gps-sdr-sim feedback

    const reply = (obj) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {
            case 'connect':
                if (tcp) return;
                lineBuffer = '';
                tcp = new net.Socket();
                tcp.connect(GPS_PORT, GPS_HOST, () => {
                    reply({ type: 'status', connected: true });
                });
                tcp.on('data', (chunk) => {
                    // Receive feedback LLH from gps-sdr-sim and forward to browser
                    lineBuffer += chunk.toString();
                    const lines = lineBuffer.split('\n');
                    lineBuffer = lines.pop();   // keep incomplete tail
                    for (const line of lines) {
                        const parts = line.trim().split(',');
                        if (parts.length !== 3) continue;
                        const [lat, lon, alt] = parts.map(Number);
                        if (!isNaN(lat) && !isNaN(lon) && !isNaN(alt))
                            reply({ type: 'feedback', lat, lon, alt });
                    }
                });
                tcp.on('error', (err) => {
                    reply({ type: 'error', message: err.message });
                    tcp = null;
                });
                tcp.on('close', () => {
                    reply({ type: 'status', connected: false });
                    tcp = null;
                });
                break;

            case 'disconnect':
                tcp?.destroy();
                tcp = null;
                reply({ type: 'status', connected: false });
                break;

            case 'position':
                if (tcp?.writable) {
                    const { lat, lon, alt } = msg;
                    tcp.write(`${lat.toFixed(8)},${lon.toFixed(8)},${alt.toFixed(2)}\n`);
                }
                break;
        }
    });

    ws.on('close', () => { tcp?.destroy(); tcp = null; });
    ws.on('error', () => { tcp?.destroy(); tcp = null; });
});

server.listen(HTTP_PORT, () => {
    console.log(`Route planner: http://localhost:${HTTP_PORT}`);
    console.log(`Forwarding positions to gps-sdr-sim at ${GPS_HOST}:${GPS_PORT}`);
});
