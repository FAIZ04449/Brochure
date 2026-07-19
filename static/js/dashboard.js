document.addEventListener('DOMContentLoaded', () => {
    // Globals
    let campaignLogs = [];
    let globalPageChart = null;
    let globalClickChart = null;
    let modalChart = null;

    // Elements
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    const logsTableBody = document.getElementById('logs-table-body');
    const btnRefreshLogs = document.getElementById('btn-refresh-logs');
    
    // KPI elements
    const kpiLinks = document.getElementById('kpi-links');
    const kpiOpens = document.getElementById('kpi-opens');
    const kpiTime = document.getElementById('kpi-time');
    const kpiCtr = document.getElementById('kpi-ctr');
    
    // Forms
    const uploadForm = document.getElementById('upload-form');
    const addLinkForm = document.getElementById('add-link-form');
    const singleLinkForm = document.getElementById('single-link-form');
    const bulkLinkForm = document.getElementById('bulk-link-form');
    const brochureList = document.getElementById('brochure-list');
    const selectDocSingle = document.getElementById('select-doc-single');
    const selectDocBulk = document.getElementById('select-doc-bulk');
    
    // Outputs
    const linkOutputContainer = document.getElementById('link-output-container');
    const generatedUrlInput = document.getElementById('generated-url-input');
    const btnCopyUrl = document.getElementById('btn-copy-url');
    const copySuccessHint = document.getElementById('copy-success-hint');
    const bulkOutputPanel = document.getElementById('bulk-output-panel');
    const bulkCsvOutput = document.getElementById('bulk-csv-output');
    const btnCopyBulk = document.getElementById('btn-copy-bulk');
    const uploadFeedback = document.getElementById('upload-feedback');
    const addLinkFeedback = document.getElementById('add-link-feedback');
    
    // Filters
    const logSearchInput = document.getElementById('log-search-input');
    const logStatusFilter = document.getElementById('log-status-filter');
    const logSortFilter = document.getElementById('log-sort-filter');
    
    // Modal
    const timelineModal = document.getElementById('timeline-modal');
    const modalCloseBtn = document.getElementById('modal-close-btn');
    const modalRecipientTitle = document.getElementById('modal-recipient-title');
    const modalRecipientMeta = document.getElementById('modal-recipient-meta');
    const modalEngagementScore = document.getElementById('modal-engagement-score');
    const modalScoreEval = document.getElementById('modal-score-eval');
    const mKpiOpens = document.getElementById('m-kpi-opens');
    const mKpiDuration = document.getElementById('m-kpi-duration');
    const mKpiClicks = document.getElementById('m-kpi-clicks');
    const modalClicksList = document.getElementById('modal-clicks-list');
    const modalComponentList = document.getElementById('modal-component-list');
    const modalTimelineTimeline = document.getElementById('modal-timeline-timeline');

    // --- Tab Navigation ---
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            
            btn.classList.add('active');
            const targetTab = btn.getAttribute('data-tab');
            document.getElementById(`tab-${targetTab}`).classList.add('active');
            
            if (targetTab === 'overview' || targetTab === 'logs') {
                loadAnalyticsData();
            }
            // Charts were skipped if canvas wasn't visible on first load â€” render now
            if (targetTab === 'overview') {
                loadChartData();
            }
        });
    });

    // --- API Calls ---

    async function loadAnalyticsData() {
        // Phase 1: Fast data â€” KPIs, logs, documents (renders the page immediately)
        try {
            const response = await fetch('/api/admin/analytics');
            if (!response.ok) throw new Error('Failed to fetch analytics');
            const data = await response.json();
            
            kpiLinks.textContent = data.summary.total_links;
            kpiOpens.textContent = data.summary.total_opens;
            kpiTime.textContent = formatDuration(data.summary.avg_active_seconds);
            kpiCtr.textContent = `${data.summary.click_through_rate}%`;
            
            populateBrochureSelectors(data.documents);
            renderBrochureList(data.documents);
            
            campaignLogs = data.logs;
            renderLogsTable();
            
            const urlParams = new URLSearchParams(window.location.search);
            const linkIdParam = urlParams.get('link_id');
            if (linkIdParam) {
                window.history.replaceState({}, document.title, window.location.pathname);
                const matchedLog = campaignLogs.find(log => log.link_id == linkIdParam);
                if (matchedLog) {
                    openRecipientJourneyModal(matchedLog.link_id, matchedLog.recipient_name, matchedLog.recipient_company, matchedLog.recipient_email);
                }
            }
        } catch (err) {
            console.error('Error loading analytics:', err);
            if (logsTableBody) {
                logsTableBody.innerHTML = `
                    <tr>
                        <td colspan="7" class="text-center py-4 text-red">
                            <i class="fa-solid fa-triangle-exclamation"></i> Error loading campaign analytics.
                        </td>
                    </tr>
                `;
            }
        }

        // Phase 2: Chart data â€” loads separately, does NOT block Phase 1
        loadChartData();
    }

    async function loadChartData() {
        try {
            const response = await fetch('/api/admin/analytics/charts');
            if (!response.ok) return;
            const data = await response.json();
            renderGlobalCharts(data.global_page_stats, data.global_click_stats);
        } catch (err) {
            console.warn('Chart data load failed (non-critical):', err);
        }
    }

    // --- Render Helpers ---

    function getDocIcon(type) {
        if (type === 'pdf') return 'fa-file-pdf';
        if (type === 'video') return 'fa-video';
        if (type === 'link') return 'fa-link';
        return 'fa-file';
    }

    function getSelectedDocIds() {
        try {
            return JSON.parse(localStorage.getItem('selected_doc_ids')) || [];
        } catch (e) {
            return [];
        }
    }

    function saveSelectedDocIds() {
        const checkboxes = document.querySelectorAll('#global-doc-selection input[type="checkbox"]');
        const selectedIds = Array.from(checkboxes)
            .filter(cb => cb.checked)
            .map(cb => cb.value);
        localStorage.setItem('selected_doc_ids', JSON.stringify(selectedIds));
    }

    function populateBrochureSelectors(documents) {
        const globalDocSelection = document.getElementById('global-doc-selection');
        const selectedVals = getSelectedDocIds();
        globalDocSelection.innerHTML = '';
        
        if (documents.length === 0) {
            globalDocSelection.innerHTML = '<div class="doc-empty-state"><i class="fa-solid fa-folder-open"></i><span>No attachments yet. Upload a file or link in Step 1.</span></div>';
            return;
        }

        documents.forEach(doc => {
            const icon = getDocIcon(doc.doc_type);
            const row = document.createElement('div');
            row.className = 'doc-checklist-row';
            row.dataset.docId = doc.id;
            row.innerHTML = `
                <label class="doc-checklist-label">
                    <input type="checkbox" value="${doc.id}" ${selectedVals.includes(doc.id.toString()) ? 'checked' : ''}>
                    <i class="fa-solid ${icon} doc-type-icon"></i>
                    <span class="doc-name" title="${escapeHTML(doc.filename)}">${escapeHTML(doc.filename)}</span>
                </label>
                <button class="doc-delete-btn" data-doc-id="${doc.id}" title="Delete this document">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            `;
            globalDocSelection.appendChild(row);
        });

        // Save selected states on change
        globalDocSelection.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', saveSelectedDocIds);
        });

        // Wire up delete buttons
        globalDocSelection.querySelectorAll('.doc-delete-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const docId = btn.dataset.docId;
                const row = btn.closest('.doc-checklist-row');
                const docName = row.querySelector('.doc-name')?.textContent || 'this document';

                if (!confirm(`Delete "${docName}"? This cannot be undone.`)) return;

                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

                try {
                    const resp = await fetch(`/api/admin/document/${docId}`, { method: 'DELETE' });
                    if (resp.ok) {
                        row.style.transition = 'opacity 0.25s, transform 0.25s';
                        row.style.opacity = '0';
                        row.style.transform = 'translateX(8px)';
                        setTimeout(() => {
                            row.remove();
                            // Update selection list
                            saveSelectedDocIds();
                            // Show empty state if no rows remain
                            if (globalDocSelection.querySelectorAll('.doc-checklist-row').length === 0) {
                                globalDocSelection.innerHTML = '<div class="doc-empty-state"><i class="fa-solid fa-folder-open"></i><span>No attachments yet. Upload a file or link in Step 1.</span></div>';
                            }
                        }, 250);
                    } else {
                        const data = await resp.json();
                        alert(data.error || 'Failed to delete document.');
                        btn.disabled = false;
                        btn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
                    }
                } catch (err) {
                    alert('Connection error. Please try again.');
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
                }
            });
        });
    }

    function renderBrochureList(documents) {
        // brochure-list element was removed in the new layout â€” skip gracefully
        if (!brochureList) return;
        
        if (documents.length === 0) {
            brochureList.innerHTML = '<li class="loading-li" style="grid-column: 1 / -1;">No stored attachments. Upload one above.</li>';
            return;
        }
        
        brochureList.innerHTML = '';
        documents.forEach(doc => {
            const dateStr = new Date(doc.uploaded_at + 'Z').toLocaleDateString();
            const icon = getDocIcon(doc.doc_type);
            const li = document.createElement('li');
            li.innerHTML = `
                <div style="display:flex; flex-direction:column; background:var(--bg-secondary); padding:10px; border-radius:6px; border:1px solid var(--border-color);">
                    <span class="brochure-name" style="font-weight:600; font-size:0.9rem;"><i class="fa-solid ${icon}"></i> ${escapeHTML(doc.filename)}</span>
                    <span class="brochure-date" style="font-size:0.75rem; color:var(--text-muted); margin-top:5px;">Added ${dateStr}</span>
                </div>
            `;
            brochureList.appendChild(li);
        });
    }

    function renderGlobalCharts(pageStats, clickStats) {
        // Page Heatmap Chart
        const pageChartEl = document.getElementById('pageHeatmapChart');
        if (!pageChartEl) return;  // chart canvas not visible yet â€” skip
        const pageCtx = pageChartEl.getContext('2d');
        const sortedPageStats = [...pageStats].sort((a, b) => a.page_number - b.page_number);
        
        const pageLabels = sortedPageStats.map(s => `Page ${s.page_number}`);
        const pageDurations = sortedPageStats.map(s => s.total_duration);
        const pageViews = sortedPageStats.map(s => s.view_count);

        if (globalPageChart) globalPageChart.destroy();
        
        globalPageChart = new Chart(pageCtx, {
            type: 'bar',
            data: {
                labels: pageLabels,
                datasets: [{
                    label: 'Total Active Time (seconds)',
                    data: pageDurations,
                    backgroundColor: 'rgba(249, 115, 22, 0.65)',
                    borderColor: '#f97316',
                    borderWidth: 1,
                    borderRadius: 4
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            afterBody: (context) => {
                                const idx = context[0].dataIndex;
                                return `Unique Opens: ${pageViews[idx]}`;
                            }
                        }
                    }
                },
                scales: {
                    x: { grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#848995' } },
                    y: { grid: { display: false }, ticks: { color: '#848995' } }
                }
            }
        });

        // Click Interactions Chart
        const clickCtx = document.getElementById('clickInteractionsChart').getContext('2d');
        const clickLabels = clickStats.map(s => {
            const url = s.target_url;
            return url.length > 25 ? url.substring(0, 22) + '...' : url;
        });
        const clickCounts = clickStats.map(s => s.click_count);

        if (globalClickChart) globalClickChart.destroy();
        
        globalClickChart = new Chart(clickCtx, {
            type: 'bar',
            data: {
                labels: clickLabels,
                datasets: [{
                    label: 'Click Count',
                    data: clickCounts,
                    backgroundColor: 'rgba(139, 92, 246, 0.65)',
                    borderColor: '#8b5cf6',
                    borderWidth: 1,
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { display: false }, ticks: { color: '#848995' } },
                    y: { grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#848995', precision: 0 } }
                }
            }
        });
    }

    function renderLogsTable() {
        let filteredLogs = [...campaignLogs];
        
        const searchVal = logSearchInput.value.toLowerCase().trim();
        if (searchVal) {
            filteredLogs = filteredLogs.filter(log => 
                log.recipient_name.toLowerCase().includes(searchVal) ||
                log.recipient_email.toLowerCase().includes(searchVal) ||
                log.recipient_company.toLowerCase().includes(searchVal)
            );
        }
        
        const statusVal = logStatusFilter.value;
        const now = new Date();
        filteredLogs = filteredLogs.filter(log => {
            const isRevoked = !!log.revoked_at;
            let isExpired = false;
            if (log.expires_at) isExpired = new Date(log.expires_at + 'Z') < now;
            const isOpened = log.open_count > 0;
            
            if (statusVal === 'revoked') return isRevoked;
            if (statusVal === 'expired') return isExpired && !isRevoked;
            if (statusVal === 'never') return !isOpened && !isRevoked && !isExpired;
            if (statusVal === 'opened') return isOpened;
            if (statusVal === 'active') return !isRevoked && !isExpired;
            return true;
        });

        const sortVal = logSortFilter.value;
        if (sortVal === 'engaged') {
            filteredLogs.sort((a, b) => b.total_time_spent - a.total_time_spent);
        } else if (sortVal === 'views') {
            filteredLogs.sort((a, b) => b.open_count - a.open_count);
        } else {
            filteredLogs.sort((a, b) => new Date(b.sent_date + 'Z') - new Date(a.sent_date + 'Z'));
        }

        if (filteredLogs.length === 0) {
            logsTableBody.innerHTML = `<tr><td colspan="7" class="text-center py-4">No campaign records match the active filters.</td></tr>`;
            return;
        }

        logsTableBody.innerHTML = '';
        filteredLogs.forEach(log => {
            const tr = document.createElement('tr');
            
            let statusBadge = '<span class="status-badge status-active">Active</span>';
            const isRevoked = !!log.revoked_at;
            let isExpired = false;
            if (log.expires_at) isExpired = new Date(log.expires_at + 'Z') < now;
            
            if (isRevoked) statusBadge = '<span class="status-badge status-revoked">Revoked</span>';
            else if (isExpired) statusBadge = '<span class="status-badge status-expired">Expired</span>';
            else if (log.open_count === 0) statusBadge = '<span class="status-badge status-never">Never Opened</span>';

            const lastActivityHTML = log.last_activity 
                ? formatTimeAgo(log.last_activity)
                : '<span class="text-muted">Never</span>';

            tr.innerHTML = `
                <td>
                    <div class="recipient-cell">
                        <span class="r-name">${escapeHTML(log.recipient_name)}</span>
                        <span class="r-company-email">${escapeHTML(log.recipient_company)} &bull; ${escapeHTML(log.recipient_email)}</span>
                    </div>
                </td>
                <td><span class="doc-badge" style="font-size:0.8rem;"><i class="fa-solid fa-layer-group"></i> ${escapeHTML(log.document_name || 'Bundle')}</span></td>
                <td>${statusBadge}</td>
                <td class="text-center text-bold">${log.open_count}</td>
                <td class="text-bold">${formatDuration(log.total_time_spent)}</td>
                <td>${lastActivityHTML}</td>
                <td>
                    <div class="actions-cell">
                        <button class="btn btn-journey btn-table" data-link-id="${log.link_id}" data-name="${log.recipient_name}" data-company="${log.recipient_company}" data-email="${log.recipient_email}">
                            <i class="fa-solid fa-route"></i> Journey
                        </button>
                        ${!isRevoked ? `
                            <button class="btn btn-copy-link btn-table" data-token="${log.token}" style="background: rgba(66, 135, 245, 0.08); color: var(--accent-color); border: 1px solid rgba(66, 135, 245, 0.25);">
                                <i class="fa-solid fa-copy"></i> Copy Link
                            </button>
                            <button class="btn btn-revoke btn-table" data-token="${log.token}">
                                <i class="fa-solid fa-ban"></i> Revoke
                            </button>
                        ` : ''}
                    </div>
                </td>
            `;
            
            logsTableBody.appendChild(tr);
        });

        // Wire up copy buttons
        document.querySelectorAll('.btn-copy-link').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const token = btn.getAttribute('data-token');
                const linkUrl = `${window.location.origin}/v/${token}`;
                
                navigator.clipboard.writeText(linkUrl).then(() => {
                    const originalHTML = btn.innerHTML;
                    btn.innerHTML = '<i class="fa-solid fa-circle-check"></i> Copied!';
                    btn.style.background = 'rgba(16, 185, 129, 0.1)';
                    btn.style.color = '#10b981';
                    btn.style.borderColor = 'rgba(16, 185, 129, 0.3)';
                    
                    setTimeout(() => {
                        btn.innerHTML = originalHTML;
                        btn.style.background = '';
                        btn.style.color = '';
                        btn.style.borderColor = '';
                    }, 2000);
                }).catch(err => {
                    alert('Failed to copy link: ' + err);
                });
            });
        });

        document.querySelectorAll('.btn-journey').forEach(btn => {
            btn.addEventListener('click', () => {
                const linkId = btn.getAttribute('data-link-id');
                const name = btn.getAttribute('data-name');
                const company = btn.getAttribute('data-company');
                const email = btn.getAttribute('data-email');
                openRecipientJourneyModal(linkId, name, company, email);
            });
        });

        document.querySelectorAll('.btn-revoke').forEach(btn => {
            btn.addEventListener('click', async () => {
                const token = btn.getAttribute('data-token');
                if (confirm('Are you sure you want to revoke this outreach link immediately?')) {
                    await revokeLink(token);
                }
            });
        });
    }

    // --- Journey Modal Renderer ---

    async function openRecipientJourneyModal(linkId, name, company, email) {
        modalRecipientTitle.textContent = `${name} | Outreach Profile`;
        modalRecipientMeta.innerHTML = `<i class="fa-solid fa-building"></i> ${company} &bull; <i class="fa-solid fa-envelope"></i> ${email}`;
        
        modalTimelineTimeline.innerHTML = '<div class="text-center py-4"><i class="fa-solid fa-circle-notch fa-spin"></i> Fetching history timeline...</div>';
        modalClicksList.innerHTML = '<li>Loading clicks...</li>';
        modalComponentList.innerHTML = '<li>Loading components...</li>';
        
        modalEngagementScore.textContent = '--';
        modalScoreEval.textContent = 'Calculating...';
        modalScoreEval.className = 'score-badge';
        
        mKpiOpens.textContent = '-';
        mKpiDuration.textContent = '-';
        mKpiClicks.textContent = '-';

        timelineModal.classList.remove('hidden');

        try {
            const resp = await fetch(`/api/admin/recipient-details/${linkId}`);
            if (!resp.ok) throw new Error('Details fetch failed');
            const data = await resp.json();
            
            const sessions = data.sessions;
            const pageDurations = data.page_durations;
            const componentTimes = data.component_times;
            const clicks = data.clicks;

            mKpiOpens.textContent = sessions.length;
            
            const totalDurationSecs = sessions.reduce((acc, s) => acc + s.total_active_seconds, 0);
            mKpiDuration.textContent = formatDuration(totalDurationSecs);
            
            const outgoingClicks = clicks.filter(c => !c.target_url.startsWith('UI-Click'));
            mKpiClicks.textContent = outgoingClicks.length;

            let score = Math.round(Math.min(totalDurationSecs, 180) / 180 * 80);
            if (outgoingClicks.length > 0) score = Math.min(100, score + 20);
            
            modalEngagementScore.textContent = score;
            
            if (score >= 75) {
                modalScoreEval.textContent = 'ðŸ”¥ Hot Outreach Prospect';
                modalScoreEval.classList.add('hot');
            } else if (score >= 35) {
                modalScoreEval.textContent = 'âš¡ Medium Interest';
                modalScoreEval.classList.add('medium');
            } else {
                modalScoreEval.textContent = 'â„ï¸ Low Interaction';
                modalScoreEval.classList.add('cold');
            }

            populateComponentList(pageDurations, componentTimes);
            populateClicksList(clicks);
            buildCombinedTimeline(sessions);

        } catch (err) {
            console.error('Error loading journey profile:', err);
            modalTimelineTimeline.innerHTML = '<div class="text-center py-4 text-red">Failed to construct engagement timeline.</div>';
        }
    }

    function populateComponentList(pageDurations, componentTimes) {
        modalComponentList.innerHTML = '';
        
        const allItems = [];
        for (const [key, val] of Object.entries(pageDurations)) {
            allItems.push({ name: key, seconds: val });
        }
        for (const [key, val] of Object.entries(componentTimes)) {
            allItems.push({ name: key, seconds: val });
        }
        
        allItems.sort((a, b) => b.seconds - a.seconds);
        
        if (allItems.length === 0) {
            modalComponentList.innerHTML = '<li class="empty-li">No specific component activity logged yet.</li>';
            return;
        }
        
        allItems.forEach(item => {
            const li = document.createElement('li');
            li.innerHTML = `
                <span class="click-url" style="color:var(--text-light); font-weight:500;">${escapeHTML(item.name)}</span>
                <span class="click-time" style="background: rgba(255,255,255,0.1); padding: 2px 8px; border-radius: 12px; font-size: 0.8rem;">
                    <i class="fa-solid fa-clock"></i> ${formatDuration(item.seconds)}
                </span>
            `;
            li.style.display = 'flex';
            li.style.justifyContent = 'space-between';
            li.style.alignItems = 'center';
            modalComponentList.appendChild(li);
        });
    }

    function populateClicksList(clicks) {
        const outgoing = clicks.filter(c => !c.target_url.startsWith('UI-Click'));
        if (outgoing.length === 0) {
            modalClicksList.innerHTML = '<li class="empty-li">No external hyperlinks clicked.</li>';
            return;
        }
        
        modalClicksList.innerHTML = '';
        outgoing.forEach(c => {
            const dateStr = new Date(c.clicked_at + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const docLabel = c.filename ? `[${escapeHTML(c.filename)}] ` : '';
            const li = document.createElement('li');
            li.innerHTML = `
                <span class="click-time">${dateStr}</span>
                <span class="click-url">${docLabel}<a href="${c.target_url}" target="_blank">${escapeHTML(c.target_url)}</a></span>
            `;
            modalClicksList.appendChild(li);
        });
    }

    async function buildCombinedTimeline(sessions) {
        modalTimelineTimeline.innerHTML = '';
        
        if (sessions.length === 0) {
            modalTimelineTimeline.innerHTML = '<div class="text-center py-4">No logged session visits.</div>';
            return;
        }

        try {
            const promises = sessions.map(s => fetch(`/api/admin/timeline/${s.id}`).then(r => r.json()));
            const timelinesData = await Promise.all(promises);
            
            let allEvents = [];
            timelinesData.forEach(d => {
                if (d.timeline) allEvents.push(...d.timeline);
            });
            
            allEvents.sort((a, b) => new Date(a.timestamp + (a.timestamp.endsWith('Z')?'':'Z')) - new Date(b.timestamp + (b.timestamp.endsWith('Z')?'':'Z')));
            
            if (allEvents.length === 0) {
                modalTimelineTimeline.innerHTML = '<div class="text-center py-4">No events found.</div>';
                return;
            }

            allEvents.forEach((item, index) => {
                const el = document.createElement('div');
                el.className = 'timeline-item';
                
                const timeUTC = new Date(item.timestamp + (item.timestamp.endsWith('Z') ? '' : 'Z'));
                const dateStr = timeUTC.toLocaleDateString() + ' ' + timeUTC.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                
                let typeClass = item.type;
                let icon = 'fa-circle-dot';
                if (item.type === 'start') {
                    icon = 'fa-door-open';
                } else if (item.type === 'page') {
                    icon = 'fa-book-open';
                } else if (item.type === 'component') {
                    icon = 'fa-window-maximize';
                } else if (item.type === 'click') {
                    if (item.description.includes('UI-Click')) {
                        icon = 'fa-computer-mouse';
                        typeClass = 'ui-click';
                    } else {
                        icon = 'fa-arrow-up-right-from-square';
                    }
                }

                el.innerHTML = `
                    <div class="timeline-badge ${typeClass}"><i class="fa-solid ${icon}"></i></div>
                    <div class="timeline-content">
                        <p class="timeline-desc">${escapeHTML(item.description)}</p>
                        <span class="timeline-time">${dateStr}</span>
                    </div>
                `;
                
                modalTimelineTimeline.appendChild(el);
            });
            
        } catch (e) {
            console.error('Failed to merge timelines:', e);
            modalTimelineTimeline.innerHTML = '<div class="text-center py-4 text-red">Error building timeline logs.</div>';
        }
    }

    // --- UI Interactions ---

    // Outreach panel tab buttons (.otab-btn)
    document.querySelectorAll('.otab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const parentNav = btn.closest('.otab-nav');
            if (!parentNav) return;
            const parentContainer = parentNav.nextElementSibling;

            parentNav.querySelectorAll('.otab-btn').forEach(b => b.classList.remove('active'));
            parentContainer.querySelectorAll('.otab-pane').forEach(p => p.classList.remove('active'));

            btn.classList.add('active');
            const targetPane = document.getElementById(btn.dataset.target);
            if (targetPane) targetPane.classList.add('active');
        });
    });

    // â”€â”€ File selection indicator â”€â”€
    const pdfFileInput      = document.getElementById('pdf-file');
    const fileSelectedPill  = document.getElementById('file-selected-name');
    const fileSelectedLabel = document.getElementById('file-selected-label');
    const fileClearBtn      = document.getElementById('file-clear-btn');
    const fileDropText      = document.getElementById('file-drop-text');
    const fileDropIcon      = document.getElementById('file-drop-icon');

    if (pdfFileInput) {
        pdfFileInput.addEventListener('change', () => {
            const file = pdfFileInput.files[0];
            if (file) {
                fileSelectedLabel.textContent = file.name;
                fileSelectedPill.classList.remove('hidden');
                // Update drop zone to confirm selection
                fileDropText.textContent = 'File selected â€” click to change';
                fileDropIcon.className = 'fa-solid fa-circle-check';
                fileDropIcon.style.color = 'var(--success-color)';
            }
        });
    }

    if (fileClearBtn) {
        fileClearBtn.addEventListener('click', () => {
            pdfFileInput.value = '';
            fileSelectedPill.classList.add('hidden');
            fileDropText.textContent = 'Choose a PDF or MP4';
            fileDropIcon.className = 'fa-solid fa-cloud-arrow-up';
            fileDropIcon.style.color = '';
        });
    }

    // --- Action Submits ---

    async function revokeLink(token) {
        try {
            const resp = await fetch('/api/admin/revoke-link', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: token })
            });
            if (resp.ok) loadAnalyticsData();
            else alert('Failed to revoke link. Please try again.');
        } catch (e) { console.error(e); }
    }

    uploadForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fileInput = document.getElementById('pdf-file');
        const file = fileInput.files[0];
        if (!file) return;

        const formData = new FormData();
        formData.append('file', file);

        uploadFeedback.classList.add('hidden');
        const progressContainer = document.getElementById('upload-progress-container');
        const progressBar = document.getElementById('upload-progress-bar');
        const progressText = document.getElementById('upload-progress-text');
        
        progressContainer.classList.remove('hidden');
        progressBar.style.width = '0%';
        progressText.textContent = '0%';

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/admin/upload', true);

        xhr.upload.onprogress = function(e) {
            if (e.lengthComputable) {
                const percent = Math.round((e.loaded / e.total) * 100);
                progressBar.style.width = percent + '%';
                progressText.textContent = percent + '%';
            }
        };

        xhr.onload = function() {
            progressContainer.classList.add('hidden');
            uploadFeedback.classList.remove('hidden', 'success', 'error');
            
            if (xhr.status >= 200 && xhr.status < 300) {
                const data = JSON.parse(xhr.responseText);
                uploadFeedback.textContent = `Success! Stored '${data.filename}'.`;
                uploadFeedback.classList.add('success');
                uploadForm.reset();
                // Reset the file selector pill
                if (fileSelectedPill)  fileSelectedPill.classList.add('hidden');
                if (fileDropText)      fileDropText.textContent = 'Choose a PDF or MP4';
                if (fileDropIcon)      { fileDropIcon.className = 'fa-solid fa-cloud-arrow-up'; fileDropIcon.style.color = ''; }
                loadAnalyticsData();
            } else {
                let errText = 'Upload failed.';
                try { errText = JSON.parse(xhr.responseText).error || errText; } catch(e){}
                uploadFeedback.textContent = errText;
                uploadFeedback.classList.add('error');
            }
        };

        xhr.onerror = function() {
            progressContainer.classList.add('hidden');
            uploadFeedback.classList.remove('hidden', 'success', 'error');
            uploadFeedback.textContent = 'Connection error uploading.';
            uploadFeedback.classList.add('error');
        };

        xhr.send(formData);
    });

    addLinkForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('ext-link-name').value;
        const url = document.getElementById('ext-link-url').value;
        
        addLinkFeedback.classList.remove('hidden', 'success', 'error');
        addLinkFeedback.textContent = 'Adding external link...';
        
        try {
            const response = await fetch('/api/admin/add-link-doc', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, url })
            });
            
            const data = await response.json();
            if (response.ok) {
                addLinkFeedback.textContent = `Success! Added link '${data.filename}'.`;
                addLinkFeedback.classList.add('success');
                addLinkForm.reset();
                loadAnalyticsData();
            } else {
                addLinkFeedback.textContent = data.error || 'Failed to add link.';
                addLinkFeedback.classList.add('error');
            }
        } catch (err) {
            addLinkFeedback.textContent = 'Connection error.';
            addLinkFeedback.classList.add('error');
        }
    });

    function getSelectedOptions(containerEl) {
        const checkboxes = containerEl.querySelectorAll('input[type="checkbox"]:checked');
        return checkboxes ? Array.from(checkboxes).map(cb => cb.value) : [];
    }

    singleLinkForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const globalDocSelection = document.getElementById('global-doc-selection');
        const docIds = getSelectedOptions(globalDocSelection);
        if (docIds.length === 0) {
            alert('Please select at least one attachment.');
            return;
        }
        
        const name = document.getElementById('recipient-name').value;
        const email = document.getElementById('recipient-email').value;
        const company = document.getElementById('recipient-company').value;
        const expiresDays = document.getElementById('link-expiry-days').value;
        
        linkOutputContainer.classList.add('hidden');
        copySuccessHint.classList.add('hidden');
        
        try {
            const response = await fetch('/api/admin/generate-link', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    document_ids: docIds,
                    name: name,
                    email: email,
                    company: company,
                    expires_days: expiresDays || null
                })
            });
            
            const data = await response.json();
            if (response.ok) {
                generatedUrlInput.value = data.url;
                linkOutputContainer.classList.remove('hidden');
                singleLinkForm.reset();
                loadAnalyticsData();
            } else {
                alert(data.error || 'Failed to generate link');
            }
        } catch (err) {
            alert('Failed to generate tracking link. Check connection.');
        }
    });

    bulkLinkForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const globalDocSelection = document.getElementById('global-doc-selection');
        const docIds = getSelectedOptions(globalDocSelection);
        if (docIds.length === 0) {
            alert('Please select at least one attachment.');
            return;
        }
        
        const csvText = document.getElementById('bulk-csv-input').value;
        const expiresDays = document.getElementById('bulk-expiry-days').value;
        
        bulkOutputPanel.classList.add('hidden');
        
        try {
            const response = await fetch('/api/admin/bulk-generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    document_ids: docIds,
                    csv_text: csvText,
                    expires_days: expiresDays || null
                })
            });
            
            const data = await response.json();
            if (response.ok) {
                bulkCsvOutput.value = data.csv_output;
                bulkOutputPanel.classList.remove('hidden');
                bulkLinkForm.reset();
                loadAnalyticsData();
            } else {
                alert(data.error || 'Bulk generation error');
            }
        } catch (err) {
            alert('Bulk link generation failed.');
        }
    });

    // --- Copy and Dialog Triggers ---

    btnCopyUrl.addEventListener('click', () => {
        generatedUrlInput.select();
        document.execCommand('copy');
        copySuccessHint.classList.remove('hidden');
        setTimeout(() => copySuccessHint.classList.add('hidden'), 3000);
    });

    btnCopyBulk.addEventListener('click', () => {
        bulkCsvOutput.select();
        document.execCommand('copy');
        alert('Copied outreach CSV text to clipboard!');
    });

    btnRefreshLogs.addEventListener('click', loadAnalyticsData);
    
    logSearchInput.addEventListener('input', renderLogsTable);
    logStatusFilter.addEventListener('change', renderLogsTable);
    logSortFilter.addEventListener('change', renderLogsTable);

    modalCloseBtn.addEventListener('click', () => {
        timelineModal.classList.add('hidden');
        if (modalChart) modalChart.destroy();
    });

    window.addEventListener('click', (e) => {
        if (e.target === timelineModal) {
            timelineModal.classList.add('hidden');
            if (modalChart) modalChart.destroy();
        }
    });

    // --- UTILS ---

    function formatDuration(seconds) {
        if (!seconds || seconds <= 0) return '0s';
        if (seconds < 60) return `${Math.round(seconds)}s`;
        const m = Math.floor(seconds / 60);
        const s = Math.round(seconds % 60);
        return `${m}m ${s}s`;
    }

    function formatTimeAgo(isoString) {
        const utcDate = new Date(isoString + (isoString.endsWith('Z') ? '' : 'Z'));
        const seconds = Math.floor((new Date() - utcDate) / 1000);
        if (seconds < 60) return 'Just now';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    }

    function escapeHTML(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;')
                  .replace(/'/g, '&#039;');
    }
});
