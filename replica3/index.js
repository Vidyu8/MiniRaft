const express = require('express');
const axios = require('axios');
const RAFTNode = require('./raft');

const app = express();
app.use(express.json());

const REPLICA_ID = process.env.REPLICA_ID || `replica-${Math.floor(Math.random()*1000)}`;
const PORT = parseInt(process.env.PORT) || 4000;
const PEERS = (process.env.PEERS || "").split(',').filter(Boolean); // array of "host:port"
const GATEWAY_URL = process.env.GATEWAY_URL || "http://gateway:3000";

const raft = new RAFTNode(REPLICA_ID, PORT, PEERS, GATEWAY_URL);

// RAFT RPC Endpoints
app.post('/request-vote', (req, res) => {
    const response = raft.handleRequestVote(req.body);
    res.json(response);
});

app.post('/append-entries', (req, res) => {
    const response = raft.handleAppendEntries(req.body);
    res.json(response);
});

app.post('/heartbeat', (req, res) => {
    const response = raft.handleHeartbeat(req.body);
    res.json(response);
});

// Used by gateway or other nodes to fetch full log
app.get('/state', (req, res) => {
    res.json({
        term: raft.currentTerm,
        leader: raft.leaderId,
        log: raft.log
    });
});

// Endpoint used when a node wakes up or finds itself behind
app.post('/sync-log', (req, res) => {
    const response = raft.handleSyncLog(req.body);
    res.json(response);
});

// Endpoint called by Gateway to submit a new stroke.
// Only the Leader should accept this.
app.post('/stroke', async (req, res) => {
    if (raft.state !== 'Leader') {
        return res.status(421).json({ error: "Not the leader", leaderId: raft.leaderId });
    }
    
    // Add to local log and try to commit
    const entry = req.body;
    raft.log.push(entry);
    raft.replicateNow(); 
    
    // Log is updated, next AppendEntries will replicate it.
    // In strict RAFT we wait for majority before returning success.
    // For this assignment, we replicate asynchronously and broadcast upon commit.
    res.status(200).json({ status: "Stroke appended" });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: "alive", id: REPLICA_ID, state: raft.state });
});

async function gracefulShutdown(signal) {
    console.log(`[${REPLICA_ID}] Received ${signal}. Starting graceful shutdown...`);

    // 1. Stop being a leader — stop sending heartbeats
    if (raft.state === 'Leader') {
        clearInterval(raft.heartbeatInterval);
        console.log(`[${REPLICA_ID}] Stopped heartbeat interval.`);

        // 2. Notify gateway that there is no leader anymore
        try {
            await axios.post(`${GATEWAY_URL}/leader`, { leaderId: null, port: null });
            console.log(`[${REPLICA_ID}] Notified gateway: no leader.`);
        } catch (e) {
            console.warn(`[${REPLICA_ID}] Could not notify gateway during shutdown.`);
        }
    }

    // 3. Stop accepting new connections, finish existing ones
    server.close(() => {
        console.log(`[${REPLICA_ID}] HTTP server closed. Exiting.`);
        process.exit(0);
    });

    // 4. Force exit after 3 seconds if server.close hangs
    setTimeout(() => {
        console.warn(`[${REPLICA_ID}] Forced exit after timeout.`);
        process.exit(1);
    }, 3000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[${REPLICA_ID}] Replica listening on port ${PORT}`);
    raft.start();
});