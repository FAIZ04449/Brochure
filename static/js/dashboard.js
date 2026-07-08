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
        });
    });

    // --- API Calls ---

    async function loadAnalyticsData() {
        try {
            const response = await fetch('/api/admin/analytics');
            if (!response.ok) throw new Error('Failed to fetch analytics');
            const data = await response.json();
            
            // 1. Populate KPIs
            kpiLinks.textContent = data.summary.total_links;
            kpiOpens.textContent = data.summary.total_opens;
            kpiTime.textContent = formatDuration(data.summary.avg_active_seconds);
            kpiCtr.textContent = `${data.summary.click_through_rate}%`;
            
            // 2. Populate Brochure Selectors
            populateBrochureSelectors(data.documents);
            renderBrochureList(data.documents);
            
            // 3. Render Global Charts
            renderGlobalCharts(data.global_page_stats, data.global_click_stats);
            
            // 4. Save campaign logs & render
            campaignLogs = data.logs;
            renderLogsTable();
            
            // Check if ?link_id=X is present in URL and automatically trigger journey modal
            const urlParams = new URLSearchParams(window.location.search);
            const linkIdParam = urlParams.get('link_id');
            if (linkIdParam) {
                // Clear the parameter from the URL address bar cleanly
                window.history.replaceState({}, document.title, window.location.pathname);
                
                const matchedLog = campaignLogs.find(log => log.link_id == linkIdParam);
                if (matchedLog) {
                    openRecipientJourneyModal(matchedLog.link_id, matchedLog.recipient_name, matchedLog.recipient_company, matchedLog.recipient_email);
                }
            }
            
        } catch (err) {
            console.error('Error loading analytics:', err);
            logsTableBody.innerHTML = `
                <tr>
                    <td colspan="8" class="text-center py-4 text-red">
                        <i class="fa-solid fa-triangle-exclamation"></i> Error loading campaign analytics.
                    </td>
                </tr>
            `;
        }
    }

    // --- Render Helpers ---

    function populateBrochureSelectors(documents) {
        // Keep selected values if any
        const valSingle = selectDocSingle.value;
        const valBulk = selectDocBulk.value;
        
        selectDocSingle.innerHTML = '<option value="" disabled selected>Select brochure...</option>';
        selectDocBulk.innerHTML = '<option value="" disabled selected>Select brochure...</option>';
        
        documents.forEach(doc => {
            const opt1 = document.createElement('option');
            opt1.value = doc.id;
            opt1.textContent = doc.filename;
            selectDocSingle.appendChild(opt1);
            
            const opt2 = document.createElement('option');
            opt2.value = doc.id;
            opt2.textContent = doc.filename;
            selectDocBulk.appendChild(opt2);
        });
        
        if (valSingle) selectDocSingle.value = valSingle;
        if (valBulk) selectDocBulk.value = valBulk;
    }

    function renderBrochureList(documents) {
        if (documents.length === 0) {
            brochureList.innerHTML = '<li class="loading-li">No stored brochures. Upload one above.</li>';
            return;
        }
        
        brochureList.innerHTML = '';
        documents.forEach(doc => {
            const dateStr = new Date(doc.uploaded_at + 'Z').toLocaleDateString();
            const li = document.createElement('li');
            li.innerHTML = `
                <span class="brochure-name"><i class="fa-solid fa-file-pdf"></i> ${doc.filename}</span>
                <span class="brochure-date">Uploaded ${dateStr}</span>
            `;
            brochureList.appendChild(li);
        });
    }

    function renderGlobalCharts(pageStats, clickStats) {
        // 1. Page Heatmap Chart
        const pageCtx = document.getElementById('pageHeatmapChart').getContext('2d');
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
                    x: {
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        ticks: { color: '#848995' }
                    },
                    y: {
                        grid: { display: false },
                        ticks: { color: '#848995' }
                    }
                }
            }
        });

        // 2. Click Interactions Chart
        const clickCtx = document.getElementById('clickInteractionsChart').getContext('2d');
        const clickLabels = clickStats.map(s => {
            // Trim long URLs
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
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { color: '#848995' }
                    },
                    y: {
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        ticks: { color: '#848995', precision: 0 }
                    }
                }
            }
        });
    }

    function renderLogsTable() {
        let filteredLogs = [...campaignLogs];
        
        // 1. Search filter
        const searchVal = logSearchInput.value.toLowerCase().strip();
        if (searchVal) {
            filteredLogs = filteredLogs.filter(log => 
                log.recipient_name.toLowerCase().includes(searchVal) ||
                log.recipient_email.toLowerCase().includes(searchVal) ||
                log.recipient_company.toLowerCase().includes(searchVal)
            );
        }
        
        // 2. Status filter
        const statusVal = logStatusFilter.value;
        const now = new Date();
        filteredLogs = filteredLogs.filter(log => {
            const isRevoked = !!log.revoked_at;
            let isExpired = false;
            if (log.expires_at) {
                isExpired = new Date(log.expires_at + 'Z') < now;
            }
            const isOpened = log.open_count > 0;
            
            if (statusVal === 'revoked') return isRevoked;
            if (statusVal === 'expired') return isExpired && !isRevoked;
            if (statusVal === 'never') return !isOpened && !isRevoked && !isExpired;
            if (statusVal === 'opened') return isOpened;
            if (statusVal === 'active') return !isRevoked && !isExpired;
            return true; // all
        });

        // 3. Sort filter
        const sortVal = logSortFilter.value;
        if (sortVal === 'engaged') {
            filteredLogs.sort((a, b) => b.total_time_spent - a.total_time_spent);
        } else if (sortVal === 'views') {
            filteredLogs.sort((a, b) => b.open_count - a.open_count);
        } else {
            // recent
            filteredLogs.sort((a, b) => new Date(b.sent_date + 'Z') - new Date(a.sent_date + 'Z'));
        }

        // Render Table Body
        if (filteredLogs.length === 0) {
            logsTableBody.innerHTML = `
                <tr>
                    <td colspan="8" class="text-center py-4">
                        No campaign records match the active filters.
                    </td>
                </tr>
            `;
            return;
        }

        logsTableBody.innerHTML = '';
        filteredLogs.forEach(log => {
            const tr = document.createElement('tr');
            
            // Link Status calculation
            let statusBadge = '<span class="status-badge status-active">Active</span>';
            const isRevoked = !!log.revoked_at;
            let isExpired = false;
            if (log.expires_at) {
                isExpired = new Date(log.expires_at + 'Z') < now;
            }
            
            if (isRevoked) {
                statusBadge = '<span class="status-badge status-revoked">Revoked</span>';
            } else if (isExpired) {
                statusBadge = '<span class="status-badge status-expired">Expired</span>';
            } else if (log.open_count === 0) {
                statusBadge = '<span class="status-badge status-never">Never Opened</span>';
            }

            // Completion percentage estimation (assuming 4 page brochure default)
            const completionPct = log.open_count > 0 
                ? Math.round((log.unique_pages_viewed / 4.0) * 100) 
                : 0;

            const completionHTML = log.open_count > 0 ? `
                <div class="depth-container">
                    <span class="text-bold">${completionPct}%</span>
                    <div class="depth-bar-bg">
                        <div class="depth-bar-fill" style="width: ${Math.min(completionPct, 100)}%"></div>
                    </div>
                    <span class="depth-detail">${log.unique_pages_viewed}/4 pgs</span>
                </div>
            ` : '<span class="text-muted">-</span>';

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
                <td><span class="doc-badge"><i class="fa-solid fa-file-pdf"></i> ${escapeHTML(log.document_name)}</span></td>
                <td>${statusBadge}</td>
                <td class="text-center text-bold">${log.open_count}</td>
                <td class="text-bold">${formatDuration(log.total_time_spent)}</td>
                <td>${completionHTML}</td>
                <td>${lastActivityHTML}</td>
                <td>
                    <div class="actions-cell">
                        <button class="btn btn-journey btn-table" data-link-id="${log.link_id}" data-name="${log.recipient_name}" data-company="${log.recipient_company}" data-email="${log.recipient_email}">
                            <i class="fa-solid fa-route"></i> Journey
                        </button>
                        ${!isRevoked ? `
                            <button class="btn btn-revoke btn-table" data-token="${log.token}">
                                <i class="fa-solid fa-ban"></i> Revoke
                            </button>
                        ` : ''}
                    </div>
                </td>
            `;
            
            logsTableBody.appendChild(tr);
        });

        // Register table event listeners
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
                if (confirm('Are you sure you want to revoke this outreach link immediately? The recipient will no longer be able to open the document.')) {
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
        modalEngagementScore.textContent = '--';
        modalScoreEval.textContent = 'Calculating...';
        modalScoreEval.className = 'score-badge';
        
        mKpiOpens.textContent = '-';
        mKpiDuration.textContent = '-';
        mKpiClicks.textContent = '-';

        if (modalChart) modalChart.destroy();

        timelineModal.classList.remove('hidden');

        try {
            const resp = await fetch(`/api/admin/recipient-details/${linkId}`);
            if (!resp.ok) throw new Error('Details fetch failed');
            const data = await resp.json();
            
            const sessions = data.sessions;
            const pageDurations = data.page_durations;
            const clicks = data.clicks;

            mKpiOpens.textContent = sessions.length;
            
            const totalDurationSecs = sessions.reduce((acc, s) => acc + s.total_active_seconds, 0);
            mKpiDuration.textContent = formatDuration(totalDurationSecs);
            
            // Filter UI clicks out of outgoing clicks KPI
            const outgoingClicks = clicks.filter(c => !c.target_url.startsWith('UI-Click'));
            mKpiClicks.textContent = outgoingClicks.length;

            // Compute Engagement Score
            const pagesViewed = Object.keys(pageDurations).length;
            const brochurePagesCount = 4; // default sample
            const completionPct = Math.min(100, Math.round((pagesViewed / brochurePagesCount) * 100));
            
            let score = Math.round((completionPct * 0.6) + (Math.min(totalDurationSecs, 180) / 180 * 30));
            if (outgoingClicks.length > 0) score = Math.min(100, score + 10);
            
            modalEngagementScore.textContent = score;
            
            if (score >= 75) {
                modalScoreEval.textContent = '🔥 Hot Outreach Prospect';
                modalScoreEval.classList.add('hot');
            } else if (score >= 35) {
                modalScoreEval.textContent = '⚡ Medium Interest';
                modalScoreEval.classList.add('medium');
            } else {
                modalScoreEval.textContent = '❄️ Low Interaction';
                modalScoreEval.classList.add('cold');
            }

            // Render Page Durations Chart
            renderRecipientChart(pageDurations);

            // Populate Clicks List
            populateClicksList(clicks);

            // Populate Timelines (Fetch full step journeys for all sessions)
            buildCombinedTimeline(sessions);

        } catch (err) {
            console.error('Error loading journey profile:', err);
            modalTimelineTimeline.innerHTML = '<div class="text-center py-4 text-red">Failed to construct engagement timeline.</div>';
        }
    }

    function renderRecipientChart(durations) {
        const ctx = document.getElementById('recipientPageChart').getContext('2d');
        const labels = ['Page 1', 'Page 2', 'Page 3', 'Page 4'];
        const values = [
            durations[1] || 0,
            durations[2] || 0,
            durations[3] || 0,
            durations[4] || 0
        ];

        modalChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    data: values,
                    backgroundColor: 'rgba(139, 92, 246, 0.7)',
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
                        ticks: { color: '#848995' }
                    },
                    y: {
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        ticks: { color: '#848995' },
                        title: { display: true, text: 'Seconds', color: '#848995' }
                    }
                }
            }
        });
    }

    function populateClicksList(clicks) {
        const outgoing = clicks.filter(c => !c.target_url.startsWith('UI-Click'));
        if (outgoing.length === 0) {
            modalClicksList.innerHTML = '<li class="empty-li">No external hyperlinks clicked inside PDF.</li>';
            return;
        }
        
        modalClicksList.innerHTML = '';
        outgoing.forEach(c => {
            const dateStr = new Date(c.clicked_at + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const li = document.createElement('li');
            li.innerHTML = `
                <span class="click-time">${dateStr}</span>
                <span class="click-url">Page ${c.page_number}: <a href="${c.target_url}" target="_blank">${c.target_url}</a></span>
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

        // Fetch timelines for all sessions in parallel
        try {
            const promises = sessions.map(s => fetch(`/api/admin/timeline/${s.id}`).then(r => r.json()));
            const timelinesData = await Promise.all(promises);
            
            // Merge timelines
            let allEvents = [];
            timelinesData.forEach(d => {
                if (d.timeline) allEvents.push(...d.timeline);
            });
            
            // Sort merged events chronologically by true timestamp
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
                
                // Format descriptions to look cleaner
                let typeClass = item.type;
                let icon = 'fa-circle-dot';
                if (item.type === 'start') {
                    icon = 'fa-door-open';
                } else if (item.type === 'page') {
                    icon = 'fa-book-open';
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

    // --- Action Submits ---

    async function revokeLink(token) {
        try {
            const resp = await fetch('/api/admin/revoke-link', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: token })
            });
            if (resp.ok) {
                loadAnalyticsData();
            } else {
                alert('Failed to revoke link. Please try again.');
            }
        } catch (e) {
            console.error(e);
        }
    }

    uploadForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fileInput = document.getElementById('pdf-file');
        const file = fileInput.files[0];
        if (!file) return;

        const formData = new FormData();
        formData.append('file', file);

        uploadFeedback.classList.remove('hidden', 'success', 'error');
        uploadFeedback.textContent = 'Uploading brochure PDF file...';
        
        try {
            const response = await fetch('/api/admin/upload', {
                method: 'POST',
                body: formData
            });
            
            const data = await response.json();
            if (response.ok) {
                uploadFeedback.textContent = `Success! Stored '${data.filename}'.`;
                uploadFeedback.classList.add('success');
                uploadForm.reset();
                loadAnalyticsData();
            } else {
                uploadFeedback.textContent = data.error || 'Upload failed.';
                uploadFeedback.classList.add('error');
            }
        } catch (err) {
            uploadFeedback.textContent = 'Connection error uploading brochure.';
            uploadFeedback.classList.add('error');
        }
    });

    singleLinkForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const docId = selectDocSingle.value;
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
                    document_id: docId,
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
        const docId = selectDocBulk.value;
        const csvText = document.getElementById('bulk-csv-input').value;
        const expiresDays = document.getElementById('bulk-expiry-days').value;
        
        bulkOutputPanel.classList.add('hidden');
        
        try {
            const response = await fetch('/api/admin/bulk-generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    document_id: docId,
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
    
    // Filters hook
    logSearchInput.addEventListener('input', renderLogsTable);
    logStatusFilter.addEventListener('change', renderLogsTable);
    logSortFilter.addEventListener('change', renderLogsTable);

    // Modal Close hooks
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

    // Polyfill strip
    if (!String.prototype.strip) {
        String.prototype.strip = function() {
            return this.replace(/^\s+|\s+$/g, '');
        };
    }

    // --- Initial Entry ---
    loadAnalyticsData();
});
