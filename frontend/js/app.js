const API_BASE_URL = 'http://127.0.0.1:5000';

/**
 * UI state and elements
 */
const elements = {
    targetInput: document.getElementById('targetInput'),
    measureBtn: document.getElementById('measureBtn'),
    traceBtn: document.getElementById('traceBtn'),
    btnContent: document.querySelector('.btn-content'),
    spinner: document.querySelector('.spinner'),
    inputError: document.getElementById('inputError'),

    // Monitoring Controls
    startMonBtn: document.getElementById('startMonBtn'),
    pauseMonBtn: document.getElementById('pauseMonBtn'),
    resumeMonBtn: document.getElementById('resumeMonBtn'),
    lastChecked: document.getElementById('lastChecked'),

    // Route Details
    routeDetails: document.getElementById('routeDetails'),
    routeHopList: document.getElementById('routeHopList'),

    // Gauge elements
    gaugeValue: document.getElementById('metricLatency'),
    gaugeProgress: document.getElementById('gaugeProgress'),

    // Metric cards
    metricMin: document.getElementById('metricMin'),
    metricMax: document.getElementById('metricMax'),
    metricLoss: document.getElementById('metricLoss'),
    metricStatus: document.getElementById('metricStatus'),

    // History elements
    historyTableBody: document.querySelector('#historyTable tbody'),
    historyEmpty: document.getElementById('historyEmpty'),
    refreshBtn: document.getElementById('refreshBtn'),

    connectionStatus: document.getElementById('connectionStatus'),

    // Map elements
    worldMap: document.getElementById('worldMap'),
};

let latencyChart = null;
let leafletMap = null;
let markerLayer = null; // Initialize as null to avoid top-level L reference

// Route state
let activeRouteLine = null;
let routeIndicator = null;
let routeAnimationId = null;

// Monitoring state
let monitoringActive = false;
let pollingTimer = null;
const POLL_INTERVAL = 10000; // 10 seconds

/**
 * Network Status Logic
 * Thresholds:
 * - Online: Packet loss < 10% and latency < 150ms
 * - Degraded: Packet loss < 25% OR latency >= 150ms
 * - Unreachable: Packet loss >= 25% or total loss
 */
function deriveStatus(packetLoss, latencyAvg) {
    if (packetLoss === null || packetLoss === undefined) return { label: 'Idle', class: 'status-neutral', color: '#999999' };

    if (packetLoss >= 25) {
        return { label: 'Unreachable', class: 'status-unreachable', color: '#FF4545' };
    }
    if (packetLoss >= 10 || (latencyAvg && latencyAvg >= 150)) {
        return { label: 'Degraded', class: 'status-degraded', color: '#FBBF24' };
    }
    return { label: 'Online', class: 'status-online', color: '#50E3B2' };
}

/**
 * API Functions
 */
async function apiRequest(endpoint, options = {}) {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...options.headers,
        },
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
    }

    return response.json();
}

async function fetchHistory() {
    try {
        const history = await apiRequest('/api/history');
        updateHistoryUI(history);
        updateChart(history);
        if (history.length > 0) {
            updateAllMetrics(history[0]);
        }
        return history;
    } catch (err) {
        console.error('Failed to fetch history:', err);
        showInputError('Could not load history from server.');
        return null;
    }
}

async function measureTarget(target) {
    try {
        return await apiRequest('/api/measure', {
            method: 'POST',
            body: JSON.stringify({ target }),
        });
    } catch (err) {
        throw err;
    }
}

/**
 * Gauge Visuals
 * Max scale: 500ms.
 * Offset 251.3 = 0% (left), 0 = 100% (right)
 */
function updateGauge(latency) {
    if (latency === null) {
        const arcLength = elements.gaugeProgress.getTotalLength();
        elements.gaugeProgress.style.strokeDashoffset = arcLength.toString();
        elements.gaugeProgress.style.stroke = 'var(--text-secondary)';
        elements.gaugeValue.textContent = '--';
        return;
    }

    const maxScale = 500;
    const clampedLatency = Math.min(latency, maxScale);
    const percentage = 1 - (clampedLatency / maxScale);

    const arcLength = elements.gaugeProgress.getTotalLength();
    const offset = arcLength * (1 - percentage);

    elements.gaugeProgress.style.strokeDashoffset = offset;
    elements.gaugeValue.textContent = latency.toFixed(1);

    // Theme-specific Color Logic (Signal Red Accents)
    if (latency < 100) {
        elements.gaugeProgress.style.stroke = 'var(--color-success)'; // Mint
    } else if (latency < 250) {
        elements.gaugeProgress.style.stroke = 'var(--accent-primary)'; // Signal Red
    } else {
        elements.gaugeProgress.style.stroke = 'var(--color-error)'; // Dark Red
    }
}

function updateAllMetrics(measurement) {
    const latency = measurement.latency_avg;
    const loss = measurement.packet_loss;

    updateGauge(latency);

    elements.metricMin.textContent = measurement.latency_min !== null ? measurement.latency_min.toFixed(1) + 'ms' : 'N/A';
    elements.metricMax.textContent = measurement.latency_max !== null ? measurement.latency_max.toFixed(1) + 'ms' : 'N/A';
    elements.metricLoss.textContent = loss !== null ? loss.toFixed(1) + '%' : 'N/A';

    const status = deriveStatus(loss, latency);
    elements.metricStatus.textContent = status.label;
    elements.metricStatus.className = `value ${status.class}`;
}

function updateHistoryUI(history) {
    elements.historyTableBody.innerHTML = '';

    if (history.length === 0) {
        elements.historyEmpty.classList.remove('hidden');
        return;
    }

    elements.historyEmpty.classList.add('hidden');

    history.forEach(m => {
        const row = document.createElement('tr');
        const date = new Date(m.timestamp).toLocaleTimeString();

        const cellTime = document.createElement('td');
        cellTime.textContent = date;

        const cellTarget = document.createElement('td');
        cellTarget.textContent = m.target;

        const cellLatency = document.createElement('td');
        cellLatency.textContent = m.latency_avg !== null ? m.latency_avg.toFixed(1) + ' ms' : 'N/A';

        const cellLoss = document.createElement('td');
        cellLoss.textContent = m.packet_loss !== null ? m.packet_loss.toFixed(1) + '%' : 'N/A';

        row.appendChild(cellTime);
        row.appendChild(cellTarget);
        row.appendChild(cellLatency);
        row.appendChild(cellLoss);
        elements.historyTableBody.appendChild(row);
    });
}

function updateChart(history) {
    const data = [...history].reverse();
    const labels = data.map(m => new Date(m.timestamp).toLocaleTimeString());
    const values = data.map(m => m.latency_avg);

    if (latencyChart) {
        latencyChart.data.labels = labels;
        latencyChart.data.datasets[0].data = values;
        latencyChart.update();
    } else {
        const ctx = document.getElementById('latencyChart').getContext('2d');
        latencyChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Avg Latency (ms)',
                    data: values,
                    borderColor: '#FF4545',
                    backgroundColor: 'rgba(255, 69, 69, 0.1)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 3,
                    pointBackgroundColor: '#FF4545',
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        ticks: { color: '#999999', font: { family: 'JetBrains Mono' }, callback: v => v + 'ms' }
                    },
                    x: {
                        grid: { display: false },
                        ticks: { color: '#999999', font: { family: 'JetBrains Mono' } }
                    }
                }
            }
        });
    }
}

function showInputError(msg) {
    elements.inputError.textContent = msg;
    elements.inputError.classList.remove('hidden');
    setTimeout(() => {
        elements.inputError.classList.add('hidden');
    }, 5000);
}

async function handleMeasure() {
    const target = elements.targetInput.value.trim();
    if (!target) {
        showInputError('Please enter a target host or IP.');
        return;
    }

    elements.measureBtn.disabled = true;
    elements.btnContent.classList.add('hidden');
    elements.spinner.classList.remove('hidden');
    elements.inputError.classList.add('hidden');

    try {
        const result = await measureTarget(target);
        updateAllMetrics(result);
        await fetchHistory();
        updateMarkerStatus(result);
    } catch (err) {
        showInputError(err.message);
    } finally {
        elements.measureBtn.disabled = false;
        elements.btnContent.classList.remove('hidden');
        elements.spinner.classList.add('hidden');
    }
}

async function handleTraceRoute() {
    const target = elements.targetInput.value.trim();
    if (!target) {
        showInputError('Please enter a target host or IP.');
        return;
    }

    elements.traceBtn.disabled = true;
    const traceBtnContent = elements.traceBtn.querySelector('.btn-content');
    const traceSpinner = elements.traceBtn.querySelector('.spinner');

    traceBtnContent.classList.add('hidden');
    traceSpinner.classList.remove('hidden');
    elements.inputError.classList.add('hidden');

    try {
        const data = await apiRequest('/api/trace', {
            method: 'POST',
            body: JSON.stringify({ target })
        });

        renderRouteDetails(data.hops);
        drawRouteOnMap(data.hops);
    } catch (err) {
        showInputError(err.message);
    } finally {
        elements.traceBtn.disabled = false;
        traceBtnContent.classList.remove('hidden');
        traceSpinner.classList.add('hidden');
    }
}

/**
 * Live Monitoring Logic
 */
async function performLivePoll() {
    if (!monitoringActive) return;

    try {
        const results = await apiRequest('/api/measure-all', { method: 'POST' });

        // Check again if monitoring is still active after the async request
        if (!monitoringActive) return;

        if (results && results.length > 0) {
            // Use the first result to update the main gauge and telemetry
            // since 'measure-all' returns a list.
            const primary = results[0];
            updateAllMetrics(primary);

            // Update map markers with the full result set
            updateMarkersFromResults(results);

            // Update history and chart (using the primary or all)
            await fetchHistory();

            // Update last checked timestamp
            const now = new Date();
            elements.lastChecked.textContent = `Last checked: ${now.toLocaleTimeString()}`;
            elements.lastChecked.classList.remove('hidden');
        }
    } catch (err) {
        if (!monitoringActive) return;
        console.error('Live polling failed:', err);
        // We don't block the loop on a single failure, but we notify the user
        showInputError('Live monitoring encountered a backend error.');
    } finally {
        // Schedule next poll only after the current one completes
        if (monitoringActive) {
            pollingTimer = setTimeout(performLivePoll, POLL_INTERVAL);
        }
    }
}

function startMonitoring() {
    if (monitoringActive) return;

    monitoringActive = true;
    elements.startMonBtn.classList.add('hidden');
    elements.pauseMonBtn.classList.remove('hidden');
    elements.resumeMonBtn.classList.add('hidden');

    performLivePoll();
}

function pauseMonitoring() {
    monitoringActive = false;
    if (pollingTimer) {
        clearTimeout(pollingTimer);
        pollingTimer = null;
    }
    elements.startMonBtn.classList.add('hidden');
    elements.pauseMonBtn.classList.add('hidden');
    elements.resumeMonBtn.classList.remove('hidden');
}

function resumeMonitoring() {
    if (monitoringActive) return;

    monitoringActive = true;
    elements.startMonBtn.classList.add('hidden');
    elements.pauseMonBtn.classList.remove('hidden');
    elements.resumeMonBtn.classList.add('hidden');

    performLivePoll();
}

/**
 * World Map Logic
 */
async function initMap() {
    // Safe check for Leaflet L
    if (typeof L === 'undefined') {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'map-error-overlay';
        errorDiv.textContent = 'Leaflet library failed to load. Please check your connection.';
        elements.worldMap.appendChild(errorDiv);
        return;
    }

    const apiKey = (typeof MAPTILER_KEY !== 'undefined') ? MAPTILER_KEY : null;

    if (!apiKey || apiKey === 'your_api_key_here') {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'map-error-overlay';
        errorDiv.textContent = 'Map configuration required. Please add your API key to config.js.';
        elements.worldMap.appendChild(errorDiv);
        return;
    }

    try {
        leafletMap = L.map('worldMap', {
            center: [12.8797, 121.7740],
            zoom: 5.5,
            zoomControl: false,
            attributionControl: true
        });

        L.tileLayer(`https://api.maptiler.com/maps/satellite-v4/{z}/{x}/{y}.jpg?key=${apiKey}`, {
            attribution: '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        }).addTo(leafletMap);

        markerLayer = L.layerGroup();
        markerLayer.addTo(leafletMap);
        await loadMarkers();
    } catch (err) {
        console.error('Map initialization failed:', err);
        const errorDiv = document.createElement('div');
        errorDiv.className = 'map-error-overlay';
        errorDiv.textContent = 'Failed to load map layer. Check API key and connection.';
        elements.worldMap.appendChild(errorDiv);
    }
}

async function loadMarkers() {
    try {
        const endpoints = await apiRequest('/api/endpoints');
        markerLayer.clearLayers();

        endpoints.forEach(ep => {
            const status = deriveStatus(null, null); // Initial neutral state
            const marker = L.circleMarker([ep.lat, ep.lon], {
                radius: 6,
                fillColor: status.color,
                color: '#fff',
                weight: 1,
                opacity: 1,
                fillOpacity: 0.8
            }).addTo(markerLayer);

            const popupContent = document.createElement('div');
            popupContent.className = 'map-popup-content';

            const title = document.createElement('span');
            title.className = 'map-popup-title';
            title.textContent = ep.name;

            const details = document.createElement('span');
            details.className = 'map-popup-details';
            details.textContent = `${ep.target} - Approx: ${ep.lat}, ${ep.lon}`;

            const actionBtn = document.createElement('button');
            actionBtn.className = 'map-popup-action';
            actionBtn.textContent = 'Select Endpoint';

            actionBtn.addEventListener('click', () => {
                elements.targetInput.value = ep.target;
                elements.targetInput.focus();
            });

            popupContent.appendChild(title);
            popupContent.appendChild(details);
            popupContent.appendChild(actionBtn);

            marker.bindPopup(popupContent);
            marker.target = ep.target; // Store target for status updates

            // Add a listener to update content when popup opens
            marker.on('popupopen', () => {
                if (marker.latestData) {
                    const popup = marker.getPopup();
                    const contentDiv = popup.getContent();
                    const details = contentDiv.querySelector('.map-popup-details');
                    if (details) {
                        details.textContent = `${marker.latestData.latency} | Loss: ${marker.latestData.loss} | ${marker.latestData.timestamp}`;
                    }
                }
            });
        });
    } catch (err) {
        console.error('Failed to load markers:', err);
    }
}

function updateMarkerStatus(measurement) {
    if (!leafletMap || !markerLayer || !measurement.target) return;

    markerLayer.eachLayer(marker => {
        if (marker.target === measurement.target) {
            const status = deriveStatus(measurement.packet_loss, measurement.latency_avg);
            marker.setStyle({ fillColor: status.color });

            // Store latest data on the marker object itself
            marker.latestData = {
                latency: measurement.latency_avg !== null ? `${measurement.latency_avg.toFixed(1)}ms` : 'N/A',
                loss: measurement.packet_loss !== null ? `${measurement.packet_loss.toFixed(1)}%` : 'N/A',
                timestamp: new Date().toLocaleTimeString()
            };

            // Update popup if it is currently open
            const popup = marker.getPopup();
            if (popup && popup.isOpen()) {
                const contentDiv = popup.getContent();
                const details = contentDiv.querySelector('.map-popup-details');
                if (details) {
                    details.textContent = `${marker.latestData.latency} | Loss: ${marker.latestData.loss} | ${marker.latestData.timestamp}`;
                }
            }
        }
    });
}

function updateMarkersFromResults(results) {
    results.forEach(res => {
        updateMarkerStatus(res);
    });
}

async function init() {
    elements.measureBtn.addEventListener('click', handleMeasure);
    elements.refreshBtn.addEventListener('click', fetchHistory);
    elements.targetInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleMeasure();
    });

    // Monitoring Event Listeners
    elements.startMonBtn.addEventListener('click', startMonitoring);
    elements.pauseMonBtn.addEventListener('click', pauseMonitoring);
    elements.resumeMonBtn.addEventListener('click', resumeMonitoring);

    try {
        await fetch(`${API_BASE_URL}/api/history`);
        elements.connectionStatus.textContent = 'Connected';
        elements.connectionStatus.classList.add('connected');
        await fetchHistory();
        await initMap();
    } catch (err) {
        elements.connectionStatus.textContent = 'Offline';
        elements.connectionStatus.classList.add('offline');
    }
}

document.addEventListener('DOMContentLoaded', init);
