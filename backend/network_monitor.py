
import ipaddress
import logging
import re
import shutil
import socket
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def validate_target(target):
    """Validate an IPv4 address, IPv6 address, or hostname."""
    if not isinstance(target, str):
        return False

    target = target.strip()

    if not target or len(target) > 253:
        return False

    try:
        ipaddress.ip_address(target)
        return True
    except ValueError:
        pass

    # Reject malformed numeric IP-like targets.
    if re.fullmatch(r"[\d.]+", target):
        return False

    hostname = target[:-1] if target.endswith(".") else target

    if not hostname:
        return False

    label_regex = re.compile(r"^(?!-)[a-zA-Z0-9-]{1,63}(?<!-)$")
    labels = hostname.split(".")

    if any(not label for label in labels):
        return False

    return all(label_regex.fullmatch(label) for label in labels)


def run_ping(target, count=4, timeout=2):
    """Run ping and return packet loss and latency statistics."""
    if not validate_target(target):
        raise ValueError(f"Invalid target: {target}")

    if not isinstance(count, int) or isinstance(count, bool) or count < 1:
        raise ValueError("count must be a positive integer.")

    if (
        not isinstance(timeout, (int, float))
        or isinstance(timeout, bool)
        or timeout <= 0
    ):
        raise ValueError("timeout must be a positive number.")

    ping_path = shutil.which("ping")

    if not ping_path:
        raise RuntimeError("The 'ping' utility is not installed on the system.")

    cmd = [
        ping_path,
        "-c",
        str(count),
        "-W",
        str(max(1, int(timeout))),
        target.strip(),
    ]

    try:
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=max(15, count * timeout + 5),
            shell=False,
            check=False,
        )
    except FileNotFoundError:
        raise RuntimeError(
            "The 'ping' utility is not installed on the system."
        ) from None
    except subprocess.TimeoutExpired:
        raise RuntimeError("The ping command timed out.") from None
    except OSError:
        raise RuntimeError("Unable to start the ping utility.") from None

    stdout = result.stdout or ""
    stderr = result.stderr or ""

    loss_match = re.search(
        r"(\d+(?:\.\d+)?)%\s*packet loss",
        stdout,
        re.IGNORECASE,
    )

    if not loss_match:
        error_msg = (
            stderr.strip()
            or stdout.strip()
            or "Ping command failed to produce statistics."
        )
        sanitized_msg = error_msg.splitlines()[0][:100]
        raise RuntimeError(f"Ping measurement failed: {sanitized_msg}")

    packet_loss = float(loss_match.group(1))
    latency_min = None
    latency_avg = None
    latency_max = None

    if packet_loss < 100:
        rtt_match = re.search(
            r"(?:rtt|round-trip)\s+min/avg/max"
            r"(?:/mdev|/stddev)?\s*=\s*"
            r"([0-9.]+)/([0-9.]+)/([0-9.]+)",
            stdout,
            re.IGNORECASE,
        )

        if rtt_match:
            latency_min = float(rtt_match.group(1))
            latency_avg = float(rtt_match.group(2))
            latency_max = float(rtt_match.group(3))

    return {
        "target": target.strip(),
        "packet_loss": packet_loss,
        "latency_min": latency_min,
        "latency_avg": latency_avg,
        "latency_max": latency_max,
    }


def run_ping_concurrently(targets, max_workers=5):
    """Run ping against multiple targets concurrently."""
    if (
        not isinstance(max_workers, int)
        or isinstance(max_workers, bool)
        or max_workers < 1
    ):
        raise ValueError("max_workers must be a positive integer.")

    results = []
    targets = list(targets)

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
                logger.error(
                    "Concurrent ping failed for %s: %s",
                    target,
                    exc,
                )
                results.append({
                    "target": target,
                    "packet_loss": 100.0,
                    "latency_min": None,
                    "latency_avg": None,
                    "latency_max": None,
                    "error": str(exc),
                })

    return results


def _classify_ip(ip):
    """Classify an IP address for display in the traceroute results."""
    address = ipaddress.ip_address(ip)

    if (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_reserved
    ):
        return "private"

    return "public"


def _parse_tracepath_output(stdout):
    """
    Parse tracepath output into one record per hop number.

    Multiple lines for the same hop are consolidated. A valid IP result
    takes priority over an earlier unknown or timeout result.
    """
    if isinstance(stdout, bytes):
        stdout = stdout.decode("utf-8", errors="replace")

    hops_by_number = {}

    for line in (stdout or "").splitlines():
        line = line.strip()
        match = re.match(r"^(\d+)(?:\?)?:\s*(.*)$", line)

        if not match:
            continue

        hop_num = int(match.group(1))
        content = match.group(2).strip()

        if not content:
            continue

        existing = hops_by_number.get(hop_num)

        # Once a valid IP is recorded for this hop, ignore duplicate
        # responses for the same hop number.
        if existing is not None and existing["ip"] is not None:
            continue

        # Ignore local tracepath metadata rather than reporting it as a hop.
        if re.search(r"\[LOCALHOST\]|\bpmtu\b", content, re.IGNORECASE):
            continue

        if (
            "*" in content
            or re.search(r"\bno\s+reply\b", content, re.IGNORECASE)
        ):
            if existing is None:
                hops_by_number[hop_num] = {
                    "hop": hop_num,
                    "ip": None,
                    "latency": None,
                    "type": "timeout",
                }
            continue

        parenthesized = re.search(r"\(([^)]+)\)", content)

        if parenthesized:
            candidates = [parenthesized.group(1)]
        else:
            candidates = re.findall(
                r"(?<![a-zA-Z0-9_-])[a-fA-F0-9:.]+(?![a-zA-Z0-9_-])",
                content,
            )

        ip = None

        for candidate in candidates:
            try:
                ip = str(ipaddress.ip_address(candidate))
                break
            except ValueError:
                continue

        latency_match = re.search(
            r"([0-9]+(?:\.[0-9]+)?)\s*ms\b",
            content,
            re.IGNORECASE,
        )
        latency = float(latency_match.group(1)) if latency_match else None

        if ip is None:
            # Do not replace an existing timeout with an unknown record.
            if existing is None:
                hops_by_number[hop_num] = {
                    "hop": hop_num,
                    "ip": None,
                    "latency": latency,
                    "type": "unknown",
                }
            continue

        hops_by_number[hop_num] = {
            "hop": hop_num,
            "ip": ip,
            "latency": latency,
            "type": _classify_ip(ip),
        }

    return [
        hops_by_number[hop_num]
        for hop_num in sorted(hops_by_number)
    ]


def run_tracepath(target, max_hops=5, timeout=30):
    """Run tracepath and return (hop_records, destination_reached)."""
    if not validate_target(target):
        raise ValueError(f"Invalid target: {target}")

    if (
        not isinstance(max_hops, int)
        or isinstance(max_hops, bool)
        or not 1 <= max_hops <= 30
    ):
        raise ValueError("max_hops must be an integer between 1 and 30.")

    if (
        not isinstance(timeout, (int, float))
        or isinstance(timeout, bool)
        or timeout <= 0
    ):
        raise ValueError("timeout must be a positive number.")

    target = target.strip()
    tracepath_path = shutil.which("tracepath")
    if not tracepath_path:
        raise RuntimeError("The 'tracepath' utility is not installed.")

    # Resolve all available destination addresses for comparison.
    try:
        target_addresses = {
            ipaddress.ip_address(info[4][0])
            for info in socket.getaddrinfo(
                target, None, type=socket.SOCK_DGRAM
            )
        }
    except (socket.gaierror, OSError):
        target_addresses = set()

    cmd = [tracepath_path, "-n", "-m", str(max_hops), target]
    stdout_content = ""
    timed_out = False

    try:
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            shell=False,
            check=False,
        )
        stdout_content = result.stdout or ""

        if result.returncode != 0:
            logger.warning(
                "tracepath exited with status %s for %s.",
                result.returncode,
                target,
            )

    except subprocess.TimeoutExpired as exc:
        timed_out = True
        stdout_content = exc.stdout or ""
        if isinstance(stdout_content, bytes):
            stdout_content = stdout_content.decode(
                "utf-8", errors="replace"
            )
        logger.warning(
            "tracepath timed out for %s after %s seconds.",
            target,
            timeout,
        )

    except FileNotFoundError:
        raise RuntimeError(
            "The 'tracepath' utility is not installed."
        ) from None
    except OSError:
        raise RuntimeError(
            "Unable to start the tracepath utility."
        ) from None
    except Exception as exc:
        logger.exception(
            "Unexpected tracepath error for %s: %s", target, exc
        )
        raise RuntimeError(
            "An unexpected error occurred during route discovery."
        ) from exc

    hops = _parse_tracepath_output(stdout_content)

    if not hops:
        if timed_out:
            raise RuntimeError(
                "The tracepath command timed out before any valid hops "
                "were captured. Try again or use a reachable target."
            )
        raise RuntimeError(
            "Tracepath completed but no valid hops were captured."
        )

    # Do not equate a successful process exit with reaching the target.
    destination_reached = False
    if not timed_out:
        for hop in hops:
            hop_address = hop.get("ip")
            if not hop_address:
                continue
            try:
                parsed_address = ipaddress.ip_address(hop_address)
            except ValueError:
                continue
            if parsed_address in target_addresses:
                destination_reached = True
                break

    if timed_out:
        logger.warning(
            "Returning %d partial hop records for %s.",
            len(hops),
            target,
        )

    return hops, destination_reached
