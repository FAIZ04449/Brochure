(function() {
    // Generate UUID v4 for the session
    function generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    // Parse query parameters
    function getQueryParam(name) {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get(name);
    }

    // Detect browser, OS, and device
    function getClientSpecs() {
        const ua = navigator.userAgent;
        let browser = "Unknown";
        let os = "Unknown";
        let device = "Desktop";

        // Browser detection
        if (ua.indexOf("Firefox") > -1) browser = "Firefox";
        else if (ua.indexOf("SamsungBrowser") > -1) browser = "Samsung Browser";
        else if (ua.indexOf("Opera") > -1 || ua.indexOf("OPR") > -1) browser = "Opera";
        else if (ua.indexOf("Trident") > -1) browser = "Internet Explorer";
        else if (ua.indexOf("Edge") > -1 || ua.indexOf("Edg") > -1) browser = "Edge";
        else if (ua.indexOf("Chrome") > -1) browser = "Chrome";
        else if (ua.indexOf("Safari") > -1) browser = "Safari";

        // OS detection
        if (ua.indexOf("Windows NT 10.0") > -1) os = "Windows 10/11";
        else if (ua.indexOf("Windows NT 6.2") > -1) os = "Windows 8";
        else if (ua.indexOf("Windows NT 6.1") > -1) os = "Windows 7";
        else if (ua.indexOf("Macintosh") > -1) os = "macOS";
        else if (ua.indexOf("iPhone") > -1) os = "iOS (iPhone)";
        else if (ua.indexOf("iPad") > -1) os = "iOS (iPad)";
        else if (ua.indexOf("Android") > -1) os = "Android";
        else if (ua.indexOf("Linux") > -1) os = "Linux";

        // Device type
        if (/Mobi|Android|iPhone|iPod/i.test(ua)) {
            device = "Mobile";
        } else if (/Tablet|iPad/i.test(ua)) {
            device = "Tablet";
        }

        return { browser, os, device };
    }

    // Global Tracking State
    const session_id = generateUUID();
    const recipient = getQueryParam('email') || getQueryParam('r') || 'Anonymous';
    const specs = getClientSpecs();
    const startTime = Date.now();
    
    let maxScrollDepth = 0;
    let initialized = false;
    let heartbeatInterval = null;
    
    // Structure to hold page view durations
    const sectionDurations = {};
    let activeSection = null;
    let activeSectionEnterTime = null;
    const sectionHistory = []; // { section_name, duration, entered_at }

    // Track pages 1 through 4 of the PDF brochure
    const trackedSectionIds = ['#page-1', '#page-2', '#page-3', '#page-4'];
    trackedSectionIds.forEach(id => {
        sectionDurations[id] = 0;
    });

    // Get Geo Location details
    async function fetchGeoIp() {
        const services = [
            'https://ipapi.co/json/',
            'https://ip-api.com/json'
        ];

        for (let url of services) {
            try {
                const response = await fetch(url);
                if (response.ok) {
                    const data = await response.json();
                    return {
                        ip_address: data.ip || data.query || '',
                        country: data.country_name || data.country || 'Unknown',
                        region: data.region || data.regionName || 'Unknown',
                        city: data.city || 'Unknown'
                    };
                }
            } catch (e) {
                console.warn(`Geo IP lookup failed from ${url}, trying fallback...`);
            }
        }
        return { ip_address: '', country: 'Unknown', region: 'Unknown', city: 'Unknown' };
    }

    // Send session start payload
    async function initSession() {
        const geo = await fetchGeoIp();
        const payload = {
            session_id,
            recipient,
            ip_address: geo.ip_address,
            country: geo.country,
            region: geo.region,
            city: geo.city,
            browser: specs.browser,
            os: specs.os,
            device: specs.device
        };

        try {
            await fetch('/api/session/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        } catch (e) {
            console.error('Failed to log session start:', e);
        }
    }

    // Record when viewport transitions page focus
    function handleSectionChange(newSectionId) {
        const now = Date.now();
        
        if (activeSection && activeSectionEnterTime) {
            const timeSpent = (now - activeSectionEnterTime) / 1000; // in seconds
            if (timeSpent > 0.5) {
                sectionDurations[activeSection] += timeSpent;
                sectionHistory.push({
                    section_name: activeSection,
                    duration: timeSpent,
                    entered_at: new Date(activeSectionEnterTime).toISOString()
                });
            }
        }

        if (newSectionId) {
            activeSection = newSectionId;
            activeSectionEnterTime = now;
        } else {
            activeSection = null;
            activeSectionEnterTime = null;
        }
    }

    // Setup page observers relative to main browser viewport
    function setupIntersectionObserver() {
        const observerOptions = {
            root: null,
            rootMargin: '-5% 0px -5% 0px', // slightly inset boundaries to focus active page
            threshold: 0.35 // page must be 35% visible
        };

        const observer = new IntersectionObserver((entries) => {
            let mostVisibleEntry = null;
            let highestRatio = 0;

            entries.forEach(entry => {
                if (entry.isIntersecting && entry.intersectionRatio > highestRatio) {
                    highestRatio = entry.intersectionRatio;
                    mostVisibleEntry = entry;
                }
            });

            if (mostVisibleEntry) {
                const id = '#' + mostVisibleEntry.target.id;
                if (trackedSectionIds.includes(id) && activeSection !== id) {
                    handleSectionChange(id);
                }
            }
        }, observerOptions);

        trackedSectionIds.forEach(id => {
            const el = document.querySelector(id);
            if (el) observer.observe(el);
        });
    }

    // Calculate window scroll depth percentage
    function trackScrollDepth() {
        const winHeight = window.innerHeight;
        const docHeight = document.documentElement.scrollHeight;
        const scrollTop = window.scrollY || document.documentElement.scrollTop;
        
        if (docHeight > winHeight) {
            const scrollPercent = Math.round((scrollTop / (docHeight - winHeight)) * 100);
            if (scrollPercent > maxScrollDepth) {
                maxScrollDepth = scrollPercent;
            }
        }
    }

    // Capture standard document click interactions
    function trackClicks() {
        document.addEventListener('click', function(event) {
            let element = event.target;
            
            // Check if they clicked inside a page wrapper canvas
            if (element.tagName === 'CANVAS' && element.parentElement && element.parentElement.classList.contains('pdf-page-wrapper')) {
                const pageId = element.parentElement.id;
                const pageName = element.parentElement.getAttribute('data-page-name') || pageId;
                
                const payload = {
                    session_id,
                    element_id: pageId,
                    element_text: `Clicked ${pageName}`,
                    target_url: '',
                    clicked_at: new Date().toISOString()
                };
                
                fetch('/api/click', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }).catch(err => console.warn('Failed to log page click:', err));
                
                return;
            }

            let trackingAttr = null;
            
            while (element && element !== document) {
                trackingAttr = element.getAttribute('data-track-click');
                if (trackingAttr) break;
                if (element.tagName === 'BUTTON' || element.tagName === 'A') {
                    trackingAttr = (element.innerText || element.textContent || '').trim().substring(0, 30);
                    break;
                }
                element = element.parentElement;
            }

            if (trackingAttr && element) {
                const payload = {
                    session_id,
                    element_id: element.id || element.className || 'unnamed-element',
                    element_text: trackingAttr,
                    target_url: element.tagName === 'A' ? element.getAttribute('href') : '',
                    clicked_at: new Date().toISOString()
                };

                fetch('/api/click', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }).catch(err => console.warn('Failed to log click:', err));
            }
        });
    }

    // Get current update payload
    function getUpdatePayload(isFinal) {
        if (isFinal) {
            // Finalize the last active page duration on exit
            handleSectionChange(null); 
        }
        
        const totalDuration = (Date.now() - startTime) / 1000;
        const finalSectionHistory = [...sectionHistory];
        
        // Clear history that has been compiled for send
        sectionHistory.length = 0; 
        
        return {
            session_id,
            duration: totalDuration,
            max_scroll_depth: maxScrollDepth,
            section_views: finalSectionHistory
        };
    }

    function sendHeartbeat() {
        // Heartbeats do not finalize the active section to prevent split segments
        const payload = getUpdatePayload(false);

        fetch('/api/session/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).catch(e => console.warn('Heartbeat error:', e));
    }

    function sendFinalUpdate() {
        const payload = getUpdatePayload(true);
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        
        if (navigator.sendBeacon) {
            navigator.sendBeacon('/api/session/update', blob);
        } else {
            fetch('/api/session/update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                keepalive: true
            });
        }
    }

    // Main entry initialization exposed to window
    window.initializeTracker = function() {
        if (initialized) return;
        initialized = true;

        initSession().then(() => {
            setupIntersectionObserver();
            trackScrollDepth();
            
            // Listeners
            window.addEventListener('scroll', trackScrollDepth);
            trackClicks();

            // Heartbeats every 8 seconds
            heartbeatInterval = setInterval(sendHeartbeat, 8000);

            // Exit triggers
            window.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') {
                    sendFinalUpdate();
                }
            });

            window.addEventListener('beforeunload', () => {
                if (heartbeatInterval) clearInterval(heartbeatInterval);
                sendFinalUpdate();
            });
        });
    };

    // Auto fallback trigger if pdf loading script has issues
    window.addEventListener('load', () => {
        setTimeout(() => {
            if (!initialized) {
                console.log('PDF load timeout fallback: initializing tracker');
                window.initializeTracker();
            }
        }, 3000);
    });

})();
