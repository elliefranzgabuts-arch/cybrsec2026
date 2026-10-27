const API_BASE_URL = 'http://127.0.0.1:5000';

/* =========================================================
   NETPULSE - FRONTEND APPLICATION
   ========================================================= */

/* DOM Elements */
const elements = {
    targetInput: document.getElementById('targetInput'),
    measureBtn: document.getElementById('measureBtn'),
    traceBtn: document.getElementById('traceBtn'),
    btnContent: document.querySelector('.btn-content'),
    spinner: document.querySelector('.spinner'),
    inputError: document.getElementById('inputError'),

    startMonBtn: document.getElementById('startMonBtn'),
    pauseMonBtn: document.getElementById('pauseMonBtn'),
    resumeMonBtn: document.getElementById('resumeMonBtn'),
    lastChecked: document.getElementById('lastChecked'),

    routeDetails: document.getElementById('routeDetails'),
    routeHopList: document.getElementById('routeHopList'),

    gaugeValue: document.getElementById('metricLatency'),
    gaugeProgress: document.getElementById('gaugeProgress'),

    metricMin: document.getElementById('metricMin'),
    metricMax: document.getElementById('metricMax'),
    metricLoss: document.getElementById('metricLoss'),
    metricStatus: document.getElementById('metricStatus'),

    historyTableBody: document.querySelector('#historyTable tbody'),
    historyEmpty: document.getElementById('historyEmpty'),
    refreshBtn: document.getElementById('refreshBtn'),

    connectionStatus: document.getElementById('connectionStatus'),
    worldMap: document.getElementById('worldMap'),
};

let latencyChart = null;
let leafletMap = null;
let markerLayer = null;
let routeLayer = null;

let monitoringActive = false;
let pollingTimer = null;
let errorTimer = null;

const POLL_INTERVAL = 10000;
const MAX_LATENCY = 500;

/* =========================================================
   HELPERS
   ========================================================= */

function toNumber(value) {
    if (
        value === null ||
        value === undefined ||
        value === ''
    ) {
        return null;
    }

    const number = Number(value);

    return Number.isFinite(number) ? number : null;
}

function formatLatency(value) {
    const number = toNumber(value);

    return number === null
        ? 'N/A'
        : `${number.toFixed(1)} ms`;
}

function formatPacketLoss(value) {
    const number = toNumber(value);

    return number === null
        ? 'N/A'
        : `${number.toFixed(1)}%`;
}

function normalizeMeasurement(measurement) {
    if (!measurement || typeof measurement !== 'object') {
        return null;
    }

    return {
        ...measurement,
        latency_avg: toNumber(measurement.latency_avg),
        latency_min: toNumber(measurement.latency_min),
        latency_max: toNumber(measurement.latency_max),
        packet_loss: toNumber(measurement.packet_loss),
    };
}

/* =========================================================
   NETWORK STATUS
   ========================================================= */

function deriveStatus(packetLoss, latencyAvg) {
    const loss = toNumber(packetLoss);
    const latency = toNumber(latencyAvg);

    if (loss === null) {
        return {
            label: 'Idle',
            class: 'status-neutral',
            color: '#999999',
        };
    }

    if (loss >= 25) {
        return {
            label: 'Unreachable',
            class: 'status-unreachable',
            color: '#FF4545',
        };
    }

    if (loss >= 10 || (latency !== null && latency >= 150)) {
        return {
            label: 'Degraded',
            class: 'status-degraded',
            color: '#FBBF24',
        };
    }

    return {
        label: 'Online',
        class: 'status-online',
        color: '#50E3B2',
    };
}

/* =========================================================
   API REQUESTS
   ========================================================= */

async function apiRequest(endpoint, options = {}) {
    let response;

    try {
        response = await fetch(`${API_BASE_URL}${endpoint}`, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers,
            },
        });
    } catch (error) {
        throw new Error(
            'Cannot connect to the backend. Make sure Flask is running on port 5000.'
        );
    }

    const contentType = response.headers.get('content-type') || '';
    let data;

    if (contentType.includes('application/json')) {
        data = await response.json().catch(() => null);
    } else {
        data = await response.text().catch(() => '');
    }

    if (!response.ok) {
        const message =
            data && typeof data === 'object' && data.error
                ? data.error
                : `Request failed with HTTP ${response.status}.`;

        throw new Error(message);
    }

    if (data === null || typeof data !== 'object') {
        throw new Error('The backend returned an invalid response.');
    }

    return data;
}

async function measureTarget(target) {
    return apiRequest('/api/measure', {
        method: 'POST',
        body: JSON.stringify({ target }),
    });
}

/* =========================================================
   LATENCY GAUGE
   ========================================================= */

function updateGauge(latency) {
    const gauge = elements.gaugeProgress;
    const valueElement = elements.gaugeValue;

    const value = toNumber(latency);

    if (!gauge || !valueElement) {
        console.error('Gauge elements are missing from the HTML.');
        return;
    }

    let arcLength;

    try {
        arcLength = gauge.getTotalLength();
    } catch (error) {
        console.error('Unable to calculate gauge length:', error);
        return;
    }

    if (!Number.isFinite(arcLength) || arcLength <= 0) {
        console.error('Invalid SVG gauge length.');
        return;
    }

    gauge.style.strokeDasharray = `${arcLength} ${arcLength}`;
    gauge.style.strokeLinecap = 'round';

    if (value === null || value < 0) {
        gauge.style.strokeDashoffset = String(arcLength);
        gauge.style.stroke = 'var(--text-secondary, #777777)';
        valueElement.textContent = '--';
        return;
    }

    const clampedLatency = Math.min(value, MAX_LATENCY);
    const ratio = clampedLatency / MAX_LATENCY;

    /*
     * The existing SVG gauge uses a dash offset to control
     * how much of the semicircle is visible.
     *
     * 0 ms   = minimum offset
     * 500 ms = maximum offset
     */
    const offset = arcLength * ratio;

    gauge.style.strokeDashoffset = String(offset);
    valueElement.textContent = value.toFixed(1);

    if (value < 100) {
        gauge.style.stroke = 'var(--color-success, #63F51B)';
    } else if (value < 250) {
        gauge.style.stroke = 'var(--accent-primary, #FF4545)';
    } else {
        gauge.style.stroke = 'var(--color-error, #FF4545)';
    }
}

/* =========================================================
   METRIC CARDS
   ========================================================= */

function updateAllMetrics(measurement) {
    const data = normalizeMeasurement(measurement);

    if (!data) {
        console.error('Invalid measurement data:', measurement);
        return;
    }

    updateGauge(data.latency_avg);

    if (elements.metricMin) {
        elements.metricMin.textContent =
            formatLatency(data.latency_min);
    }

    if (elements.metricMax) {
        elements.metricMax.textContent =
            formatLatency(data.latency_max);
    }

    if (elements.metricLoss) {
        elements.metricLoss.textContent =
            formatPacketLoss(data.packet_loss);
    }

    const status = deriveStatus(
        data.packet_loss,
        data.latency_avg
    );

    if (elements.metricStatus) {
        elements.metricStatus.textContent = status.label;
        elements.metricStatus.className =
            `value ${status.class}`;
    }
}

/* =========================================================
   HISTORY
   ========================================================= */

async function fetchHistory(options = {}) {
    const updateMetrics = options.updateMetrics === true;

    try {
        const response = await apiRequest('/api/history');

        const history = Array.isArray(response)
            ? response
            : Array.isArray(response.history)
                ? response.history
                : null;

        if (!history) {
            throw new Error('Invalid history response from backend.');
        }

        updateHistoryUI(history);
        updateChart(history);

        /*
         * Only initialize the dashboard metrics from history
         * when explicitly requested. Normal refreshes must not
         * overwrite a newer Run Test result.
         */
        if (updateMetrics && history.length > 0) {
            updateAllMetrics(history[0]);
        }

        return history;
    } catch (error) {
        console.error('Failed to fetch history:', error);

        if (options.showError) {
            showInputError('Could not load history from server.');
        }

        return null;
    }
}

function updateHistoryUI(history) {
    if (!elements.historyTableBody) return;

    elements.historyTableBody.innerHTML = '';

    if (!Array.isArray(history) || history.length === 0) {
        if (elements.historyEmpty) {
            elements.historyEmpty.classList.remove('hidden');
        }
        return;
    }

    if (elements.historyEmpty) {
        elements.historyEmpty.classList.add('hidden');
    }

    history.forEach((measurement) => {
        const row = document.createElement('tr');

        const timeCell = document.createElement('td');
        const targetCell = document.createElement('td');
        const latencyCell = document.createElement('td');
        const lossCell = document.createElement('td');

        const timestamp = measurement.timestamp
            ? new Date(measurement.timestamp)
            : null;

        timeCell.textContent =
            timestamp && !Number.isNaN(timestamp.getTime())
                ? timestamp.toLocaleTimeString()
                : 'N/A';

        targetCell.textContent = measurement.target || 'Unknown';
        latencyCell.textContent = formatLatency(measurement.latency_avg);
        lossCell.textContent = formatPacketLoss(measurement.packet_loss);

        row.append(
            timeCell,
            targetCell,
            latencyCell,
            lossCell
        );

        elements.historyTableBody.appendChild(row);
    });
}

/* =========================================================
   LATENCY CHART
   ========================================================= */

function updateChart(history) {
    const canvas = document.getElementById('latencyChart');

    if (!canvas) {
        console.warn('Latency chart canvas was not found.');
        return;
    }

    if (typeof Chart === 'undefined') {
        console.warn('Chart.js has not loaded.');
        return;
    }

    const records = Array.isArray(history) ? [...history].reverse() : [];

    const labels = records.map((measurement) => {
        const timestamp = new Date(measurement.timestamp);

        return Number.isNaN(timestamp.getTime())
            ? ''
            : timestamp.toLocaleTimeString();
    });

    const values = records.map((measurement) =>
        toNumber(measurement.latency_avg)
    );

    if (latencyChart) {
        latencyChart.data.labels = labels;
        latencyChart.data.datasets[0].data = values;
        latencyChart.update();
        return;
    }

    const context = canvas.getContext('2d');

    if (!context) {
        console.error('Unable to initialize chart context.');
        return;
    }

    latencyChart = new Chart(context, {
        type: 'line',

        data: {
            labels,

            datasets: [{
                label: 'Avg Latency (ms)',
                data: values,
                borderColor: '#FF4545',
                backgroundColor: 'rgba(255, 69, 69, 0.1)',
                fill: true,
                tension: 0.3,
                spanGaps: true,
                pointRadius: 3,
                pointBackgroundColor: '#FF4545',
            }],
        },

        options: {
            responsive: true,
            maintainAspectRatio: false,

            plugins: {
                legend: {
                    display: false,
                },
            },

            scales: {
                y: {
                    beginAtZero: true,

                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)',
                    },

                    ticks: {
                        color: '#999999',
                        font: {
                            family: 'JetBrains Mono',
                        },
                        callback: (value) => `${value} ms`,
                    },
                },

                x: {
                    grid: {
                        display: false,
                    },

                    ticks: {
                        color: '#999999',
                        font: {
                            family: 'JetBrains Mono',
                        },
                    },
                },
            },
        },
    });
}

/* =========================================================
   ERROR DISPLAY
   ========================================================= */

function showInputError(message) {
    if (!elements.inputError) {
        console.error(message);
        return;
    }

    elements.inputError.textContent = message;
    elements.inputError.classList.remove('hidden');

    if (errorTimer) {
        clearTimeout(errorTimer);
    }

    errorTimer = setTimeout(() => {
        elements.inputError.classList.add('hidden');
        errorTimer = null;
    }, 5000);
}

/* =========================================================
   RUN TEST
   ========================================================= */

async function handleMeasure() {
    if (!elements.targetInput || !elements.measureBtn) return;

    const target = elements.targetInput.value.trim();

    if (!target) {
        showInputError('Please enter a target host or IP.');
        return;
    }

    elements.measureBtn.disabled = true;

    if (elements.btnContent) {
        elements.btnContent.classList.add('hidden');
    }

    if (elements.spinner) {
        elements.spinner.classList.remove('hidden');
    }

    if (elements.inputError) {
        elements.inputError.classList.add('hidden');
    }

    try {
        const result = await measureTarget(target);

        /*
         * Update the dashboard immediately with the current
         * measurement before requesting the history list.
         */
        updateAllMetrics(result);
        updateMarkerStatus(result);

        /*
         * Refresh only the history and chart.
         * Do not allow history to replace the current reading.
         */
        await fetchHistory();
    } catch (error) {
        console.error('Measurement failed:', error);
        showInputError(error.message || 'The network test failed.');
    } finally {
        elements.measureBtn.disabled = false;

        if (elements.btnContent) {
            elements.btnContent.classList.remove('hidden');
        }

        if (elements.spinner) {
            elements.spinner.classList.add('hidden');
        }
    }
}

/* =========================================================
   TRACEROUTE
   ========================================================= */

async function handleTraceRoute() {
    if (!elements.targetInput || !elements.traceBtn) return;

    const target = elements.targetInput.value.trim();

    if (!target) {
        showInputError('Please enter a target host or IP.');
        return;
    }

    const button = elements.traceBtn;
    const buttonContent = button.querySelector('.btn-content');
    const buttonSpinner = button.querySelector('.spinner');

    button.disabled = true;

    if (buttonContent) {
        buttonContent.classList.add('hidden');
    }

    if (buttonSpinner) {
        buttonSpinner.classList.remove('hidden');
    }

    try {
        const data = await apiRequest('/api/trace', {
            method: 'POST',
            body: JSON.stringify({ target }),
        });

        renderRouteDetails(data.hops, data.complete);
        drawRouteOnMap(data.hops);
    } catch (error) {
        console.error('Traceroute failed:', error);
        showInputError(error.message || 'Traceroute failed.');
    } finally {
        button.disabled = false;

        if (buttonContent) {
            buttonContent.classList.remove('hidden');
        }

        if (buttonSpinner) {
            buttonSpinner.classList.add('hidden');
        }
    }
}

function renderRouteDetails(hops, complete) {
    if (!elements.routeHopList || !elements.routeDetails) return;

    elements.routeHopList.innerHTML = '';

    if (!Array.isArray(hops) || hops.length === 0) {
        const item = document.createElement('li');
        item.textContent = 'No route data available.';
        elements.routeHopList.appendChild(item);
    } else {
        const groups = {};

        hops.forEach((hop) => {
            const hopNumber = hop.hop ?? '?';

            if (!groups[hopNumber]) {
                groups[hopNumber] = [];
            }

            groups[hopNumber].push(hop);
        });

        const sortedHopNumbers = Object.keys(groups).sort(
            (a, b) => Number(a) - Number(b)
        );

        sortedHopNumbers.forEach((hopNumber) => {
            const records = groups[hopNumber];

            const descriptions = records.map((record) => {
                if (record.type === 'timeout') {
                    return '*** (no reply)';
                }

                const ip = record.ip || '***';
                const latency = toNumber(record.latency);

                return latency !== null
                    ? `${ip} (${latency.toFixed(1)} ms)`
                    : ip;
            });

            const item = document.createElement('li');
            item.textContent =
                `Hop ${hopNumber}: ${descriptions.join(', ')}`;

            elements.routeHopList.appendChild(item);
        });
    }

    const statusItem = document.createElement('li');
    statusItem.className = 'route-status-msg';

    if (complete === true) {
        statusItem.textContent = 'Trace completed successfully.';
    } else if (complete === false) {
        statusItem.textContent =
            'Trace incomplete — showing partial results (timeout or early termination).';
    } else {
        statusItem.textContent = 'Trace status unknown.';
    }

    elements.routeHopList.appendChild(statusItem);
    elements.routeDetails.classList.remove('hidden');
}

function drawRouteOnMap(hops) {
    if (!leafletMap || typeof L === 'undefined') {
        console.warn('Traceroute map is not initialized.');
        return;
    }

    if (routeLayer) {
        leafletMap.removeLayer(routeLayer);
    }

    routeLayer = L.layerGroup().addTo(leafletMap);

    const locatedHops = (Array.isArray(hops) ? hops : [])
        .map((hop) => ({
            ...hop,
            lat: toNumber(hop.lat),
            lon: toNumber(hop.lon),
        }))
        .filter((hop) =>
            hop.lat !== null &&
            hop.lon !== null &&
            hop.lat >= -90 &&
            hop.lat <= 90 &&
            hop.lon >= -180 &&
            hop.lon <= 180
        )
        .sort((a, b) => Number(a.hop) - Number(b.hop));

    const oldMessage = elements.worldMap?.querySelector(
        '.map-error-overlay'
    );

    if (oldMessage) oldMessage.remove();

    if (locatedHops.length === 0) {
        showMapMessage(
            'No traceroute hops could be mapped. ' +
            'Public-IP geolocation may be unavailable.'
        );
        return;
    }

    const routePoints = [];

    locatedHops.forEach((hop) => {
        const point = [hop.lat, hop.lon];
        routePoints.push(point);

        const marker = L.circleMarker(point, {
            radius: 5,
            color: '#FFFFFF',
            weight: 1,
            fillColor: '#FF4545',
            fillOpacity: 0.9,
        }).addTo(routeLayer);

        const popup = document.createElement('div');
        const title = document.createElement('strong');
        const details = document.createElement('div');

        title.textContent = `Traceroute Hop ${hop.hop ?? '?'}`;

        details.textContent =
            `${hop.ip || 'Unknown IP'} · ${formatLatency(hop.latency)}` +
            (hop.location ? ` · Approx. ${hop.location}` : '');

        popup.append(title, details);
        marker.bindPopup(popup);
    });

    if (routePoints.length >= 2) {
        L.polyline(routePoints, {
            color: '#FF4545',
            weight: 3,
            opacity: 0.9,
        }).addTo(routeLayer);

        leafletMap.fitBounds(routePoints, {
            padding: [30, 30],
            maxZoom: 8,
        });
    } else {
        leafletMap.setView(routePoints[0], 7);
    }
}

/* =========================================================
   LIVE MONITORING
   ========================================================= */

async function performLivePoll() {
    if (!monitoringActive) return;

    try {
        const response = await apiRequest('/api/measure-all', {
            method: 'POST',
        });

        if (!monitoringActive) return;

        const results = Array.isArray(response)
            ? response
            : Array.isArray(response.results)
                ? response.results
                : [];

        if (results.length > 0) {
            const primary = results[0];

            updateAllMetrics(primary);
            updateMarkersFromResults(results);

            /*
             * Refresh historical records without overwriting
             * the current live monitoring reading.
             */
            await fetchHistory();

            if (!monitoringActive) return;

            if (elements.lastChecked) {
                elements.lastChecked.textContent =
                    `Last checked: ${new Date().toLocaleTimeString()}`;

                elements.lastChecked.classList.remove('hidden');
            }
        }
    } catch (error) {
        if (!monitoringActive) return;

        console.error('Live monitoring failed:', error);

        showInputError(
            'Live monitoring encountered a backend error.'
        );
    } finally {
        if (monitoringActive) {
            pollingTimer = setTimeout(
                performLivePoll,
                POLL_INTERVAL
            );
        }
    }
}

function startMonitoring() {
    if (monitoringActive) return;

    monitoringActive = true;

    if (elements.startMonBtn) {
        elements.startMonBtn.classList.add('hidden');
    }

    if (elements.pauseMonBtn) {
        elements.pauseMonBtn.classList.remove('hidden');
    }

    if (elements.resumeMonBtn) {
        elements.resumeMonBtn.classList.add('hidden');
    }

    performLivePoll();
}

function pauseMonitoring() {
    monitoringActive = false;

    if (pollingTimer) {
        clearTimeout(pollingTimer);
        pollingTimer = null;
    }

    if (elements.startMonBtn) {
        elements.startMonBtn.classList.add('hidden');
    }

    if (elements.pauseMonBtn) {
        elements.pauseMonBtn.classList.add('hidden');
    }

    if (elements.resumeMonBtn) {
        elements.resumeMonBtn.classList.remove('hidden');
    }
}

function resumeMonitoring() {
    if (monitoringActive) return;

    monitoringActive = true;

    if (elements.startMonBtn) {
        elements.startMonBtn.classList.add('hidden');
    }

    if (elements.pauseMonBtn) {
        elements.pauseMonBtn.classList.remove('hidden');
    }

    if (elements.resumeMonBtn) {
        elements.resumeMonBtn.classList.add('hidden');
    }

    performLivePoll();
}

/* =========================================================
   MAP INITIALIZATION
   ========================================================= */

async function initMap() {
    if (!elements.worldMap) return;

    if (typeof L === 'undefined') {
        showMapMessage(
            'Leaflet library failed to load. Please check your connection.'
        );
        return;
    }

    const apiKey =
        typeof MAPTILER_KEY !== 'undefined'
            ? MAPTILER_KEY
            : null;

    if (!apiKey || apiKey === 'your_api_key_here') {
        showMapMessage(
            'Map configuration required. Please add your API key to config.js.'
        );
        return;
    }

    try {
        leafletMap = L.map('worldMap', {
            center: [12.8797, 121.7740],
            zoom: 5,
            zoomControl: false,
            attributionControl: true,
        });

        L.tileLayer(
            `https://api.maptiler.com/maps/satellite-v4/{z}/{x}/{y}.jpg?key=${apiKey}`,
            {
                attribution:
                    '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> ' +
                    '&copy; <a href="https://www.openstreetmap.org/copyright">' +
                    'OpenStreetMap</a> contributors',
            }
        ).addTo(leafletMap);

        markerLayer = L.layerGroup().addTo(leafletMap);

        await loadMarkers();

        /*
         * Ensure Leaflet recalculates its dimensions if the map
         * container was hidden or resized during initialization.
         */
        setTimeout(() => {
            if (leafletMap) {
                leafletMap.invalidateSize();
            }
        }, 100);
    } catch (error) {
        console.error('Map initialization failed:', error);

        showMapMessage(
            'Failed to load map layer. Check the API key and connection.'
        );
    }
}

function showMapMessage(message) {
    if (!elements.worldMap) return;

    const existing = elements.worldMap.querySelector(
        '.map-error-overlay'
    );

    if (existing) {
        existing.textContent = message;
        return;
    }

    const messageElement = document.createElement('div');
    messageElement.className = 'map-error-overlay';
    messageElement.textContent = message;

    elements.worldMap.appendChild(messageElement);
}

/* =========================================================
   MAP ENDPOINT MARKERS
   ========================================================= */

async function loadMarkers() {
    if (!markerLayer || typeof L === 'undefined') return;

    try {
        const response = await apiRequest('/api/endpoints');

        const endpoints = Array.isArray(response)
            ? response
            : Array.isArray(response.endpoints)
                ? response.endpoints
                : [];

        markerLayer.clearLayers();

        endpoints.forEach((endpoint) => {
            const latitude = toNumber(endpoint.lat);
            const longitude = toNumber(endpoint.lon);

            if (
                latitude === null ||
                longitude === null ||
                latitude < -90 ||
                latitude > 90 ||
                longitude < -180 ||
                longitude > 180
            ) {
                console.warn('Skipping invalid map endpoint:', endpoint);
                return;
            }

            const status = deriveStatus(null, null);

            const marker = L.circleMarker(
                [latitude, longitude],
                {
                    radius: 6,
                    fillColor: status.color,
                    color: '#FFFFFF',
                    weight: 1,
                    opacity: 1,
                    fillOpacity: 0.8,
                }
            ).addTo(markerLayer);

            const popupContent = document.createElement('div');
            popupContent.className = 'map-popup-content';

            const title = document.createElement('span');
            title.className = 'map-popup-title';
            title.textContent = endpoint.name || endpoint.target || 'Endpoint';

            const details = document.createElement('span');
            details.className = 'map-popup-details';

            details.textContent =
                `${endpoint.target || 'Unknown target'} - ` +
                `Approx: ${latitude}, ${longitude}`;

            const actionButton = document.createElement('button');
            actionButton.className = 'map-popup-action';
            actionButton.textContent = 'Select Endpoint';

            actionButton.addEventListener('click', () => {
                if (elements.targetInput) {
                    elements.targetInput.value = endpoint.target || '';
                    elements.targetInput.focus();
                }
            });

            popupContent.append(
                title,
                details,
                actionButton
            );

            marker.bindPopup(popupContent);
            marker.target = endpoint.target;

            marker.on('popupopen', () => {
                if (!marker.latestData) return;

                const content = marker.getPopup().getContent();

                const detailsElement =
                    content.querySelector('.map-popup-details');

                if (detailsElement) {
                    detailsElement.textContent =
                        `${marker.latestData.latency} | ` +
                        `Loss: ${marker.latestData.loss} | ` +
                        `${marker.latestData.timestamp}`;
                }
            });
        });
    } catch (error) {
        console.error('Failed to load map markers:', error);
    }
}

function updateMarkerStatus(measurement) {
    const data = normalizeMeasurement(measurement);

    if (
        !data ||
        !data.target ||
        !leafletMap ||
        !markerLayer
    ) {
        return;
    }

    const status = deriveStatus(
        data.packet_loss,
        data.latency_avg
    );

    markerLayer.eachLayer((marker) => {
        if (marker.target !== data.target) return;

        marker.setStyle({
            fillColor: status.color,
        });

        marker.latestData = {
            latency: formatLatency(data.latency_avg),
            loss: formatPacketLoss(data.packet_loss),
            timestamp: new Date().toLocaleTimeString(),
        };

        const popup = marker.getPopup();

        if (popup && popup.isOpen()) {
            const content = popup.getContent();

            const detailsElement =
                content.querySelector('.map-popup-details');

            if (detailsElement) {
                detailsElement.textContent =
                    `${marker.latestData.latency} | ` +
                    `Loss: ${marker.latestData.loss} | ` +
                    `${marker.latestData.timestamp}`;
            }
        }
    });
}

function updateMarkersFromResults(results) {
    if (!Array.isArray(results)) return;

    results.forEach((result) => {
        updateMarkerStatus(result);
    });
}

/* =========================================================
   INITIALIZATION
   ========================================================= */

async function init() {
    /*
     * Validate required controls before registering events.
     */
    if (!elements.targetInput || !elements.measureBtn) {
        console.error(
            'Required NetPulse elements are missing. Check index.html.'
        );
        return;
    }

    elements.measureBtn.addEventListener('click', handleMeasure);

    if (elements.traceBtn) {
        elements.traceBtn.addEventListener('click', handleTraceRoute);
    }

    if (elements.refreshBtn) {
        elements.refreshBtn.addEventListener('click', () => {
            fetchHistory({ showError: true });
        });
    }

    elements.targetInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            handleMeasure();
        }
    });

    if (elements.startMonBtn) {
        elements.startMonBtn.addEventListener(
            'click',
            startMonitoring
        );
    }

    if (elements.pauseMonBtn) {
        elements.pauseMonBtn.addEventListener(
            'click',
            pauseMonitoring
        );
    }

    if (elements.resumeMonBtn) {
        elements.resumeMonBtn.addEventListener(
            'click',
            resumeMonitoring
        );
    }

    try {
        /*
         * Use the same API helper so HTTP failures are detected.
         */
        await apiRequest('/api/history');

        if (elements.connectionStatus) {
            elements.connectionStatus.textContent = 'Connected';
            elements.connectionStatus.classList.remove('offline');
            elements.connectionStatus.classList.add('connected');
        }

        /*
         * During initial startup, show the latest historical
         * measurement. Subsequent refreshes will not overwrite
         * fresh test results.
         */
        await fetchHistory({ updateMetrics: true });

        await initMap();
    } catch (error) {
        console.error('Backend connection failed:', error);

        if (elements.connectionStatus) {
            elements.connectionStatus.textContent = 'Offline';
            elements.connectionStatus.classList.remove('connected');
            elements.connectionStatus.classList.add('offline');
        }

        showInputError(
            'Backend is offline. Start the Flask server and reload the page.'
        );
    }
}

document.addEventListener('DOMContentLoaded', init);
