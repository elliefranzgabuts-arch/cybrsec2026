from flask import Flask, request, jsonify
from flask_cors import CORS
from collections import deque
from datetime import datetime
import json
import os
from .network_monitor import run_ping, run_ping_concurrently

app = Flask(__name__)
CORS(app)

# In-memory history capped at 100 results
history = deque(maxlen=100)

# Path to monitoring endpoints config
ENDPOINTS_FILE = os.path.join(os.path.dirname(__file__), 'monitoring_endpoints.json')

def load_endpoints():
    try:
        with open(ENDPOINTS_FILE, 'r') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []

@app.route('/api/endpoints', methods=['GET'])
def get_endpoints():
    """Returns the list of authorized monitoring endpoints."""
    return jsonify(load_endpoints()), 200

@app.route('/api/measure', methods=['POST'])
def measure():
    data = request.get_json()
    if not data or 'target' not in data:
        return jsonify({"error": "Missing 'target' in request body"}), 400

    target = data['target']

    try:
        results = run_ping(target)

        measurement = {
            "timestamp": datetime.now().isoformat(),
            **results
        }

        history.append(measurement)

        return jsonify(measurement), 200

    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except RuntimeError as e:
        return jsonify({"error": "Internal network monitoring error"}), 500
    except Exception:
        return jsonify({"error": "An unexpected error occurred"}), 500

@app.route('/api/measure-all', methods=['POST'])
def measure_all():
    """Triggers concurrent measurements for all authorized endpoints."""
    endpoints = load_endpoints()
    if not endpoints:
        return jsonify({"error": "No monitoring endpoints configured"}), 500

    targets = [e['target'] for e in endpoints]

    try:
        results = run_ping_concurrently(targets)

        # We only add the first result to history for simplicity,
        # or you could add all. For now, we just return the results.
        return jsonify(results), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/history', methods=['GET'])
def get_history():
    return jsonify(list(history)[::-1]), 200

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
