const API_BASE_URL = 'http://127.0.0.1:5000';

/**
 * UI state and elements
 */
const elements = {
    targetInput: document.getElementById('targetInput'),
    measureBtn: document.getElementById('measureBtn'),
    btnContent: document.querySelector('.btn-content'),
    spinner: document.querySelector('.spinner'),
    inputError: document.getElementById('inputError'),

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
};

let latencyChart = null;

/**
 * Network Status Logic
 * Thresholds:
 * - Online: Packet loss < 10% and latency < 150ms
 * - Degraded: Packet loss < 25% OR latency >= 150ms
 * - Unreachable: Packet loss >= 25% or total loss
 */
function deriveStatus(packetLoss, latencyAvg) {
    if (packetLoss === null || packetLoss === undefined) return { label: 'Idle', class: 'status-neutral' };

    if (packetLoss >= 25) {
        return { label: 'Unreachable', class: 'status-unreachable' };
    }
    if (packetLoss >= 10 || (latencyAvg && latencyAvg >= 150)) {
        return { label: 'Degraded', class: 'status-degraded' };
    }
    return { label: 'Online', class: 'status-online' };
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
        elements.gaugeProgress.style.strokeDashoffset = '251.3';
        elements.gaugeProgress.style.stroke = 'var(--text-secondary)';
        elements.gaugeValue.textContent = '--';
        return;
    }

    const maxScale = 500;
    const clampedLatency = Math.min(latency, maxScale);
    const percentage = 1 - (clampedLatency / maxScale);
    const offset = 251.3 * (1 - percentage);

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

        row.innerHTML = `
            <td>${date}</td>
            <td>${m.target}</td>
            <td>${m.latency_avg !== null ? m.latency_avg.toFixed(1) + ' ms' : 'N/A'}</td>
            <td>${m.packet_loss !== null ? m.packet_loss.toFixed(1) + '%' : 'N/A'}</td>
        `;
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
    } catch (err) {
        showInputError(err.message);
    } finally {
        elements.measureBtn.disabled = false;
        elements.btnContent.classList.remove('hidden');
        elements.spinner.classList.add('hidden');
    }
}

async function init() {
    elements.measureBtn.addEventListener('click', handleMeasure);
    elements.refreshBtn.addEventListener('click', fetchHistory);
    elements.targetInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleMeasure();
    });

    try {
        await fetch(`${API_BASE_URL}/api/history`);
        elements.connectionStatus.textContent = 'Connected';
        elements.connectionStatus.classList.add('connected');
        await fetchHistory();
    } catch (err) {
        elements.connectionStatus.textContent = 'Offline';
        elements.connectionStatus.classList.add('offline');
    }
}

document.addEventListener('DOMContentLoaded', init);
