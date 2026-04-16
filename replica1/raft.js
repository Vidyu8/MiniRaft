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

        this.events = [];
        this.addEvent(`RAFT Init ${this.id}`);
    }

    addEvent(msg) {
        const timestamp = new Date().toLocaleTimeString();
        const event = `[${timestamp}] ${msg}`;
        this.events.push(event);
        if (this.events.length > 50) this.events.shift();
        console.log(event);
    }

    start() {
        this.resetElectionTimeout();
    }

    getClusterSize() {
        return this.peers.length + 1;
    }

    getQuorumSize() {
        return Math.floor(this.getClusterSize() / 2) + 1;
    }

    async countAlivePeers() {
        const checks = this.peers.map(async peer => {
            try {
                const response = await axios.get(`http://${peer}/health`, { timeout: 200 });
                return response.status === 200;
            } catch (err) {
                return false;
            }
        });
        const results = await Promise.all(checks);
        return results.filter(Boolean).length;
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
        if (this.state === 'Follower') {
            this.addEvent('STATE Transition -> Candidate (missed heartbeat)');
        }
        this.state = 'Candidate';
        this.currentTerm++;
        this.votedFor = this.id;
        this.leaderId = null;
        let votesCount = 1;

        this.addEvent(`ELECTION Start term ${this.currentTerm}`);
        this.resetElectionTimeout();

        const alivePeers = await this.countAlivePeers();
        const liveNodes = alivePeers + 1;
        const majority = this.getQuorumSize();

        if (liveNodes < majority) {
            this.addEvent(`ELECTION Aborted term ${this.currentTerm}: live nodes ${liveNodes}/${this.getClusterSize()} below quorum ${majority}`);
            return;
        }

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

        if (this.state === 'Candidate' && votesCount >= majority) {
            await this.becomeLeader();
        }
    }

    async becomeLeader() {
        // No need to re-check alive peers here — startElection() already verified
        // quorum before sending votes, and we only reach here if majority voted yes,
        // which proves enough peers were alive at vote-collection time.
        this.addEvent(`LEADER Elected for term ${this.currentTerm}`);
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
            this.addEvent(`STATE Change -> Follower (Term ${this.currentTerm})`);
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
        if (this._replicatingTo[peer]) {
            // Mark that a new entry arrived while replication was in flight;
            // we'll kick off another round immediately after the current one finishes.
            this._pendingReplication = this._pendingReplication || {};
            this._pendingReplication[peer] = true;
            return;
        }
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
                // Log mismatch: follower reported its actual log length
                const followerLogLength = response.data.currentLogLength || 0;
                this.nextIndex[peer] = Math.max(0, followerLogLength);

                // Spec §4.3 Catch-Up Protocol: if follower is behind the commit index,
                // leader MUST call /sync-log on the follower to bulk-push all missing
                // committed entries, instead of drip-feeding them one heartbeat at a time.
                if (followerLogLength <= this.commitIndex && this.commitIndex >= 0) {
                    const missingEntries = this.log.slice(followerLogLength, this.commitIndex + 1);
                    if (missingEntries.length > 0) {
                        this.addEvent(`SYNC Catch-up for ${peer}: pushing ${missingEntries.length} entries from index ${followerLogLength}`);
                        axios.post(`http://${peer}/sync-log`, {
                            term: this.currentTerm,
                            fromIndex: followerLogLength,
                            missingEntries
                        }, { timeout: 1000 })
                        .then(res => {
                            if (res.data.success) {
                                this.nextIndex[peer] = this.commitIndex + 1;
                                this.matchIndex[peer] = this.commitIndex;
                                this.addEvent(`SYNC Catch-up complete for ${peer}`);
                            }
                        })
                        .catch(() => {
                            // Peer unreachable during sync — will retry on next heartbeat
                        });
                    }
                }
            }
        } catch (err) {
            // Peer unreachable
        } finally {
            this._replicatingTo[peer] = false;
            // If new entries arrived while we were replicating, send them now immediately
            if (this._pendingReplication && this._pendingReplication[peer]) {
                delete this._pendingReplication[peer];
                setImmediate(() => this._replicateToPeer(peer));
            }
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
            this.addEvent(`SUCCESS: Majority committed strokes up to index ${n}`);

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

        // Use setImmediate to yield to I/O but broadcast as soon as possible (no artificial delay)
        this.broadcastTimeout = setImmediate(async () => {
            const batch = [...this.broadcastBuffer];
            this.broadcastBuffer = [];
            this.broadcastTimeout = null;

            try {
                await axios.post(`${this.gatewayUrl}/broadcast`, { type: 'batch', strokes: batch });
            } catch (e) {
                console.error("[RAFT] Broadcast failed");
            }
        });
    }

    handleSyncLog({ term, fromIndex, missingEntries }) {
        if (term < this.currentTerm) return { success: false };
        // Truncate to fromIndex and append the missing committed entries
        this.log.splice(fromIndex);
        this.log.push(...missingEntries);
        // Advance commitIndex to reflect the entries we just received from leader
        if (missingEntries.length > 0) {
            this.commitIndex = fromIndex + missingEntries.length - 1;
            this.addEvent(`SYNC Caught up: ${this.log.length} entries, commitIndex=${this.commitIndex}`);
        }
        return { success: true };
    }
}

module.exports = RAFTNode;