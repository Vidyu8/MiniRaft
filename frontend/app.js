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

    const clientId = Math.random().toString(36).substring(2, 15);

    // Lives outside connectWebSocket — survives reconnects
    let localStrokes = [];

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host || 'localhost:3000'}/ws`;

    let ws;
    let wsReady = false;

    function connectWebSocket() {
        wsReady = false;
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            wsReady = true;
            reconnectDelay = 200; // reset backoff on success
            wsStatusText.innerHTML = '<span class="dot connected"></span> Connection: Connected';
            console.log('[WS] Connected');
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
                leaderIdSpan.innerText = message.leaderId || 'Election in progress...';
            } else if (message.type === 'sync') {
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
});