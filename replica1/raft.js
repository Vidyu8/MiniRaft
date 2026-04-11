const axios = require('axios');

class RAFTNode {
    constructor(id, port, peers, gatewayUrl) {
        this.id = id;
        this.port = port;
        this.peers = peers;
        this.gatewayUrl = gatewayUrl;

        this.currentTerm = 0;
        this.votedFor = null;
        this.log = [];

        this.commitIndex = -1;
        this.lastApplied = -1;
        this.state = 'Follower';
        this.leaderId = null;

        this.nextIndex = {};
        this.matchIndex = {};

        this.electionTimeout = null;
        this.heartbeatInterval = null;

        this.pendingCommits = {};
        this._replicatingTo = {};
        
        // Batching buffer for broadcasts
        this.broadcastBuffer = [];
        this.broadcastTimeout = null;

        console.log(`[RAFT] Init ${this.id}`);
    }

    start() {
        this.resetElectionTimeout();
    }

    getRandomTimeout() {
        return Math.floor(Math.random() * 300) + 500;
    }

    resetElectionTimeout() {
        clearTimeout(this.electionTimeout);
        if (this.state === 'Leader') return;
        this.electionTimeout = setTimeout(() => this.startElection(), this.getRandomTimeout());
    }

    async startElection() {
        this.state = 'Candidate';
        this.currentTerm++;
        this.votedFor = this.id;
        this.leaderId = null;
        let votesCount = 1;

        console.log(`[ELECTION] ${this.id} term ${this.currentTerm}`);
        this.resetElectionTimeout();

        const votePromises = this.peers.map(async peerRef => {
            try {
                const response = await axios.post(`http://${peerRef}/request-vote`, {
                    term: this.currentTerm,
                    candidateId: this.id,
                    lastLogIndex: this.log.length - 1,
                }, { timeout: 200 });

                if (response.data.term > this.currentTerm) {
                    this.stepDown(response.data.term);
                    return false;
                }
                return response.data.voteGranted === true;
            } catch (err) {
                return false;
            }
        });

        const results = await Promise.all(votePromises);
        votesCount += results.filter(Boolean).length;

        const majority = Math.floor((this.peers.length + 1) / 2) + 1;

        if (this.state === 'Candidate' && votesCount >= majority) {
            this.becomeLeader();
        }
    }

    becomeLeader() {
        console.log(`[LEADER] ${this.id} term ${this.currentTerm}`);
        this.state = 'Leader';
        this.leaderId = this.id;
        clearTimeout(this.electionTimeout);

        this.peers.forEach(peer => {
            this.nextIndex[peer] = this.log.length;
            this.matchIndex[peer] = -1;
        });

        const notifyGateway = () => {
            if (this.state !== 'Leader') return;
            axios.post(`${this.gatewayUrl}/leader`, {
                leaderId: this.id,
                port: this.port
            }).catch(() => {});
        };
        notifyGateway();

        this.heartbeatInterval = setInterval(() => this.sendHeartbeats(), 150);
    }

    stepDown(newTerm) {
        if (newTerm > this.currentTerm) {
            this.currentTerm = newTerm;
            this.votedFor = null;
        }
        if (this.state !== 'Follower') {
            console.log(`[STATE] ${this.id} -> Follower`);
            clearInterval(this.heartbeatInterval);
            this.state = 'Follower';
            // Fail any pending promises
            Object.values(this.pendingCommits).forEach(p => p.reject(new Error("Stepped down")));
            this.pendingCommits = {};
        }
        this.resetElectionTimeout();
    }

    handleRequestVote(data) {
        const { term, candidateId } = data;
        if (term > this.currentTerm) this.stepDown(term);
        
        let voteGranted = false;
        if (term === this.currentTerm && (this.votedFor === null || this.votedFor === candidateId)) {
            voteGranted = true;
            this.votedFor = candidateId;
            this.resetElectionTimeout();
        }
        return { term: this.currentTerm, voteGranted };
    }

    handleHeartbeat(data) {
        const { term, leaderId } = data;
        if (term < this.currentTerm) return { term: this.currentTerm, success: false };
        this.stepDown(term);
        this.leaderId = leaderId;
        this.resetElectionTimeout();
        return { term: this.currentTerm, success: true };
    }

    handleAppendEntries(data) {
        const { term, leaderId, prevLogIndex, entries, leaderCommit } = data;
        if (term < this.currentTerm) return { term: this.currentTerm, success: false };

        this.stepDown(term);
        this.leaderId = leaderId;
        this.resetElectionTimeout();

        // Log consistency check
        if (prevLogIndex >= 0 && (prevLogIndex >= this.log.length)) {
            return { term: this.currentTerm, success: false, currentLogLength: this.log.length };
        }

        if (entries && entries.length > 0) {
            this.log.splice(prevLogIndex + 1);
            this.log.push(...entries);
        }

        if (leaderCommit > this.commitIndex) {
            this.commitIndex = Math.min(leaderCommit, this.log.length - 1);
        }

        return { term: this.currentTerm, success: true, currentLogLength: this.log.length };
    }

    appendStroke(entry) {
        return new Promise((resolve, reject) => {
            if (this.state !== 'Leader') return reject(new Error("Not leader"));
            
            const index = this.log.length;
            // Store term with entry for safety rule
            this.log.push({ ...entry, term: this.currentTerm });
            this.pendingCommits[index] = { resolve, reject };
            
            this.peers.forEach(peer => this._replicateToPeer(peer));
        });
    }

    sendHeartbeats() {
        if (this.state !== 'Leader') return;
        this.peers.forEach(peer => this._replicateToPeer(peer));
    }

    async _replicateToPeer(peer) {
        if (this._replicatingTo[peer]) return;
        this._replicatingTo[peer] = true;

        try {
            const nextIdx = this.nextIndex[peer] ?? 0;
            const prevIndex = nextIdx - 1;
            const entries = this.log.slice(nextIdx);

            const response = await axios.post(`http://${peer}/append-entries`, {
                term: this.currentTerm,
                leaderId: this.id,
                prevLogIndex: prevIndex,
                entries: entries,
                leaderCommit: this.commitIndex
            }, { timeout: 250 });

            if (response.data.success) {
                this.nextIndex[peer] = nextIdx + entries.length;
                this.matchIndex[peer] = this.nextIndex[peer] - 1;
                this.tryCommit();
            } else if (response.data.term > this.currentTerm) {
                this.stepDown(response.data.term);
            } else {
                // Adjust nextIndex based on follower's actual log length
                this.nextIndex[peer] = Math.max(0, response.data.currentLogLength || 0);
            }
        } catch (err) {
            // Peer unreachable
        } finally {
            this._replicatingTo[peer] = false;
        }
    }

    tryCommit() {
        if (this.state !== 'Leader') return;

        const matchIdxs = [...Object.values(this.matchIndex), this.log.length - 1].sort((a, b) => b - a);
        const majorityIdx = Math.floor((this.peers.length + 1) / 2);
        const n = matchIdxs[majorityIdx];

        // Safety: Only commit entries from the current term
        if (n > this.commitIndex && this.log[n] && this.log[n].term === this.currentTerm) {
            const oldCommit = this.commitIndex;
            this.commitIndex = n;

            for (let i = oldCommit + 1; i <= n; i++) {
                const entry = this.log[i];
                if (this.pendingCommits[i]) {
                    this.pendingCommits[i].resolve();
                    delete this.pendingCommits[i];
                }
                this.broadcastBuffer.push(entry);
            }
            this.flushBroadcasts();
        }
    }

    flushBroadcasts() {
        if (this.broadcastBuffer.length === 0) return;
        if (this.broadcastTimeout) return;

        // Small delay to batch multiple mouse-move events into one HTTP call
        this.broadcastTimeout = setTimeout(async () => {
            const batch = [...this.broadcastBuffer];
            this.broadcastBuffer = [];
            this.broadcastTimeout = null;

            try {
                await axios.post(`${this.gatewayUrl}/broadcast`, { type: 'batch', strokes: batch });
            } catch (e) {
                console.error("[RAFT] Broadcast failed");
            }
        }, 20);
    }

    handleSyncLog({ term, fromIndex, missingEntries }) {
        if (term < this.currentTerm) return { success: false };
        this.log.splice(fromIndex);
        this.log.push(...missingEntries);
        return { success: true };
    }
}

module.exports = RAFTNode;