document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('drawing-board');
    const ctx = canvas.getContext('2d');
    
    const wsStatusDot = document.querySelector('.dot');
    const wsStatusText = document.getElementById('ws-status');
    const leaderIdSpan = document.getElementById('leader-id');
    const clearBtn = document.getElementById('clear-btn');
    const colorInput = document.getElementById('stroke-color');
    const sizeInput = document.getElementById('stroke-size');

    let isDrawing = false;
    let currentX = 0;
    let currentY = 0;

    // Unique ID for this client to avoid double-drawing our own strokes
    const clientId = Math.random().toString(36).substring(2, 15);

    // WebSocket connection to gateway
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host === '' ? 'localhost:3000' : window.location.host}/ws`;
    
    let ws;
    
    function connectWebSocket() {
        ws = new WebSocket(wsUrl);
        
        ws.onopen = () => {
            wsStatusDot.classList.add('connected');
            wsStatusText.innerHTML = '<span class="dot connected"></span> Connection: Connected';
        };
        
        ws.onclose = () => {
            wsStatusDot.classList.remove('connected');
            wsStatusText.innerHTML = '<span class="dot"></span> Connection: Disconnected... Reconnecting...';
            leaderIdSpan.innerText = 'Unknown';
            setTimeout(connectWebSocket, 2000);
        };
        
        ws.onerror = (err) => {
            console.error('WebSocket Error:', err);
        };
        
        // Local cache of strokes to avoid flickering during sync
        let localStrokes = [];

        ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                
                if (message.type === 'leader_update') {
                    leaderIdSpan.innerText = message.leaderId || 'None (Election...)';
                    leaderIdSpan.style.color = message.leaderId ? 'var(--leader-color)' : 'var(--danger-color)';
                } else if (message.type === 'stroke') {
                    // Only draw if it's from another client
                    if (message.data.clientId !== clientId) {
                        localStrokes.push(message.data);
                        drawStrokeOnCanvas(message.data);
                    }
                } else if (message.type === 'sync') {
                    // Anti-flicker: Only redraw if the sync message has more/different data than we have
                    const incomingStrokes = message.data;
                    
                    // Simple check: if we have fewer strokes or the last one is different
                    // (In a more complex app we'd check hashes or lengths more robustly)
                    if (incomingStrokes.length !== localStrokes.length) {
                        console.log(`[SYNC] Updating canvas. Local: ${localStrokes.length}, Incoming: ${incomingStrokes.length}`);
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        localStrokes = incomingStrokes;
                        localStrokes.forEach(stroke => drawStrokeOnCanvas(stroke));
                    }
                }
            } catch (e) {
                console.error("Failed to parse message", e);
            }
        };
    }
    
    connectWebSocket();

    // Drawing logic
    function getMousePos(evt) {
        const rect = canvas.getBoundingClientRect();
        return {
            x: evt.clientX - rect.left,
            y: evt.clientY - rect.top
        };
    }
    
    // For touch devices
    function getTouchPos(evt) {
        const rect = canvas.getBoundingClientRect();
        return {
            x: evt.touches[0].clientX - rect.left,
            y: evt.touches[0].clientY - rect.top
        };
    }

    function startDrawing(e) {
        isDrawing = true;
        const pos = e.touches ? getTouchPos(e) : getMousePos(e);
        currentX = pos.x;
        currentY = pos.y;
    }

    function stopDrawing() {
        isDrawing = false;
    }

    function draw(e) {
        if (!isDrawing) return;
        e.preventDefault(); // Prevent scrolling on touch
        
        const pos = e.touches ? getTouchPos(e) : getMousePos(e);
        const strokeData = {
            startX: currentX,
            startY: currentY,
            endX: pos.x,
            endY: pos.y,
            color: colorInput.value,
            size: sizeInput.value,
            clientId: clientId
        };

        // Draw locally immediately for responsiveness
        drawStrokeOnCanvas(strokeData);
        
        // Send to gateway
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'stroke',
                data: strokeData
            }));
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

    // Event listeners for drawing
    canvas.addEventListener('mousedown', startDrawing);
    canvas.addEventListener('mousemove', draw);
    canvas.addEventListener('mouseup', stopDrawing);
    canvas.addEventListener('mouseout', stopDrawing);

    // Touch support
    canvas.addEventListener('touchstart', startDrawing, { passive: false });
    canvas.addEventListener('touchmove', draw, { passive: false });
    canvas.addEventListener('touchend', stopDrawing);
    canvas.addEventListener('touchcancel', stopDrawing);

    clearBtn.addEventListener('click', () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // Note: For a fully persistent clear, we would need to send a 'clear' event through RAFT.
        // For now, this is a local clear as per typical whiteboard assignment rules unless specified.
    });
});
