(function() {
    // Configure PDF.js Worker
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

    // UI Elements
    const hubNavList = document.getElementById('hub-nav-list');
    const docTitleEl = document.getElementById('doc-title');
    const loadingSpinner = document.getElementById('loading-spinner');
    
    // Viewers
    const pdfContainer = document.getElementById('pdf-page-container');
    const videoContainer = document.getElementById('video-container');
    const iframeContainer = document.getElementById('iframe-container');
    
    // Toolbars
    const pdfControls = document.getElementById('pdf-controls');
    const pdfZoomControls = document.getElementById('pdf-zoom-controls');

    // PDF State
    let pdfDoc = null;
    let pageNum = 1;
    let pageRendering = false;
    let pageNumPending = null;
    let scale = 1.0;
    const canvas = document.getElementById('pdf-canvas');
    const ctx = canvas.getContext('2d');
    const linkLayer = document.getElementById('link-overlay-layer');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const pageNumInput = document.getElementById('page-num-input');
    const pageCountEl = document.getElementById('page-count');
    const zoomInBtn = document.getElementById('zoom-in');
    const zoomOutBtn = document.getElementById('zoom-out');
    const zoomFitBtn = document.getElementById('zoom-fit');
    const zoomValueEl = document.getElementById('zoom-value');

    // Hub State
    let documents = [];
    let activeDocumentId = null;
    let activeDocumentType = null;
    let activeDocumentName = null;

    // Tracking Telemetry State
    let sessionId = null;
    let activeTime = 0;
    let isIdle = false;
    let idleTimer = null;
    let heartbeatTimer = null;
    let activeSecondsTimer = null;
    const IDLE_TIMEOUT_MS = 30000; // 30 seconds

    // Video play watch state tracking
    let videoWatchTime = 0;
    let isVideoPlaying = false;


    // Toolbar auto-hide state
    const toolbar = document.getElementById('main-toolbar');
    let toolbarHideTimer = null;
    const TOOLBAR_HIDE_DELAY = 2500; // ms after last mouse move

    function showToolbar() {
        if (toolbar) toolbar.classList.remove('toolbar-hidden');
        clearTimeout(toolbarHideTimer);
        // Only auto-hide when a PDF is active (no need to hide for non-PDF)
        if (activeDocumentType === 'pdf') {
            toolbarHideTimer = setTimeout(() => {
                if (toolbar) toolbar.classList.add('toolbar-hidden');
            }, TOOLBAR_HIDE_DELAY);
        }
    }

    // Show toolbar on any mouse movement over the viewer area
    const viewerArea = document.getElementById('viewer-container');
    if (viewerArea) {
        viewerArea.addEventListener('mousemove', showToolbar);
        viewerArea.addEventListener('touchstart', showToolbar, { passive: true });
    }


    // Resolve unique token from URL path: /v/{token}
    const pathSegments = window.location.pathname.split('/');
    const token = pathSegments[pathSegments.length - 1] || pathSegments[pathSegments.length - 2];

    // Initialize Hub
    initializeTrackingSession().then(() => {
        if (documents && documents.length > 0) {
            renderSidebar();
            switchDocument(documents[0].id);
            setupTrackingListeners();
        } else {
            showError("No documents available in this bundle.");
        }
    }).catch(err => {
        console.error('Init error:', err);
        showError("Failed to initialize hub.");
    });

    function showError(msg) {
        loadingSpinner.innerHTML = `
            <i class="fa-solid fa-triangle-exclamation" style="font-size:2rem;color:#ef4444;margin-bottom:1rem;"></i>
            <p style="color:#ef4444;font-weight:600;">${msg}</p>
        `;
    }

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
                documents = data.documents || [];
                console.log('Session tracking initialized:', sessionId, 'Documents:', documents.length);
            } else {
                console.warn('Tracking registration rejected by server');
                showError("Unauthorized or invalid link.");
                throw new Error("Invalid session");
            }
        } catch (e) {
            console.error('Connection error registering session:', e);
            throw e;
        }
    }

    function renderSidebar() {
        hubNavList.innerHTML = '';
        documents.forEach(doc => {
            let icon = 'fa-file';
            if (doc.doc_type === 'pdf') icon = 'fa-file-pdf';
            if (doc.doc_type === 'video') icon = 'fa-video';
            if (doc.doc_type === 'link') icon = 'fa-link';

            const li = document.createElement('li');
            li.className = 'hub-nav-item';
            li.dataset.docId = doc.id;
            li.innerHTML = `
                <i class="fa-solid ${icon} hub-nav-item-icon"></i>
                <span class="hub-nav-item-text">${escapeHTML(doc.filename)}</span>
            `;
            li.addEventListener('click', () => switchDocument(doc.id));
            hubNavList.appendChild(li);
        });
    }

    function getDocById(id) {
        return documents.find(d => d.id === parseInt(id));
    }

    function switchDocument(docId) {
        if (activeDocumentId === docId) return;
        
        // Flush telemetry for previous document
        flushCurrentTelemetry();

        activeDocumentId = docId;
        const doc = getDocById(docId);
        if (!doc) return;

        activeDocumentType = doc.doc_type;
        activeDocumentName = doc.filename;
        activeTime = 0; // Reset timer
        videoWatchTime = 0; // Reset video active watch timer
        isVideoPlaying = false; // Reset video playing state


        // Update UI
        document.querySelectorAll('.hub-nav-item').forEach(el => {
            if (el.dataset.docId == docId) el.classList.add('active');
            else el.classList.remove('active');
        });
        
        docTitleEl.textContent = doc.filename;
        document.title = `${doc.filename} | Hub`;

        // Hide all viewers and controls
        pdfContainer.classList.add('hidden');
        videoContainer.classList.add('hidden');
        iframeContainer.classList.add('hidden');
        loadingSpinner.classList.remove('hidden');
        
        pdfControls.style.display = 'none';
        pdfZoomControls.style.display = 'none';

        // Clear contents
        videoContainer.innerHTML = '';
        iframeContainer.innerHTML = '';

        if (doc.doc_type === 'pdf') {
            loadPdfDocument(docId);
        } else if (doc.doc_type === 'video') {
            loadVideoDocument(docId);
        } else if (doc.doc_type === 'link') {
            loadLinkDocument(doc);
        }
    }

    function loadPdfDocument(docId) {
        const fileUrl = `/v/${token}/file/${docId}`;
        
        pdfjsLib.getDocument(fileUrl).promise.then(pdfDoc_ => {
            pdfDoc = pdfDoc_;
            pageNum = 1;
            pageCountEl.textContent = `/ ${pdfDoc.numPages}`;
            pageNumInput.max = pdfDoc.numPages;

            // Auto-fit: compute scale so PDF fills the container width
            pdfDoc.getPage(1).then(firstPage => {
                const container = document.getElementById('viewer-container');
                let containerWidth = container ? container.clientWidth : 0;
                if (containerWidth < 200) {
                    containerWidth = window.innerWidth;
                }
                // Subtract padding space
                const availableW = containerWidth - 32;
                const naturalViewport = firstPage.getViewport({ scale: 1.0 });
                
                // Set scale to fit width comfortably
                scale = Math.max(0.6, availableW / naturalViewport.width);
                zoomValueEl.textContent = Math.round(scale * 100) + '%';

                loadingSpinner.classList.add('hidden');
                pdfContainer.classList.remove('hidden');
                pdfControls.style.display = 'flex';
                pdfZoomControls.style.display = 'flex';

                renderPage(pageNum);
                showToolbar(); // show toolbar briefly on load, then auto-hide
            });
        }).catch(err => {
            console.error('Error loading PDF:', err);
            showError("Failed to load PDF file.");
        });
    }

    function loadVideoDocument(docId) {
        const fileUrl = `/v/${token}/file/${docId}`;
        
        const video = document.createElement('video');
        video.controls = true;
        video.src = fileUrl;
        video.style.width = '100%';
        video.style.borderRadius = '8px';
        
        video.addEventListener('play', () => {
            isVideoPlaying = true;
            logComponentEvent('play');
        });
        video.addEventListener('pause', () => {
            isVideoPlaying = false;
            logComponentEvent('pause');
        });
        video.addEventListener('ended', () => {
            isVideoPlaying = false;
            logComponentEvent('ended');
        });


        videoContainer.appendChild(video);
        loadingSpinner.classList.add('hidden');
        videoContainer.classList.remove('hidden');
    }

    function loadLinkDocument(doc) {
        let meta = {};
        try { meta = JSON.parse(doc.metadata || '{}'); } catch(e){}
        let targetUrl = (meta.url || '').trim();
        
        if (!targetUrl) {
            showError("External link URL is missing.");
            return;
        }

        // --- URL Conversions for Embed Support ---
        let embeddableUrl = targetUrl;
        let isEmbeddable = false;

        // 1. YouTube Conversion
        let ytMatch = targetUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\s\?]+)/);
        if (ytMatch) {
            embeddableUrl = `https://www.youtube.com/embed/${ytMatch[1]}`;
            isEmbeddable = true;
        }
        // 2. Google Drive File View Conversion
        else if (targetUrl.includes('drive.google.com/file/d/')) {
            let gdMatch = targetUrl.match(/drive\.google\.com\/file\/d\/([^\/\?\s]+)/);
            if (gdMatch) {
                embeddableUrl = `https://drive.google.com/file/d/${gdMatch[1]}/preview`;
                isEmbeddable = true;
            }
        }
        // 3. Known embeddable platforms
        else if (
            targetUrl.includes('figma.com/file/') || 
            targetUrl.includes('canva.com/design/') || 
            targetUrl.includes('miro.com/app/board/') ||
            targetUrl.includes('google.com/presentation/d/')
        ) {
            isEmbeddable = true;
        }

        loadingSpinner.classList.add('hidden');

        if (isEmbeddable) {
            // Embed directly in iframe
            const iframe = document.createElement('iframe');
            iframe.src = embeddableUrl;
            iframe.allowFullscreen = true;
            iframe.title = doc.filename;
            
            iframeContainer.appendChild(iframe);
            iframeContainer.classList.remove('hidden');
        } else {
            // Show a beautiful portal card for non-embeddable links
            const card = document.createElement('div');
            card.className = 'external-link-card';
            card.innerHTML = `
                <i class="fa-solid fa-arrow-up-right-from-square"></i>
                <h3>${escapeHTML(doc.filename)}</h3>
                <p>This resource is hosted externally on another website. Click below to launch and read it in a new window.</p>
                <a href="${escapeHTML(targetUrl)}" class="btn-external-launch" target="_blank" id="launch-link-btn">
                    Open Document <i class="fa-solid fa-chevron-right"></i>
                </a>
            `;

            // Track direct link opening in telemetry
            const launchBtn = card.querySelector('#launch-link-btn');
            if (launchBtn) {
                launchBtn.addEventListener('click', () => {
                    logClick(0, targetUrl); // logs external click
                    logComponentEvent('link_opened', targetUrl);
                });
            }

            iframeContainer.appendChild(card);
            iframeContainer.classList.remove('hidden');
        }
    }


    // --- PDF Render Logic ---

    function renderPage(num) {
        pageRendering = true;
        
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        
        pdfDoc.getPage(num).then(page => {
            const viewport = page.getViewport({ scale: scale });
            canvas.height = viewport.height;
            canvas.width = viewport.width;
            
            const renderContext = { canvasContext: ctx, viewport: viewport };
            const renderTask = page.render(renderContext);
            
            renderTask.promise.then(() => {
                pageRendering = false;
                prevBtn.disabled = num <= 1;
                nextBtn.disabled = num >= pdfDoc.numPages;
                pageNumInput.value = num;
                
                renderAnnotations(page, viewport);
                
                if (pageNumPending !== null) {
                    renderPage(pageNumPending);
                    pageNumPending = null;
                }
            });
        });
    }

    function queueRenderPage(num) {
        if (pageRendering) pageNumPending = num;
        else renderPage(num);
    }

    function renderAnnotations(page, viewport) {
        linkLayer.innerHTML = '';
        page.getAnnotations().then(annotations => {
            const links = annotations.filter(annot => annot.subtype === 'Link');
            links.forEach(annot => {
                if (annot.url) {
                    const rect = viewport.convertToViewportRectangle(annot.rect);
                    const left = Math.min(rect[0], rect[2]);
                    const top = Math.min(rect[1], rect[3]);
                    const width = Math.abs(rect[0] - rect[2]);
                    const height = Math.abs(rect[1] - rect[3]);
                    
                    const linkEl = document.createElement('a');
                    linkEl.href = annot.url;
                    linkEl.className = 'pdf-annotation-link';
                    linkEl.style.left = `${left}px`;
                    linkEl.style.top = `${top}px`;
                    linkEl.style.width = `${width}px`;
                    linkEl.style.height = `${height}px`;
                    linkEl.target = '_blank';
                    
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
        
        flushCurrentTelemetry();
        pageNum = targetPageNum;
        activeTime = 0;
        queueRenderPage(pageNum);
    }

    // --- Tracking Telemetry Core ---

    function setupTrackingListeners() {
        if (!sessionId) return;

        activeSecondsTimer = setInterval(() => {
            if (document.visibilityState === 'visible' && !isIdle) {
                activeTime += 1;
                // Increment video play timer only if a video is actively playing
                if (activeDocumentType === 'video' && isVideoPlaying) {
                    videoWatchTime += 1;
                }
            }
        }, 1000);

        resetIdleTimer();
        const activityEvents = ['mousemove', 'keydown', 'scroll', 'click', 'touchstart'];
        activityEvents.forEach(evt => {
            window.addEventListener(evt, resetIdleTimer, { passive: true });
        });

        heartbeatTimer = setInterval(sendHeartbeat, 20000);

        window.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                flushCurrentTelemetry();
                activeTime = 0;
                // pause video states
                isVideoPlaying = false;
            }
        });

        window.addEventListener('beforeunload', () => {
            flushCurrentTelemetry();
            if (navigator.sendBeacon) {
                navigator.sendBeacon(`/api/sessions/${sessionId}/heartbeat`);
            }
        });
    }

    function resetIdleTimer() {
        if (isIdle) {
            isIdle = false;
        }
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            isIdle = true;
            // If they go idle, also stop tracking video watch duration
            isVideoPlaying = false;
        }, IDLE_TIMEOUT_MS);
    }

    function flushCurrentTelemetry() {
        if (!sessionId || !activeDocumentId || activeTime <= 0) return;

        const time = activeTime;
        const docId = activeDocumentId;
        const type = activeDocumentType;
        const page = pageNum;
        
        if (type === 'pdf') {
            const payload = JSON.stringify({ document_id: docId, page_number: page, active_seconds: time });
            const url = `/api/sessions/${sessionId}/page-event`;
            sendBeaconOrFetch(url, payload);
        } else {
            // General page view duration on the component tab
            let payload = JSON.stringify({ 
                document_id: docId, 
                event_type: `${type}_view`, 
                active_seconds: time 
            });
            let url = `/api/sessions/${sessionId}/component-event`;
            sendBeaconOrFetch(url, payload);

            // If it is a video and was actually played, log the exact playback duration separately
            if (type === 'video' && videoWatchTime > 0) {
                const playPayload = JSON.stringify({
                    document_id: docId,
                    event_type: 'video_watch_duration',
                    active_seconds: videoWatchTime
                });
                sendBeaconOrFetch(url, playPayload);
                videoWatchTime = 0; // Reset
            }
        }
    }

    function logComponentEvent(eventType, eventData = '') {
        if (!sessionId || !activeDocumentId) return;
        const payload = JSON.stringify({
            document_id: activeDocumentId,
            event_type: eventType,
            active_seconds: 0,
            event_data: eventData
        });
        sendBeaconOrFetch(`/api/sessions/${sessionId}/component-event`, payload);
    }

    function sendBeaconOrFetch(url, payload) {
        if (navigator.sendBeacon) {
            const blob = new Blob([payload], { type: 'application/json' });
            navigator.sendBeacon(url, blob);
        } else {
            fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload,
                keepalive: true
            }).catch(e => console.warn('Telemetry sync failed:', e));
        }
    }

    function sendHeartbeat() {
        if (!sessionId) return;
        
        if (activeTime > 0) {
            flushCurrentTelemetry();
            activeTime = 0;
        }

        const url = `/api/sessions/${sessionId}/heartbeat`;
        if (navigator.sendBeacon) navigator.sendBeacon(url);
        else fetch(url, { method: 'POST', keepalive: true }).catch(e => {});
    }

    function logClick(page, url) {
        if (!sessionId || !activeDocumentId) return;
        const payload = JSON.stringify({ document_id: activeDocumentId, page_number: page, target_url: url });
        sendBeaconOrFetch(`/api/sessions/${sessionId}/click`, payload);
    }

    function logUIClick(uiElementLabel) {
        logClick(pageNum, `UI-Click: ${uiElementLabel}`);
    }

    function escapeHTML(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;')
                  .replace(/'/g, '&#039;');
    }
})();
