const axios = require('axios');

class RAFTNode {
    constructor(id, port, peers, gatewayUrl) {
        this.id = id;
        this.port = port;
        this.peers = peers;
        this.gatewayUrl = gatewayUrl;

        // Persistent State (kept in-memory for this assignment)
        this.currentTerm = 0;
        this.votedFor = null;
        this.log = []; // Array of strokes

        // Volatile State
        this.commitIndex = -1;
        this.lastApplied = -1;
        this.state = 'Follower'; // 'Follower', 'Candidate', 'Leader'
        this.leaderId = null;

        // Volatile state on leaders
        this.nextIndex = {};
        this.matchIndex = {};

        // Timers
        this.electionTimeout = null;
        this.heartbeatInterval = null;

        console.log(`[RAFT] Init ${this.id} with peers: ${this.peers}`);
    }

    start() {
        this.resetElectionTimeout();
    }

    getRandomTimeout() {
        // Random timeout between 500ms and 800ms
        return Math.floor(Math.random() * 300) + 500;
    }

    resetElectionTimeout() {
        clearTimeout(this.electionTimeout);
        if (this.state === 'Leader') return;

        this.electionTimeout = setTimeout(() => {
            this.startElection();
        }, this.getRandomTimeout());
    }

    async startElection() {
        this.state = 'Candidate';
        this.currentTerm++;
        this.votedFor = this.id;
        this.leaderId = null;
        let votesCount = 1; // Voted for self

        console.log(`[ELECTION] ${this.id} starting election for term ${this.currentTerm}`);

        // FIX 2: Set a fresh randomized election timeout BEFORE awaiting votes.
        // If votes come back and we still don't have majority (split vote),
        // this timeout will already be ticking and will trigger a new election
        // for the next term automatically — explicit split vote retry.
        this.resetElectionTimeout();

        const votePromises = this.peers.map(async peerRef => {
            try {
                const response = await axios.post(`http://${peerRef}/request-vote`, {
                    term: this.currentTerm,
                    candidateId: this.id,
                    lastLogIndex: this.log.length - 1,
                }, { timeout: 300 });

                if (response.data.term > this.currentTerm) {
                    this.stepDown(response.data.term);
                    return false;
                }

                if (response.data.voteGranted) {
                    return true;
                }
            } catch (err) {
                // Peer is likely down
                return false;
            }
            return false;
        });

        const results = await Promise.all(votePromises);
        votesCount += results.filter(r => r).length;

        // Total = 3, majority = 2.
        const majority = Math.floor((this.peers.length + 1) / 2) + 1;

        if (this.state === 'Candidate' && votesCount >= majority) {
            this.becomeLeader();
        } else if (this.state === 'Candidate') {
            // Split vote or failed election
            console.log(`[ELECTION] ${this.id} election failed/split (${votesCount}/${this.peers.length + 1} votes). Retrying after timeout...`);
            // The election timeout set at the start of startElection will trigger a retry.
        }
    }

    becomeLeader() {
        console.log(`[LEADER] ${this.id} became leader for term ${this.currentTerm}`);
        this.state = 'Leader';
        this.leaderId = this.id;
        clearTimeout(this.electionTimeout);

        // Notify gateway about leadership with retry
        const notifyGateway = () => {
            if (this.state !== 'Leader') return;
            axios.post(`${this.gatewayUrl}/leader`, {
                leaderId: this.id,
                port: this.port
            }).catch(() => {
                console.error("Could not notify gateway, retrying in 2s...");
                setTimeout(notifyGateway, 2000);
            });
        };
        notifyGateway();

        // Initialize leader tracking maps
        this.peers.forEach(peer => {
            this.nextIndex[peer] = this.log.length;
            this.matchIndex[peer] = -1;
        });

        this.sendHeartbeats();
        this.heartbeatInterval = setInterval(() => this.sendHeartbeats(), 150);
    }

    stepDown(newTerm) {
        if (newTerm > this.currentTerm) {
            console.log(`[STATE] ${this.id} stepping down: discovered higher term ${newTerm}.`);
            this.currentTerm = newTerm;
            this.votedFor = null;
        }

        if (this.state !== 'Follower') {
            console.log(`[STATE] ${this.id} transitioning to Follower state.`);
            if (this.state === 'Leader') {
                clearInterval(this.heartbeatInterval);
            }
            this.state = 'Follower';
        }

        this.resetElectionTimeout();
    }

    handleHeartbeat(data) {
        const { term, leaderId } = data;
        if (term < this.currentTerm) {
            return { term: this.currentTerm, success: false };
        }

        console.log(`[HEARTBEAT] Received from ${leaderId} for term ${term}`);
        this.stepDown(term);
        this.leaderId = leaderId;
        this.resetElectionTimeout();
        return { term: this.currentTerm, success: true };
    }

    // --- RPC Handlers --- //

    handleRequestVote(data) {
        const { term, candidateId } = data;
        let voteGranted = false;

        if (term > this.currentTerm) {
            this.stepDown(term);
        }

        if (term === this.currentTerm && (this.votedFor === null || this.votedFor === candidateId)) {
            voteGranted = true;
            this.votedFor = candidateId;
            this.resetElectionTimeout();
            console.log(`[VOTE] ${this.id} granted vote to ${candidateId} for term ${term}`);
        }

        return { term: this.currentTerm, voteGranted };
    }

    handleAppendEntries(data) {
        const { term, leaderId, prevLogIndex, entries, leaderCommit } = data;

        if (term < this.currentTerm) {
            return { term: this.currentTerm, success: false };
        }

        this.stepDown(term);
        this.leaderId = leaderId;
        this.resetElectionTimeout();

        // Safety Check: Follower log is shorter than leader expects (Gap detected)
        if (prevLogIndex >= this.log.length) {
            console.log(`[RAFT] ${this.id} detected log gap. PrevLogIndex: ${prevLogIndex}, LocalLength: ${this.log.length}`);
            return {
                term: this.currentTerm,
                success: false,
                currentLogLength: this.log.length
            };
        }

        // Apply new entries
        if (entries && entries.length > 0) {
            // Overwrite and append
            this.log.splice(prevLogIndex + 1);
            this.log.push(...entries);
            console.log(`[RAFT] ${this.id} appended ${entries.length} entries. New length: ${this.log.length}`);
        }

        if (leaderCommit > this.commitIndex) {
            // Commit index is the min of leader's commit and our own last log index
            this.commitIndex = Math.min(leaderCommit, this.log.length - 1);
        }

        return { term: this.currentTerm, success: true, currentLogLength: this.log.length };
    }

    handleSyncLog({ term, missingEntries, fromIndex }) {
        if (term < this.currentTerm) return { success: false };

        console.log(`[SYNC] ${this.id} received full sync-log from leader from index ${fromIndex}. Count: ${missingEntries.length}`);

        this.log.splice(fromIndex);
        this.log.push(...missingEntries);
        this.commitIndex = this.log.length - 1;

        return { success: true };
    }

    // --- Leader Methods --- //

    // FIX 1: Immediately replicate a new entry to all peers instead of
    // waiting up to 150ms for the next heartbeat cycle.
    async replicateNow() {
        if (this.state !== 'Leader') return;
        console.log(`[RAFT] ${this.id} triggering immediate replication for new entry`);
        await this.sendHeartbeats();
    }

    async sendHeartbeats() {
        if (this.state !== 'Leader') return;

        this.peers.forEach(async peer => {
            // Notify followers via dedicated /heartbeat endpoint
            axios.post(`http://${peer}/heartbeat`, {
                term: this.currentTerm,
                leaderId: this.id
            }, { timeout: 300 }).catch(() => { });

            const prevIndex = this.nextIndex[peer] - 1;
            const entriesToSend = this.log.slice(prevIndex + 1);

            try {
                const response = await axios.post(`http://${peer}/append-entries`, {
                    term: this.currentTerm,
                    leaderId: this.id,
                    prevLogIndex: prevIndex,
                    entries: entriesToSend,
                    leaderCommit: this.commitIndex
                }, { timeout: 300 });

                if (response.data.success) {
                    const lastIndexSent = prevIndex + entriesToSend.length;
                    this.nextIndex[peer] = lastIndexSent + 1;
                    this.matchIndex[peer] = lastIndexSent;

                    if (entriesToSend.length > 0) {
                        this.tryCommit();
                    }
                } else if (response.data.term > this.currentTerm) {
                    this.stepDown(response.data.term);
                } else {
                    // Follower is behind — trigger sync-log catch-up
                    console.log(`[SYNC] Follower ${peer} is out of sync. Initiating sync-log...`);
                    const followerLength = response.data.currentLogLength;
                    const missingEntries = this.log.slice(followerLength);

                    try {
                        const syncResponse = await axios.post(`http://${peer}/sync-log`, {
                            term: this.currentTerm,
                            fromIndex: followerLength,
                            missingEntries: missingEntries
                        }, { timeout: 500 });

                        if (syncResponse.data.success) {
                            this.nextIndex[peer] = this.log.length;
                            this.matchIndex[peer] = this.log.length - 1;
                        }
                    } catch (e) {
                        // failed to sync, will retry on next heartbeat
                    }
                }
            } catch (err) {
                // Peer is down or timed out
            }
        });
    }

    tryCommit() {
        const matchIndexes = Object.values(this.matchIndex);
        matchIndexes.push(this.log.length - 1); // include self

        matchIndexes.sort((a, b) => b - a); // descending

        // The index that the majority has replicated
        const majorityIndex = Math.floor(matchIndexes.length / 2);
        const newCommitIndex = matchIndexes[majorityIndex];

        if (newCommitIndex > this.commitIndex) {
            const newlyCommitted = this.log.slice(this.commitIndex + 1, newCommitIndex + 1);
            this.commitIndex = newCommitIndex;

            console.log(`[LEADER] Successfully committed entries up to index ${this.commitIndex}`);

            // Broadcast committed strokes to gateway
            newlyCommitted.forEach(stroke => {
                axios.post(`${this.gatewayUrl}/broadcast`, stroke).catch(e => {
                    console.error("Leader failed to notify gateway of committed stroke", e.message);
                });
            });
        }
    }
}

module.exports = RAFTNode;