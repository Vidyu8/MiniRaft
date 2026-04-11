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
        this.resetElectionTimeout();

        const votePromises = this.peers.map(async peerRef => {
            try {
                const response = await axios.post(`http://${peerRef}/request-vote`, {
                    term: this.currentTerm,
                    candidateId: this.id,
                    lastLogIndex: this.log.length - 1,
                    // In a real RAFT, lastLogTerm would be included. Simplified here.
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

        // Majority is roughly peers.length / 2 + 1. Since total is peers.length + 1 (us).
        // Total = 3, majority = 2.
        const majority = Math.floor((this.peers.length + 1) / 2) + 1;

        if (this.state === 'Candidate' && votesCount >= majority) {
            this.becomeLeader();
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

        // 2. Restart catch-up check:
        // Follower log might be empty or smaller than what leader thinks
        if (prevLogIndex >= this.log.length) {
            return { 
                term: this.currentTerm, 
                success: false, 
                currentLogLength: this.log.length 
            };
        }

        // Apply new entries
        if (entries && entries.length > 0) {
            // Overwrite anything in our log beyond prevLogIndex and append new entries
            this.log.splice(prevLogIndex + 1);
            this.log.push(...entries);
            console.log(`[RAFT] ${this.id} appended ${entries.length} entries`);
        }

        if (leaderCommit > this.commitIndex) {
            this.commitIndex = Math.min(leaderCommit, this.log.length - 1);
        }

        return { term: this.currentTerm, success: true, currentLogLength: this.log.length };
    }

    handleSyncLog({ term, missingEntries, fromIndex }) {
        if (term < this.currentTerm) return { success: false };
        
        console.log(`[SYNC] ${this.id} received full sync-log from leader from index ${fromIndex}. Count: ${missingEntries.length}`);
        
        this.log.splice(fromIndex);
        this.log.push(...missingEntries);
        this.commitIndex = this.log.length - 1; // Assuming synced are committed
        
        return { success: true };
    }

    // --- Leader Methods --- //

    async sendHeartbeats() {
        if (this.state !== 'Leader') return;

        // Perform heartbeat RPC call and simultaneous log replication
        this.peers.forEach(async peer => {
            // Also notify followers via dedicated /heartbeat endpoint for compliance
            axios.post(`http://${peer}/heartbeat`, {
                term: this.currentTerm,
                leaderId: this.id
            }).catch(() => {});

            const prevIndex = this.nextIndex[peer] - 1;
            // Get entries to send
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
                    this.nextIndex[peer] = this.log.length;
                    this.matchIndex[peer] = this.nextIndex[peer] - 1;
                    
                    // If we just sent some strokes, maybe those strokes are now majority committed!
                    if (entriesToSend.length > 0) {
                        this.tryCommit();
                    }
                } else if (response.data.term > this.currentTerm) {
                    this.stepDown(response.data.term);
                } else {
                    // AppendEntries failed due to Catch-up protocol trigger!
                    // This node is saying our prevLogIndex is ahead of its current length.
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
                         // failed to sync... will retry next heartbeat
                    }
                }
            } catch (err) {
                // Peer is down or timeout
            }
        });
    }

    tryCommit() {
        // Find majority match index
        // Count ourselves
        const matchIndexes = Object.values(this.matchIndex);
        matchIndexes.push(this.log.length - 1);
        
        matchIndexes.sort((a, b) => b - a); // descending
        
        // The index that the majority has replicated
        const majorityIndex = Math.floor(matchIndexes.length / 2);
        const newCommitIndex = matchIndexes[majorityIndex];

        if (newCommitIndex > this.commitIndex) {
            // New strokes committed! Broadcast them
            const newlyCommitted = this.log.slice(this.commitIndex + 1, newCommitIndex + 1);
            this.commitIndex = newCommitIndex;
            
            console.log(`[LEADER] Successfully committed entries up to index ${this.commitIndex}`);
            
            // Broadcast to gateway
            newlyCommitted.forEach(stroke => {
                axios.post(`${this.gatewayUrl}/broadcast`, stroke).catch(e => {
                    console.error("Leader failed to notify gateway of committed stroke", e.message);
                });
            });
        }
    }
}

module.exports = RAFTNode;
