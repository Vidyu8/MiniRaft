const express = require('express');
const axios = require('axios');
const RAFTNode = require('./raft');

const app = express();
app.use(express.json());

const REPLICA_ID = process.env.REPLICA_ID || `replica-${Math.floor(Math.random()*1000)}`;
const PORT = parseInt(process.env.PORT) || 4000;
const PEERS = (process.env.PEERS || "").split(',').filter(Boolean);
const GATEWAY_URL = process.env.GATEWAY_URL || "http://gateway:3000";

const raft = new RAFTNode(REPLICA_ID, PORT, PEERS, GATEWAY_URL);

app.post('/request-vote', (req, res) => {
    res.json(raft.handleRequestVote(req.body));
});

app.post('/append-entries', (req, res) => {
    res.json(raft.handleAppendEntries(req.body));
});

app.post('/heartbeat', (req, res) => {
    res.json(raft.handleHeartbeat(req.body));
});

app.get('/state', (req, res) => {
    res.json({
        id: REPLICA_ID,
        term: raft.currentTerm,
        state: raft.state,
        leader: raft.leaderId,
        log: raft.log,
        commitIndex: raft.commitIndex
    });
});

app.post('/sync-log', (req, res) => {
    res.json(raft.handleSyncLog(req.body));
});

// Gateway submits new strokes here — only leader accepts
app.post('/stroke', async (req, res) => {
    if (raft.state !== 'Leader') {
        return res.status(421).json({ error: "Not the leader", leaderId: raft.leaderId });
    }

    try {
        // Use class method — don't mutate raft.log directly
        await raft.appendStroke(req.body);
        res.status(200).json({ status: "Stroke committed" });
    } catch (err) {
        console.error(`[${REPLICA_ID}] Failed to commit stroke:`, err.message);
        res.status(500).json({ error: "Failed to commit stroke" });
    }
});

app.get('/health', (req, res) => {
    res.status(200).json({ status: "alive", id: REPLICA_ID, state: raft.state });
});

// Server must be declared BEFORE signal handlers that reference it
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[${REPLICA_ID}] Replica listening on port ${PORT}`);
    raft.start();
});

async function gracefulShutdown(signal) {
    console.log(`[${REPLICA_ID}] Received ${signal}. Starting graceful shutdown...`);

    if (raft.state === 'Leader') {
        clearInterval(raft.heartbeatInterval);
        console.log(`[${REPLICA_ID}] Stopped heartbeat interval.`);
        try {
            await axios.post(`${GATEWAY_URL}/leader`, { leaderId: null, port: null });
            console.log(`[${REPLICA_ID}] Notified gateway: no leader.`);
        } catch (e) {
            console.warn(`[${REPLICA_ID}] Could not notify gateway during shutdown.`);
        }
    }

    server.close(() => {
        console.log(`[${REPLICA_ID}] HTTP server closed. Exiting.`);
        process.exit(0);
    });

    setTimeout(() => {
        console.warn(`[${REPLICA_ID}] Forced exit after timeout.`);
        process.exit(1);
    }, 3000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));