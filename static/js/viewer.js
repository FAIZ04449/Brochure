(function() {
    // Configure PDF.js Worker
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

    // State Variables
    let pdfDoc = null;
    let pageNum = 1;
    let pageRendering = false;
    let pageNumPending = null;
    let scale = 1.0;
    
    // Canvas & Layer Elements
    const canvas = document.getElementById('pdf-canvas');
    const ctx = canvas.getContext('2d');
    const pageContainer = document.getElementById('pdf-page-container');
    const linkLayer = document.getElementById('link-overlay-layer');
    const loadingSpinner = document.getElementById('loading-spinner');
    
    // Navigation / Controls
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const pageNumInput = document.getElementById('page-num-input');
    const pageCountEl = document.getElementById('page-count');
    const zoomInBtn = document.getElementById('zoom-in');
    const zoomOutBtn = document.getElementById('zoom-out');
    const zoomFitBtn = document.getElementById('zoom-fit');
    const zoomValueEl = document.getElementById('zoom-value');
    const docTitleEl = document.getElementById('doc-title');

    // Tracking Telemetry State
    let sessionId = null;
    let activeTime = 0;
    let isIdle = false;
    let idleTimer = null;
    let heartbeatTimer = null;
    let activeSecondsTimer = null;
    const IDLE_TIMEOUT_MS = 30000; // 30 seconds

    // Resolve unique token from URL path: /v/{token}
    const pathSegments = window.location.pathname.split('/');
    const token = pathSegments[pathSegments.length - 1] || pathSegments[pathSegments.length - 2];
    const pdfUrl = `/v/${token}/pdf`;

    // Initialize Viewer
    pdfjsLib.getDocument(pdfUrl).promise.then(pdfDoc_ => {
        pdfDoc = pdfDoc_;
        pageCountEl.textContent = `/ ${pdfDoc.numPages}`;
        pageNumInput.max = pdfDoc.numPages;
        
        // Update browser tab title
        document.title = "Viewing Brochure";
        docTitleEl.textContent = "Brochure Content";
        
        // Hide spinner & show container
        loadingSpinner.classList.add('hidden');
        pageContainer.classList.remove('hidden');
        
        // Start Session Tracking
        initializeTrackingSession().then(() => {
            // Render first page
            renderPage(pageNum);
            setupTrackingListeners();
        });
    }).catch(err => {
        console.error('Error loading PDF:', err);
        loadingSpinner.innerHTML = `
            <i class="fa-solid fa-triangle-exclamation" style="font-size:2rem;color:#ef4444;margin-bottom:1rem;"></i>
            <p style="color:#ef4444;font-weight:600;">Failed to load PDF brochure.</p>
            <p style="font-size:0.85rem;margin-top:0.25rem;">The link may be invalid, expired, or files are unavailable.</p>
        `;
    });

    // --- PDF Render Logic ---

    function renderPage(num) {
        pageRendering = true;
        
        // Disable controls during render
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        
        pdfDoc.getPage(num).then(page => {
            // Calculate viewport
            const viewport = page.getViewport({ scale: scale });
            canvas.height = viewport.height;
            canvas.width = viewport.width;
            
            // Render PDF page into canvas context
            const renderContext = {
                canvasContext: ctx,
                viewport: viewport
            };
            
            const renderTask = page.render(renderContext);
            
            renderTask.promise.then(() => {
                pageRendering = false;
                
                // Re-enable controls
                prevBtn.disabled = num <= 1;
                nextBtn.disabled = num >= pdfDoc.numPages;
                pageNumInput.value = num;
                
                // Render annotations (links)
                renderAnnotations(page, viewport);
                
                if (pageNumPending !== null) {
                    renderPage(pageNumPending);
                    pageNumPending = null;
                }
            });
        });
    }

    function queueRenderPage(num) {
        if (pageRendering) {
            pageNumPending = num;
        } else {
            renderPage(num);
        }
    }

    // --- Render Interactive PDF Hyperlinks ---

    function renderAnnotations(page, viewport) {
        // Clear previous overlays
        linkLayer.innerHTML = '';
        
        page.getAnnotations().then(annotations => {
            const links = annotations.filter(annot => annot.subtype === 'Link');
            
            links.forEach(annot => {
                if (annot.url) {
                    // Convert PDF points coordinates to Viewport pixel coordinates
                    const rect = viewport.convertToViewportRectangle(annot.rect);
                    const left = Math.min(rect[0], rect[2]);
                    const top = Math.min(rect[1], rect[3]);
                    const width = Math.abs(rect[0] - rect[2]);
                    const height = Math.abs(rect[1] - rect[3]);
                    
                    // Create overlay anchor link
                    const linkEl = document.createElement('a');
                    linkEl.href = annot.url;
                    linkEl.className = 'pdf-annotation-link';
                    linkEl.style.left = `${left}px`;
                    linkEl.style.top = `${top}px`;
                    linkEl.style.width = `${width}px`;
                    linkEl.style.height = `${height}px`;
                    linkEl.target = '_blank';
                    
                    // Click Interceptor for click events logging
                    linkEl.addEventListener('click', (e) => {
                        e.preventDefault();
                        logClick(pageNum, annot.url);
                        window.open(annot.url, '_blank');
                    });
                    
                    linkLayer.appendChild(linkEl);
                }
            });
        });
    }

    // --- Interactive Controls ---

    prevBtn.addEventListener('click', () => {
        if (pageNum <= 1) return;
        logUIClick('Toolbar - Prev Page');
        changePage(pageNum - 1);
    });

    nextBtn.addEventListener('click', () => {
        if (pageNum >= pdfDoc.numPages) return;
        logUIClick('Toolbar - Next Page');
        changePage(pageNum + 1);
    });

    pageNumInput.addEventListener('change', (e) => {
        let target = parseInt(e.target.value);
        if (isNaN(target) || target < 1) target = 1;
        if (target > pdfDoc.numPages) target = pdfDoc.numPages;
        
        logUIClick(`Toolbar - Jump Page to ${target}`);
        changePage(target);
    });

    zoomInBtn.addEventListener('click', () => {
        if (scale >= 3.0) return;
        scale = Math.min(3.0, scale + 0.15);
        zoomValueEl.textContent = `${Math.round(scale * 100)}%`;
        logUIClick(`Toolbar - Zoom In (${zoomValueEl.textContent})`);
        queueRenderPage(pageNum);
    });

    zoomOutBtn.addEventListener('click', () => {
        if (scale <= 0.5) return;
        scale = Math.max(0.5, scale - 0.15);
        zoomValueEl.textContent = `${Math.round(scale * 100)}%`;
        logUIClick(`Toolbar - Zoom Out (${zoomValueEl.textContent})`);
        queueRenderPage(pageNum);
    });

    zoomFitBtn.addEventListener('click', () => {
        // Fit PDF page width to viewport width
        const containerWidth = document.getElementById('viewer-container').clientWidth;
        pdfDoc.getPage(pageNum).then(page => {
            const defaultViewport = page.getViewport({ scale: 1.0 });
            scale = (containerWidth * 0.95) / defaultViewport.width;
            zoomValueEl.textContent = `${Math.round(scale * 100)}%`;
            logUIClick('Toolbar - Zoom Fit Width');
            queueRenderPage(pageNum);
        });
    });

    function changePage(targetPageNum) {
        if (targetPageNum === pageNum) return;
        
        // Flush time spent on old page
        flushPageTime(pageNum, activeTime);
        
        pageNum = targetPageNum;
        activeTime = 0; // Reset active seconds counter for new page
        queueRenderPage(pageNum);
    }

    // --- Tracking Telemetry Core ---

    async function initializeTrackingSession() {
        try {
            const response = await fetch('/api/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: token })
            });
            if (response.ok) {
                const data = await response.json();
                sessionId = data.session_id;
                console.log('Session tracking initialized:', sessionId);
            } else {
                console.warn('Tracking registration rejected by server');
            }
        } catch (e) {
            console.error('Connection error registering session:', e);
        }
    }

    function setupTrackingListeners() {
        if (!sessionId) return;

        // 1. Time ticks (1 sec interval)
        activeSecondsTimer = setInterval(() => {
            if (document.visibilityState === 'visible' && !isIdle) {
                activeTime += 1;
            }
        }, 1000);

        // 2. Idle Detection listeners
        resetIdleTimer();
        const activityEvents = ['mousemove', 'keydown', 'scroll', 'click', 'touchstart'];
        activityEvents.forEach(evt => {
            window.addEventListener(evt, resetIdleTimer, { passive: true });
        });

        // 3. Heartbeats (every 20 seconds)
        heartbeatTimer = setInterval(sendHeartbeat, 20000);

        // 4. Page hide / Close tab flushes
        window.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                flushPageTime(pageNum, activeTime);
                activeTime = 0;
            }
        });

        window.addEventListener('beforeunload', () => {
            flushPageTime(pageNum, activeTime);
            // Quick final heartbeat to register ended_at
            if (navigator.sendBeacon) {
                navigator.sendBeacon(`/api/sessions/${sessionId}/heartbeat`);
            }
        });
    }

    function resetIdleTimer() {
        if (isIdle) {
            isIdle = false;
            console.log('User resumed activity');
        }
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            isIdle = true;
            console.log('User went idle');
        }, IDLE_TIMEOUT_MS);
    }

    function flushPageTime(page, time) {
        if (!sessionId || time <= 0) return;
        
        const payload = JSON.stringify({ page_number: page, active_seconds: time });
        const url = `/api/sessions/${sessionId}/page-event`;
        
        if (navigator.sendBeacon) {
            const blob = new Blob([payload], { type: 'application/json' });
            navigator.sendBeacon(url, blob);
        } else {
            fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload,
                keepalive: true
            }).catch(e => console.warn('Backup page sync failed:', e));
        }
    }

    function sendHeartbeat() {
        if (!sessionId) return;
        
        // Also flush any pending active time in parallel
        if (activeTime > 0) {
            flushPageTime(pageNum, activeTime);
            activeTime = 0;
        }

        const url = `/api/sessions/${sessionId}/heartbeat`;
        if (navigator.sendBeacon) {
            navigator.sendBeacon(url);
        } else {
            fetch(url, { method: 'POST', keepalive: true })
                .catch(e => console.warn('Heartbeat fetch failed:', e));
        }
    }

    function logClick(page, url) {
        if (!sessionId) return;
        
        const payload = JSON.stringify({ page_number: page, target_url: url });
        const endpoint = `/api/sessions/${sessionId}/click`;
        
        if (navigator.sendBeacon) {
            const blob = new Blob([payload], { type: 'application/json' });
            navigator.sendBeacon(endpoint, blob);
        } else {
            fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload,
                keepalive: true
            }).catch(e => console.warn('Click event transmission error:', e));
        }
    }

    function logUIClick(uiElementLabel) {
        // Log custom UI events as clicks to the click endpoint
        logClick(pageNum, `UI-Click: ${uiElementLabel}`);
    }

})();
