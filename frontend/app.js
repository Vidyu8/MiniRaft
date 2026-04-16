document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('drawing-board');
    const ctx = canvas.getContext('2d');

    const wsStatusText = document.getElementById('ws-status');
    const leaderIdSpan = document.getElementById('leader-id');
    const clearBtn = document.getElementById('clear-btn');
    const colorInput = document.getElementById('stroke-color');
    const sizeInput = document.getElementById('stroke-size');

    let isDrawing = false;
    let currentX = 0;
    let currentY = 0;
    let reconnectDelay = 200; // start fast, back off only if needed

    // Use sessionStorage so each browser tab gets its own unique clientId.
    // localStorage is shared across all tabs in the same browser, which would
    // cause strokes from other tabs to be filtered out as "own" strokes.
    const clientId = sessionStorage.getItem('drawingClientId') || Math.random().toString(36).substring(2, 15);
    sessionStorage.setItem('drawingClientId', clientId);

    // Lives outside connectWebSocket — survives reconnects
    let localStrokes = [];

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host || 'localhost:3000'}/ws`;

    let ws;
    let wsReady = false;
    let currentLeaderId = null;

    function syncCanvasFromLeader(leaderId) {
        const portMap = { replica1: 4001, replica2: 4002, replica3: 4003 };
        const port = portMap[leaderId];
        if (!port) return;

        fetch(`http://localhost:${port}/state`, { signal: AbortSignal.timeout(1000) })
            .then(res => res.json())
            .then(data => {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                localStrokes = data.log || [];
                localStrokes.forEach(s => drawStrokeOnCanvas(s));
            })
            .catch(() => {});
    }

    async function refreshLeaderStateIfNeeded() {
        if (!currentLeaderId) return;

        const portMap = { replica1: 4001, replica2: 4002, replica3: 4003 };
        const port = portMap[currentLeaderId];
        if (!port) return;

        try {
            const res = await fetch(`http://localhost:${port}/state`, { signal: AbortSignal.timeout(1000) });
            if (!res.ok) return;
            const data = await res.json();
            const remoteLog = Array.isArray(data.log) ? data.log : [];

            const localJson = JSON.stringify(localStrokes);
            const remoteJson = JSON.stringify(remoteLog);
            if (localJson !== remoteJson) {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                localStrokes = remoteLog;
                localStrokes.forEach(s => drawStrokeOnCanvas(s));
            }
        } catch (err) {
            // ignore leader state fetch failures
        }
    }

    function connectWebSocket() {
        wsReady = false;
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            wsReady = true;
            reconnectDelay = 200; // reset backoff on success
            wsStatusText.innerHTML = '<span class="dot connected"></span> Connection: Connected';
            console.log('[WS] Connected');
            ws.send(JSON.stringify({ type: 'identify', clientId }));
            // Sync canvas on reconnect
            if (currentLeaderId) {
                syncCanvasFromLeader(currentLeaderId);
            }
        };

        ws.onclose = () => {
            wsReady = false;
            wsStatusText.innerHTML = '<span class="dot"></span> Connection: Reconnecting...';
            leaderIdSpan.innerText = 'Unknown';
            // Reconnect fast — 200ms instead of 2000ms so strokes aren't lost during failover
            setTimeout(connectWebSocket, reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 2, 2000); // back off up to 2s max
        };

        ws.onerror = () => {}; // onclose handles it

        ws.onmessage = (event) => {
            const message = JSON.parse(event.data);

            if (message.type === 'leader_update') {
                currentLeaderId = message.leaderId;
                leaderIdSpan.innerText = message.leaderId || 'Election in progress...';
                // Do NOT call syncCanvasFromLeader here — the gateway will send a
                // 'sync' message with the full log immediately after leader_update,
                // which avoids the double full-redraw and canvas flicker.
            } else if (message.type === 'identity_update') {
                document.getElementById('student-number').innerText = `Student ${message.studentId}`;
            } else if (message.type === 'class_update') {
                document.getElementById('class-size').innerText = `${message.count} Students`;
            } else if (message.type === 'sync') {
                if (message.leaderId) {
                    currentLeaderId = message.leaderId;
                    leaderIdSpan.innerText = message.leaderId || 'Election in progress...';
                }
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                localStrokes = message.data || [];
                localStrokes.forEach(s => drawStrokeOnCanvas(s));
            } else if (message.type === 'stroke') {
                // message.data is now an array due to batching
                const strokes = Array.isArray(message.data) ? message.data : [message.data];
                strokes.forEach(s => {
                    // Only draw if it's from another user
                    if (s.clientId !== clientId) {
                        drawStrokeOnCanvas(s);
                    }
                    localStrokes.push(s);
                });
            }
        };
    }

    connectWebSocket();
    setInterval(refreshLeaderStateIfNeeded, 2500);

    // --- Drawing ---

    function getPos(e) {
        const rect = canvas.getBoundingClientRect();
        const src = e.touches ? e.touches[0] : e;
        return { x: src.clientX - rect.left, y: src.clientY - rect.top };
    }

    function startDrawing(e) {
        isDrawing = true;
        const pos = getPos(e);
        currentX = pos.x;
        currentY = pos.y;
    }

    function stopDrawing() {
        isDrawing = false;
    }

    function draw(e) {
        if (!isDrawing) return;
        e.preventDefault();

        const pos = getPos(e);
        const strokeData = {
            startX: currentX,
            startY: currentY,
            endX: pos.x,
            endY: pos.y,
            color: colorInput.value,
            size: parseInt(sizeInput.value),
            clientId
        };

        // Draw locally immediately
        drawStrokeOnCanvas(strokeData);

        // Send to gateway only if connected
        if (wsReady && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'stroke', data: strokeData }));
        }

        currentX = pos.x;
        currentY = pos.y;
    }

    function drawStrokeOnCanvas({ startX, startY, endX, endY, color, size }) {
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.strokeStyle = color;
        ctx.lineWidth = size;
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.closePath();
    }

    canvas.addEventListener('mousedown', startDrawing);
    canvas.addEventListener('mousemove', draw);
    canvas.addEventListener('mouseup', stopDrawing);
    canvas.addEventListener('mouseout', stopDrawing);
    canvas.addEventListener('touchstart', startDrawing, { passive: false });
    canvas.addEventListener('touchmove', draw, { passive: false });
    canvas.addEventListener('touchend', stopDrawing);
    canvas.addEventListener('touchcancel', stopDrawing);

    clearBtn.addEventListener('click', () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        localStrokes = [];
    });

    // --- Cluster Health Logic ---
    const healthIdSpan = document.getElementById('health-id');
    const healthStatusDiv = document.getElementById('health-status');

    async function updateClusterHealth() {
        const ports = [4001, 4002, 4003];
        let aliveCount = 0;

        const checks = ports.map(async p => {
            try {
                const res = await fetch(`http://localhost:${p}/health`, { signal: AbortSignal.timeout(500) });
                if (res.ok) aliveCount++;
            } catch (e) {}
        });

        await Promise.all(checks);

        if (aliveCount >= 2) {
            healthIdSpan.innerText = `${aliveCount}/3 (Healthy)`;
            healthStatusDiv.style.background = "#6BCB77"; // Grass Green
        } else {
            healthIdSpan.innerText = `${aliveCount}/3 (No Majority!)`;
            healthStatusDiv.style.background = "#FF5E5E"; // Crayola Red
            
            // Add a friendly warning to the chalkboard
            const warningCode = `[!] WAITING: Teacher is busy! (We need 2+ friends online to share drawings)`;
            if (!logViewer.innerText.includes(warningCode)) {
                const entry = document.createElement('div');
                entry.className = 'log-entry';
                entry.style.color = "#FFCDD2";
                entry.style.fontWeight = "bold";
                entry.innerText = warningCode;
                logViewer.prepend(entry);
            }
        }
    }
    setInterval(updateClusterHealth, 2000);
    updateClusterHealth();

    // --- Replica Status Updates ---
    async function updateReplicaStatuses() {
        const replicas = [
            { id: 'replica1', port: 4001 },
            { id: 'replica2', port: 4002 },
            { id: 'replica3', port: 4003 }
        ];

        for (const rep of replicas) {
            try {
                const res = await fetch(`http://localhost:${rep.port}/state`, { signal: AbortSignal.timeout(500) });
                if (res.ok) {
                    const data = await res.json();
                    document.getElementById(`${rep.id}-state`).innerText = data.state.toUpperCase();
                } else {
                    throw new Error();
                }
            } catch (e) {
                document.getElementById(`${rep.id}-state`).innerText = 'NOT AVAILABLE';
            }
        }
    }
    setInterval(updateReplicaStatuses, 2000);
    updateReplicaStatuses();

    // --- Dashboard Logic ---
    const logViewer = document.getElementById('log-viewer');
    const replicaBtns = document.querySelectorAll('.replica-btn');
    const monitoringLabel = document.getElementById('monitoring-label');
    let activePort = "4001";
    let lastLogsJson = "";

    replicaBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            replicaBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activePort = btn.dataset.port;
            lastLogsJson = ""; // Force refresh
            monitoringLabel.innerText = `Class Monitoring: Replica ${btn.innerText.split(' ')[1]}`;
            logViewer.innerHTML = `<div class="log-entry">Switched to Replica on port ${activePort}...</div>`;
        });
    });

    async function fetchLogs() {
        try {
            const response = await fetch(`http://localhost:${activePort}/logs`);
            if (!response.ok) throw new Error("Offline");
            const logs = await response.json();
            const logsJson = JSON.stringify(logs);

            // Only update DOM if logs changed
            if (logsJson !== lastLogsJson) {
                lastLogsJson = logsJson;
                if (logs.length === 0) {
                    logViewer.innerHTML = `<div class="log-entry">No logs yet for this replica.</div>`;
                } else {
                    logViewer.innerHTML = logs.map(log => {
                        // Highlight key status changes
                        let color = '';
                        if (log.indexOf('LEADER') !== -1) color = 'color: var(--leader-color)';
                        if (log.indexOf('Follower') !== -1) color = 'color: var(--text-secondary)';
                        if (log.indexOf('ELECTION') !== -1) color = 'color: var(--accent-color)';
                        
                        return `<div class="log-entry" style="${color}">${log}</div>`;
                    }).join('');
                    logViewer.scrollTop = logViewer.scrollHeight;
                }
            }
        } catch (err) {
            logViewer.innerHTML = `<div class="log-entry" style="color: var(--danger-color)">REPLICA OFFLINE: Replica at :${activePort} is unreachable.</div>`;
        }
    }

    setInterval(fetchLogs, 1000);
    fetchLogs();
});
