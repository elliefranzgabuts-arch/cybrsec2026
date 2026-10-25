
import ipaddress
import logging
import os
import re
import select
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, as_completed


# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def validate_target(target):
    """
    Validate a target as an IP address or hostname.
    Reject malformed IP-like strings and invalid hostnames.
    """
    if not target or not isinstance(target, str):
        return False

    target = target.strip()

    if not target or len(target) > 253:
        return False

    try:
        ipaddress.ip_address(target)
        return True
    except ValueError:
        pass

    # Reject malformed IP-like strings such as 8.8.8.256.
    if re.fullmatch(r"[\d.]+", target):
        return False

    label_regex = re.compile(r"^(?!-)[a-zA-Z0-9-]{1,63}(?<!-)$")
    labels = target.split(".")

    return all(label_regex.fullmatch(label) for label in labels)


def run_ping(target, count=4, timeout=2):
    """
    Execute ping securely and parse packet-loss and latency metrics.
    """
    if not validate_target(target):
        raise ValueError(f"Invalid target: {target}")

    cmd = ["ping", "-c", str(count), "-W", str(timeout), target]

    try:
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=15,
            shell=False,
        )
    except FileNotFoundError:
        raise RuntimeError("The 'ping' utility is not installed on the system.")
    except subprocess.TimeoutExpired:
        raise RuntimeError("The ping command timed out.")

    stdout = result.stdout
    stderr = result.stderr

    loss_match = re.search(r"(\d+)% packet loss", stdout)

    if not loss_match:
        error_msg = (
            stderr or stdout or "Ping command failed to produce statistics."
        )
        sanitized_msg = error_msg.split("\n")[0][:100]
        raise RuntimeError(f"Ping measurement failed: {sanitized_msg}")

    packet_loss = float(loss_match.group(1))

    latency_min = None
    latency_avg = None
    latency_max = None

    if packet_loss < 100:
        rtt_match = re.search(
            r"rtt min/avg/max/mdev = "
            r"([0-9.]+)/([0-9.]+)/([0-9.]+)/[0-9.]+ ms",
            stdout,
        )

        if rtt_match:
            latency_min = float(rtt_match.group(1))
            latency_avg = float(rtt_match.group(2))
            latency_max = float(rtt_match.group(3))

    return {
        "target": target,
        "packet_loss": packet_loss,
        "latency_min": latency_min,
        "latency_avg": latency_avg,
        "latency_max": latency_max,
    }


def run_ping_concurrently(targets, max_workers=5):
    """
    Run ping measurements concurrently using a bounded thread pool.
    Return one result per target, including individual failures.
    """
    results = []

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_target = {
            executor.submit(run_ping, target): target
            for target in targets
        }

        for future in as_completed(future_to_target):
            target = future_to_target[future]

            try:
                results.append(future.result())
            except Exception as exc:
                logger.error("Concurrent ping failed for %s: %s", target, exc)
                results.append({
                    "target": target,
                    "packet_loss": 100.0,
                    "latency_min": None,
                    "latency_avg": None,
                    "latency_max": None,
                    "error": str(exc),
                })

    return results


def _parse_tracepath_output(stdout):
    """
    Parse tracepath output into hop records.

    Each hop has hop, ip, latency, and type fields.
    A hop with no response is represented as a timeout.
    """
    hops = []

    for line in (stdout or "").splitlines():
        line = line.strip()
        match = re.match(r"^(\d+):\s*(.*)$", line)

        if not match:
            continue

        hop_num = int(match.group(1))
        content = match.group(2).strip()

        if "*" in content or "no reply" in content.lower():
            hops.append({
                "hop": hop_num,
                "ip": None,
                "latency": None,
                "type": "timeout",
            })
            continue

        ip = None
        parenthesized = re.search(r"\(([^)]+)\)", content)

        if parenthesized:
            candidates = [parenthesized.group(1)]
        else:
            candidates = re.findall(r"[a-fA-F0-9:.]+", content)

        for candidate in candidates:
            try:
                ip = str(ipaddress.ip_address(candidate))
                break
            except ValueError:
                continue

        latency_match = re.search(
            r"([0-9]+(?:\.[0-9]+)?)\s*ms",
            content,
        )
        latency = (
            float(latency_match.group(1))
            if latency_match
            else None
        )

        ip_type = "unknown"

        if ip:
            address = ipaddress.ip_address(ip)

            if (
                address.is_private
                or address.is_loopback
                or address.is_link_local
                or address.is_reserved
            ):
                ip_type = "private"
            else:
                ip_type = "public"

        hops.append({
            "hop": hop_num,
            "ip": ip,
            "latency": latency,
            "type": ip_type,
        })

    return hops


def run_tracepath(target, max_hops=20):
    """
    Execute tracepath with non-blocking incremental stdout capture.

    Returns:
        (hops, is_complete)

    Partial hop records are returned if the command times out, provided
    at least one valid hop was captured.
    """
    if not validate_target(target):
        raise ValueError(f"Invalid target: {target}")

    if (
        not isinstance(max_hops, int)
        or isinstance(max_hops, bool)
        or not 1 <= max_hops <= 30
    ):
        raise ValueError("max_hops must be an integer between 1 and 30.")

    cmd = [
        "/usr/bin/tracepath",
        "-n",
        "-m",
        str(max_hops),
        target,
    ]

    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            shell=False,
        )
    except FileNotFoundError:
        raise RuntimeError("The 'tracepath' utility is not installed.")
    except OSError:
        raise RuntimeError("Unable to start the tracepath utility.")

    stdout_lines = []
    buffer = bytearray()
    deadline = time.monotonic() + 15
    timed_out = False
    eof = False

    def consume(chunk):
        """Save complete lines while retaining an incomplete final line."""
        buffer.extend(chunk)

        while b"\n" in buffer:
            line, remainder = buffer.split(b"\n", 1)
            stdout_lines.append(
                line.decode("utf-8", errors="replace")
            )
            buffer[:] = remainder

    def drain_available(fd):
        """Read currently available data without blocking."""
        nonlocal eof

        while not eof:
            try:
                chunk = os.read(fd, 4096)
            except BlockingIOError:
                break

            if not chunk:
                eof = True
                break

            consume(chunk)

    try:
        fd = process.stdout.fileno()
        os.set_blocking(fd, False)

        while not eof:
            remaining = deadline - time.monotonic()

            if remaining <= 0:
                timed_out = True
                break

            readable, _, _ = select.select(
                [fd],
                [],
                [],
                min(0.1, remaining),
            )

            if readable:
                drain_available(fd)

            # EOF is needed before leaving the read loop. A child may exit
            # while unread pipe data remains, so keep draining it.

        if timed_out and process.poll() is None:
            process.terminate()

            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        else:
            process.wait()

        # Read any bytes remaining in the pipe after process termination.
        # The descriptor remains non-blocking, so this cannot wait for data.
        drain_available(fd)

        if buffer:
            stdout_lines.append(
                buffer.decode("utf-8", errors="replace")
            )
            buffer.clear()

        is_complete = (
            not timed_out
            and eof
            and process.returncode == 0
        )

    except (OSError, ValueError, subprocess.SubprocessError):
        if process.poll() is None:
            process.terminate()

            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

        raise RuntimeError(
            "An unexpected error occurred during route discovery."
        )
    finally:
        process.stdout.close()

    hops = _parse_tracepath_output("\n".join(stdout_lines))

    if not hops:
        if timed_out:
            raise RuntimeError(
                "The tracepath command timed out without capturing valid hops."
            )

        raise RuntimeError(
            "Tracepath completed but no valid hops were parsed."
        )

    return hops, is_complete
