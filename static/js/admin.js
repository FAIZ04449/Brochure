document.addEventListener('DOMContentLoaded', () => {
    
    // UI elements
    const kpiOpens = document.getElementById('kpi-opens');
    const kpiTime = document.getElementById('kpi-time');
    const kpiScroll = document.getElementById('kpi-scroll');
    const kpiClicks = document.getElementById('kpi-clicks');
    
    const sessionsTableBody = document.getElementById('sessions-table-body');
    const btnRefresh = document.getElementById('btn-refresh');
    
    const timelineModal = document.getElementById('timeline-modal');
    const modalCloseBtn = document.getElementById('modal-close-btn');
    const modalRecipient = document.getElementById('modal-recipient');
    const modalSessionId = document.getElementById('modal-session-id');
    const journeyTimeline = document.getElementById('journey-timeline');

    // Chart instances
    let scrollChart = null;
    let clickChart = null;

    // Fetch and populate all dashboard data
    async function loadDashboardData() {
        try {
            const response = await fetch('/api/analytics');
            if (!response.ok) throw new Error('Failed to fetch analytics');
            
            const data = await response.json();
            
            // 1. Populate KPIs
            kpiOpens.innerText = data.summary.total_opens;
            kpiTime.innerText = formatDuration(data.summary.avg_duration);
            kpiScroll.innerText = data.summary.avg_scroll + '%';
            kpiClicks.innerText = data.summary.total_clicks;
            
            // 2. Render Charts
            renderScrollChart(data.sections);
            renderClickChart(data.clicks);
            
            // 3. Render Table
            renderSessionsTable(data.sessions);
            
        } catch (e) {
            console.error('Error loading dashboard analytics:', e);
            sessionsTableBody.innerHTML = `
                <tr>
                    <td colspan="8" class="text-center py-4 text-red">
                        <i class="fa-solid fa-triangle-exclamation"></i> Error loading tracking data.
                    </td>
                </tr>
            `;
        }
    }

    // Helper: format duration in seconds to readably mm:ss or ss
    function formatDuration(seconds) {
        if (!seconds || seconds <= 0) return '0s';
        if (seconds < 60) return Math.round(seconds) + 's';
        
        const m = Math.floor(seconds / 60);
        const s = Math.round(seconds % 60);
        return `${m}m ${s}s`;
    }

    // Render Scroll Heatmap Horizontal Bar Chart
    function renderScrollChart(sections) {
        const ctx = document.getElementById('scrollHeatmapChart').getContext('2d');
        
        // Sort pages sequentially (e.g. #page-1, #page-2...)
        const sortedSections = [...sections].sort((a, b) => a.section_name.localeCompare(b.section_name));

        // Map labels to readable titles
        const cleanLabels = sortedSections.map(s => {
            const name = s.section_name.replace('#', '');
            return name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        });
        const durations = sortedSections.map(s => s.total_duration);
        const viewCounts = sortedSections.map(s => s.view_count);

        if (scrollChart) {
            scrollChart.destroy();
        }

        scrollChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: cleanLabels,
                datasets: [{
                    label: 'Total Active Time (seconds)',
                    data: durations,
                    backgroundColor: 'rgba(249, 115, 22, 0.65)',
                    borderColor: '#f97316',
                    borderWidth: 1,
                    borderRadius: 4
                }]
            },
            options: {
                indexAxis: 'y', // horizontal bar chart
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            afterBody: function(context) {
                                const idx = context[0].dataIndex;
                                return `Unique Views: ${viewCounts[idx]}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        ticks: { color: '#94a3b8' }
                    },
                    y: {
                        grid: { display: false },
                        ticks: { color: '#94a3b8' }
                    }
                }
            }
        });
    }

    // Render Click Interactions Bar Chart
    function renderClickChart(clicks) {
        const ctx = document.getElementById('clickInteractionsChart').getContext('2d');
        const labels = clicks.map(c => c.element_text);
        const counts = clicks.map(c => c.click_count);

        if (clickChart) {
            clickChart.destroy();
        }

        clickChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Click Count',
                    data: counts,
                    backgroundColor: 'rgba(139, 92, 246, 0.65)',
                    borderColor: '#8b5cf6',
                    borderWidth: 1,
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { 
                            color: '#94a3b8',
                            callback: function(val, index) {
                                // Shorten long labels
                                const label = this.getLabelForValue(val);
                                return label.length > 15 ? label.substring(0, 12) + '...' : label;
                            }
                        }
                    },
                    y: {
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        ticks: { 
                            color: '#94a3b8',
                            precision: 0 
                        }
                    }
                }
            }
        });
    }

    // Render Access Log Table
    function renderSessionsTable(sessions) {
        if (!sessions || sessions.length === 0) {
            sessionsTableBody.innerHTML = `
                <tr>
                    <td colspan="8" class="text-center py-4">
                        No active sessions recorded yet. Send brochure links containing ?email=user@company.com to track.
                    </td>
                </tr>
            `;
            return;
        }

        sessionsTableBody.innerHTML = '';
        
        sessions.forEach(s => {
            const tr = document.createElement('tr');
            
            // Format Location
            const location = s.city && s.country ? `${s.city}, ${s.country}` : 'Unknown Location';
            
            // Format Device
            const deviceIcon = s.device === 'Mobile' ? 'fa-mobile-screen-button' : 
                               s.device === 'Tablet' ? 'fa-tablet-screen-button' : 'fa-desktop';
            const deviceHTML = `<span class="badge-device"><i class="fa-solid ${deviceIcon}"></i> ${s.os}</span>`;
            
            // Format Scroll Depth
            const scrollHTML = `
                <div class="depth-container">
                    <span class="text-bold">${Math.round(s.max_scroll_depth)}%</span>
                    <div class="depth-bar-bg">
                        <div class="depth-bar-fill" style="width: ${s.max_scroll_depth}%"></div>
                    </div>
                </div>
            `;
            
            // Format Date (locally readable)
            const dateUTC = new Date(s.created_at + 'Z');
            const dateHTML = dateUTC.toLocaleDateString() + ' ' + dateUTC.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            tr.innerHTML = `
                <td class="text-bold">${s.recipient}</td>
                <td><i class="fa-solid fa-location-dot icon-blue" style="font-size:0.8rem"></i> ${location}</td>
                <td>${deviceHTML}</td>
                <td class="text-bold">${formatDuration(s.duration)}</td>
                <td class="scroll-depth-cell">${scrollHTML}</td>
                <td class="text-center text-bold">${s.click_count}</td>
                <td>${dateHTML}</td>
                <td>
                    <button class="btn-action" data-session-id="${s.session_id}" data-recipient="${s.recipient}">
                        <i class="fa-solid fa-route"></i> Journey
                    </button>
                </td>
            `;
            
            sessionsTableBody.appendChild(tr);
        });

        // Add event listeners to newly created Journey buttons
        document.querySelectorAll('.btn-action').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const sId = btn.getAttribute('data-session-id');
                const recipient = btn.getAttribute('data-recipient');
                openTimelineModal(sId, recipient);
            });
        });
    }

    // Modal Operations: fetch chronological user timeline details
    async function openTimelineModal(sessionId, recipient) {
        modalRecipient.innerText = `Journey for: ${recipient}`;
        modalSessionId.innerText = `Session ID: ${sessionId}`;
        journeyTimeline.innerHTML = '<div class="text-center py-4"><i class="fa-solid fa-spinner fa-spin"></i> Retrieving recipient records...</div>';
        
        timelineModal.classList.remove('hidden');

        try {
            const response = await fetch(`/api/analytics/timeline/${sessionId}`);
            if (!response.ok) throw new Error('Timeline fetch failed');
            const data = await response.json();
            
            renderTimeline(data.timeline);
            
        } catch (e) {
            console.error('Error rendering timeline:', e);
            journeyTimeline.innerHTML = '<div class="text-center py-4 text-red">Failed to reconstruct recipient path.</div>';
        }
    }

    function renderTimeline(timeline) {
        if (!timeline || timeline.length === 0) {
            journeyTimeline.innerHTML = '<div class="text-center py-4">No logged interactions.</div>';
            return;
        }

        journeyTimeline.innerHTML = '';
        
        timeline.forEach(item => {
            const div = document.createElement('div');
            div.className = 'timeline-item';
            
            const timestampUTC = new Date(item.timestamp + (item.timestamp.endsWith('Z') ? '' : 'Z'));
            const dateStr = timestampUTC.toLocaleDateString() + ' ' + timestampUTC.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            
            const relativeTimeStr = item.relative_sec === 0 ? 'Start' : `+${formatDuration(item.relative_sec)}`;

            div.innerHTML = `
                <div class="timeline-badge ${item.type}"></div>
                <div class="timeline-time">${relativeTimeStr}</div>
                <div class="timeline-desc">${item.description}</div>
                <div class="timeline-date">${dateStr}</div>
            `;
            
            journeyTimeline.appendChild(div);
        });
    }

    // Modal Close operations
    modalCloseBtn.addEventListener('click', () => {
        timelineModal.classList.add('hidden');
    });

    window.addEventListener('click', (e) => {
        if (e.target === timelineModal) {
            timelineModal.classList.add('hidden');
        }
    });

    // Refresh and Auto load loop
    btnRefresh.addEventListener('click', loadDashboardData);
    
    // Initial Load
    loadDashboardData();
    
    // Periodic Auto-refresh (every 10 seconds for real-time visual feel)
    setInterval(loadDashboardData, 10000);
});
