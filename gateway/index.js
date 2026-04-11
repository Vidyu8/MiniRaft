const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '50mb' })); // Allow larger batches
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

let currentLeaderUrl = null;
let currentLeaderId = null;
const clients = new Set();

wss.on('connection', ws => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'leader_update', leaderId: currentLeaderId }));

    if (currentLeaderUrl) {
        axios.get(`${currentLeaderUrl}/state`, { timeout: 1000 })
            .then(res => ws.send(JSON.stringify({ type: 'sync', data: res.data.log })))
            .catch(() => {});
    }

    ws.on('message', async msg => {
        const parsed = JSON.parse(msg);
        if (parsed.type === 'stroke' && currentLeaderUrl) {
            try {
                // Increased timeout to 2s to survive single-node failures
                await axios.post(`${currentLeaderUrl}/stroke`, parsed.data, { timeout: 2000 });
            } catch (err) {
                console.error("[GATEWAY] Stroke failed: Leader likely busy/down");
            }
        }
    });

    ws.on('close', () => clients.delete(ws));
});

app.post('/leader', (req, res) => {
    const { leaderId, port } = req.body;
    currentLeaderId = leaderId;
    currentLeaderUrl = leaderId ? `http://${leaderId}:${port}` : null;
    
    const msg = JSON.stringify({ type: 'leader_update', leaderId });
    clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(msg));
    res.sendStatus(200);
});

app.post('/broadcast', (req, res) => {
    const data = req.body;
    // Handle both single strokes and batches
    const msg = JSON.stringify({ 
        type: 'stroke', 
        data: data.type === 'batch' ? data.strokes : [data] 
    });

    clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(msg));
    res.sendStatus(200);
});

server.listen(3000, () => console.log("Gateway listening on 3000"));