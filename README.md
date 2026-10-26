# NetPulse

### Network Monitoring and Diagnostic Tool

NetPulse is a network monitoring and diagnostic application designed to help users test network connectivity, measure latency, monitor endpoint availability, and investigate common network connection issues through a centralized dashboard.

The application combines a Python-based backend with a JavaScript-powered frontend to make network diagnostics more accessible and easier to understand. It focuses on practical monitoring tools, clear result presentation, diagnostic error handling, and continuous improvement of network testing reliability.

**Submission Note:** This project is a late submission. Despite being submitted beyond the intended deadline, development and improvements remain ongoing as I continue refining its functionality, reliability, and overall user experience.

## Key Features

- **Network Connectivity Testing** — Checks whether a target host is reachable.
- **Ping and Latency Measurement** — Measures network response times and presents latency results.
- **Endpoint Monitoring** — Retrieves monitoring information for configured or supported endpoints.
- **Network Diagnostic Dashboard** — Provides a centralized interface for running tests and reviewing results.
- **Latency Gauge Visualization** — Displays latency measurements through a visual gauge.
- **Traceroute Diagnostics** — Collects hop-by-hop network path information; reliability improvements are still in progress.
- **Backend API Integration** — Connects frontend controls to backend diagnostic operations.
- **Error and Timeout Handling** — Reports failures caused by unreachable destinations, unavailable commands, or execution timeouts.
- **Diagnostic Result Display** — Presents available measurement results and status information.
- **Automated Backend Testing** — Supports validation of important diagnostic behavior.
- **Dark-Themed Interface** — Uses a dark dashboard design for network monitoring.

## Core Modules

### 1. Network Monitoring Dashboard

The dashboard is the main interface for interacting with NetPulse and reviewing diagnostic results.

- Network testing controls
- Latency measurements and gauge visualization
- Diagnostic status indicators
- Organized presentation of test results
- Feedback for successful, unsuccessful, or incomplete tests

### 2. Ping and Latency Testing

The measurement module checks connectivity to a specified target and collects response-time information through backend diagnostic operations.

- Host reachability checks
- Response-time measurement
- Latency result processing
- Connection failure reporting
- Backend-powered test execution

### 3. Endpoint Monitoring

The endpoint monitoring module retrieves monitoring information for configured or supported network endpoints.

- Endpoint availability checks
- Monitoring result retrieval
- Backend API integration
- Diagnostic feedback for unsuccessful checks

### 4. Traceroute Diagnostics

The traceroute module is designed to inspect the network path between the local system and a destination by collecting information about intermediate network hops.

- Hop-by-hop diagnostic results
- Network path inspection
- Backend execution of traceroute-related commands
- Timeout and command error handling
- Processing of partial or incomplete trace results

**Development Status:** Traceroute reliability and result handling are still being refined. Behavior may vary depending on command availability, network conditions, destination reachability, and the local environment.

### 5. Backend API

The backend handles diagnostic execution, processes measurement results, and provides API endpoints for frontend requests.

## Technology Stack

### Frontend
- HTML
- CSS
- JavaScript
- Chart.js for chart visualization, where used
- Leaflet for map functionality, where used

### Backend
- Python
- Flask
- REST API endpoints
- Subprocess-based diagnostic command execution
- Timeout and error handling

### Network Diagnostics
- Ping-based connectivity testing
- Latency measurement
- Endpoint monitoring
- Traceroute or tracepath-based network path inspection

### Development Tools
- Git
- GitHub
- Visual Studio Code
- Linux development environment
- Python automated testing tools

*Exact dependency versions should be verified against the project's dependency files.*

## API Endpoints

NetPulse provides backend endpoints for its network diagnostic and monitoring features.

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/endpoints` | Retrieves endpoint monitoring information. |
| `POST` | `/api/measure` | Executes a network measurement. |
| `POST` | `/api/measure-all` | Runs measurements across supported endpoints. |
| `POST` | `/api/trace` | Executes network path diagnostics. |
| `GET` | `/api/history` | Retrieves available measurement history. |

The listed methods reflect the current project notes and should be confirmed against the backend implementation. Request parameters, response formats, and error codes depend on the implemented API behavior.

## Project Structure

The project is organized into frontend and backend components.

```text
cybersec2026/
├── backend/
│   ├── main.py
│   ├── network_monitor.py
│   └── monitoring_endpoints.json
├── frontend/
│   ├── index.html
│   ├── config.js
│   ├── css/
│   │   └── style.css
│   └── js/
│       └── app.js
└── ...
```

This structure reflects the known project files and may change as development continues.

## System Architecture

NetPulse separates the user interface from backend diagnostic operations.

```text
User
  |
  v
Frontend Dashboard
  |
  v
Backend API (Flask)
  |
  +--> Network Measurement
  |
  +--> Endpoint Monitoring
  |
  +--> Traceroute Diagnostics
  |
  v
Processed Diagnostic Results
  |
  v
Dashboard Updates
```

The frontend sends requests to the backend, which executes the requested diagnostic operation and returns the available results. The frontend then presents the results through dashboard components.

## Error Handling and Reliability

Network diagnostics may fail because of unreachable destinations, unavailable system commands, network restrictions, or execution timeouts.

NetPulse is being developed to handle these conditions through:

- Input and target validation
- Backend exception handling
- Diagnostic command timeouts
- API error responses
- Reporting of unsuccessful or incomplete tests
- Diagnostic output processing
- Automated tests for important backend behavior

These measures aim to improve the reliability of diagnostic operations and make failures easier to investigate.

## Testing

Automated backend tests help validate diagnostic behavior and reduce the risk of regressions as the application evolves.

Testing areas include:

- Network measurement behavior
- API endpoint responses
- Diagnostic command execution
- Timeout and error handling
- Traceroute output parsing
- Handling of incomplete diagnostic results

The current test status and coverage should be verified against the project's test suite.

## Installation and Setup

NetPulse is intended to run in a compatible Python environment with the required dependencies and network diagnostic utilities installed.

1. Clone the repository.

   ```bash
   git clone https://github.com/elliefranzgabuts-arch/cybrsec2026.git
   ```

2. Navigate to the project directory.

   ```bash
   cd cybrsec2026
   ```

3. Create and activate a Python virtual environment.

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   ```

4. Install the project's Python dependencies using its dependency file, if provided.

   ```bash
   pip install -r requirements.txt
   ```

5. Ensure the required network diagnostic utilities are installed and available in the system's `PATH`.

6. Start the backend using the project's configured entry point.

   ```bash
   python3 -m backend.main
   ```

The actual setup requirements may vary depending on the current project configuration. If a `requirements.txt` file is not present, install dependencies according to the project's existing configuration rather than creating one from assumptions.

## Project Objective

The objective of NetPulse is to develop a practical network monitoring and diagnostic tool that makes connectivity testing and latency measurement easier to perform and understand.

The project also provides hands-on experience in:

- Python backend development
- REST API integration
- Frontend development
- Operating system command execution
- Network diagnostics
- Error handling and timeout management
- Automated testing
- Git-based version control

## Development Status

NetPulse is an ongoing development project. Core backend measurement and endpoint API functionality have been implemented, while traceroute reliability, diagnostic execution, and other refinements continue to be improved.

Future improvements may include more reliable diagnostic execution, clearer result visualization, expanded endpoint monitoring, improved automated test coverage, and more detailed reporting of network issues.

The application is not presented as a finished or production-ready network monitoring platform. Its functionality and reliability will continue to be evaluated and improved throughout development.

---

*The system is still in development.*
