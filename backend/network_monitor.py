import subprocess
import ipaddress
import re
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def validate_target(target):
    """
    Validates the target as either a valid IP address or a strict hostname.
    Prevents shell injection and malformed targets.
    """
    if not target or not isinstance(target, str):
        return False

    # 1. Try validating as IP address
    try:
        ipaddress.ip_address(target)
        return True
    except ValueError:
        pass

    # Reject malformed IP-like strings (e.g., 8.8.8.256)
    # to prevent them from being treated as hostnames.
    if re.match(r'^[\d.]+$', target):
        return False

    # 2. Strict Hostname Validation
    if len(target) > 253:
        return False

    label_regex = re.compile(r'^(?!-)[a-zA-Z0-9-]{1,63}(?<!-)$')
    labels = target.split('.')

    if not labels or any(not label_regex.match(label) for label in labels):
        return False

    return True

def run_ping(target, count=4, timeout=2):
    """
    Executes the system ping utility securely and parses the output.
    Returns a dictionary with result metrics or raises an exception.
    """
    if not validate_target(target):
        raise ValueError(f"Invalid target: {target}")

    cmd = ['ping', '-c', str(count), '-W', str(timeout), target]

    try:
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=15,
            shell=False
        )
    except FileNotFoundError:
        raise RuntimeError("The 'ping' utility is not installed on the system.")
    except subprocess.TimeoutExpired:
        raise RuntimeError("The ping command timed out.")

    stdout = result.stdout

    loss_match = re.search(r'(\d+)% packet loss', stdout)
    if not loss_match:
        if result.returncode != 0 and not stdout:
            raise RuntimeError("Ping command failed with no output.")
        packet_loss = 100.0
    else:
        packet_loss = float(loss_match.group(1))

    latency_min = None
    latency_avg = None
    latency_max = None

    if packet_loss < 100:
        rtt_match = re.search(r'rtt min/avg/max/mdev = ([0-9.]+)/([0-9.]+)/([0-9.]+)/[0-9.]+ ms', stdout)
        if rtt_match:
            latency_min = float(rtt_match.group(1))
            latency_avg = float(rtt_match.group(2))
            latency_max = float(rtt_match.group(3))

    return {
        "target": target,
        "packet_loss": packet_loss,
        "latency_min": latency_min,
        "latency_avg": latency_avg,
        "latency_max": latency_max
    }

def run_ping_concurrently(targets, max_workers=5):
    """
    Runs pings for multiple targets concurrently using a bounded thread pool.
    Returns a list of results, handling exceptions per target.
    """
    results = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_target = {executor.submit(run_ping, target): target for target in targets}

        for future in as_completed(future_to_target):
            target = future_to_target[future]
            try:
                results.append(future.result())
            except Exception as e:
                logger.error(f"Concurrent ping failed for {target}: {e}")
                results.append({
                    "target": target,
                    "packet_loss": 100.0,
                    "latency_min": None,
                    "latency_avg": None,
                    "latency_max": None,
                    "error": str(e)
                })
    return results
