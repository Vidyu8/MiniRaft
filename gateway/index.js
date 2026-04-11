const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json());

// Serve static frontend files (assuming we map frontend folder to gateway in another way, or just serve from parent if we map the parent. Actually in docker-compose I only mounted `./gateway:/app`. Let's serve static content from here, but I didn't mount frontend!
// Wait, I should mount `./frontend` to Gateway's `/app/public` in docker-compose.)
// We will serve from '/app/public'
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

let currentLeaderId = null;
let currentLeaderUrl = null;

// Track all connected clients
const clients = new Set();

// Buffer for strokes received during election (no leader)
let strokeBuffer = [];

wss.on('connection', ws => {
    clients.add(ws);
    
    // Send current leader info on connection
    ws.send(JSON.stringify({
        type: 'leader_update',
        leaderId: currentLeaderId
    }));

    // If we have a leader, we should ideally send them the current synced state.
    // For simplicity, we can fetch state from leader and send it right away.
    if (currentLeaderUrl) {
        axios.get(`${currentLeaderUrl}/state`)
            .then(response => {
                ws.send(JSON.stringify({
                    type: 'sync',
                    data: response.data.log || []
                }));
            }).catch(err => console.error("Could not fetch state for new client:", err.message));
    }

    ws.on('message', async message => {
        try {
            const parsed = JSON.parse(message);
            if (parsed.type === 'stroke') {
                // Forward to current leader
                if (currentLeaderUrl) {
                    try {
                        await axios.post(`${currentLeaderUrl}/stroke`, parsed.data, { timeout: 500 });
                    } catch (err) {
                        console.error('[GATEWAY] Leader unreachable. Clearing leader and buffering stroke.');
                        currentLeaderId = null;
                        currentLeaderUrl = null;
                        strokeBuffer.push(parsed.data);
                    }
                } else {
                    console.log('[GATEWAY] No leader available. Buffering stroke.');
                    strokeBuffer.push(parsed.data);
                }
            }
        } catch (e) {
            console.error('[GATEWAY] Failed to handle ws message', e);
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
    });
});

// Endpoint for Replicas to notify Gateway when they become leader
app.post('/leader', (req, res) => {
    const { leaderId, "port": leaderPort } = req.body;

    if (!leaderId) {
        console.log(`[GATEWAY] Leader went down. Clearing leader state.`);
        currentLeaderId = null;
        currentLeaderUrl = null;
    } else {
        console.log(`[GATEWAY] New leader elected: ${leaderId} on port ${leaderPort}`);
        currentLeaderId = leaderId;
        currentLeaderUrl = `http://${leaderId}:${leaderPort}`;

        // Flush stroke buffer to new leader
        if (strokeBuffer.length > 0) {
            console.log(`[GATEWAY] Flushing ${strokeBuffer.length} buffered strokes to new leader...`);
            const strokesToFlush = [...strokeBuffer];
            strokeBuffer = [];
            
            strokesToFlush.forEach(stroke => {
                axios.post(`${currentLeaderUrl}/stroke`, stroke)
                    .catch(err => console.error("[GATEWAY] Failed to flush buffered stroke:", err.message));
            });
        }
    }

    // Broadcast leader change to all clients
    const msg = JSON.stringify({
        type: 'leader_update',
        leaderId
    });
    clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(msg);
    });

    res.status(200).send('Ack');
});

// Endpoint for the Leader to broadcast committed strokes to all clients via Gateway
app.post('/broadcast', (req, res) => {
    const strokeData = req.body;
    const msg = JSON.stringify({
        type: 'stroke',
        data: strokeData
    });

    clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
            c.send(msg);
        }
    });

    res.status(200).send('Ack');
});

// A simple health check
app.get('/health', (req, res) => res.status(200).send("OK"));

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Gateway WebSocket server running on port ${PORT}`);
});
