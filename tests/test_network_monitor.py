import unittest
from unittest.mock import patch, MagicMock
import subprocess
from backend.network_monitor import validate_target, run_ping, run_ping_concurrently

class TestNetworkMonitor(unittest.TestCase):

    def test_target_validation(self):
        # Valid targets
        self.assertTrue(validate_target("8.8.8.8"))
        self.assertTrue(validate_target("2001:4860:4860::8888"))
        self.assertTrue(validate_target("google.com"))
        self.assertTrue(validate_target("my-server.local"))
        self.assertTrue(validate_target("a.b.c.d"))

        # Invalid targets
        self.assertFalse(validate_target("invalid target")) # Space
        self.assertFalse(validate_target("google.com; ls")) # Injection
        self.assertFalse(validate_target("8.8.8.256")) # Invalid IP (though validate_target relies on ipaddress)
        self.assertFalse(validate_target("-google.com")) # Leading hyphen
        self.assertFalse(validate_target("google-.com")) # Trailing hyphen in label
        self.assertFalse(validate_target("google..com")) # Empty label
        self.assertFalse(validate_target("a" * 254)) # Too long
        self.assertFalse(validate_target("")) # Empty
        self.assertFalse(validate_target(None)) # Not a string

    @patch('subprocess.run')
    def test_run_ping_success(self, mock_run):
        # Mock 0% loss and valid latency
        mock_run.return_value = MagicMock(
            stdout="4 packets transmitted, 4 received, 0% packet loss, time 3004ms\nrtt min/avg/max/mdev = 10.1/12.5/15.2/1.1 ms",
            returncode=0
        )

        res = run_ping("8.8.8.8")
        self.assertEqual(res['packet_loss'], 0.0)
        self.assertEqual(res['latency_avg'], 12.5)
        self.assertEqual(res['latency_min'], 10.1)
        self.assertEqual(res['latency_max'], 15.2)

    @patch('subprocess.run')
    def test_run_ping_full_loss(self, mock_run):
        # Mock 100% loss
        mock_run.return_value = MagicMock(
            stdout="4 packets transmitted, 0 received, 100% packet loss, time 3004ms",
            returncode=1
        )

        res = run_ping("1.1.1.1")
        self.assertEqual(res['packet_loss'], 100.0)
        self.assertIsNone(res['latency_avg'])
        self.assertIsNone(res['latency_min'])
        self.assertIsNone(res['latency_max'])

    @patch('subprocess.run')
    def test_run_ping_partial_loss(self, mock_run):
        # Mock 50% loss
        mock_run.return_value = MagicMock(
            stdout="4 packets transmitted, 2 received, 50% packet loss, time 3004ms\nrtt min/avg/max/mdev = 10.1/12.5/15.2/1.1 ms",
            returncode=0
        )

        res = run_ping("8.8.8.8")
        self.assertEqual(res['packet_loss'], 50.0)
        self.assertEqual(res['latency_avg'], 12.5)

    @patch('subprocess.run')
    def test_run_ping_timeout(self, mock_run):
        mock_run.side_effect = subprocess.TimeoutExpired(cmd=['ping'], timeout=15)
        with self.assertRaises(RuntimeError) as cm:
            run_ping("8.8.8.8")
        self.assertEqual(str(cm.exception), "The ping command timed out.")

    @patch('subprocess.run')
    def test_run_ping_missing_utility(self, mock_run):
        mock_run.side_effect = FileNotFoundError
        with self.assertRaises(RuntimeError) as cm:
            run_ping("8.8.8.8")
        self.assertEqual(str(cm.exception), "The 'ping' utility is not installed on the system.")

    @patch('subprocess.run')
    def test_run_ping_malformed_output(self, mock_run):
        # Mock unexpected output format
        mock_run.return_value = MagicMock(
            stdout="Something went wrong with ping",
            stderr="",
            returncode=1
        )
        # The parser should now raise RuntimeError instead of defaulting to 100% loss
        with self.assertRaises(RuntimeError) as cm:
            run_ping("8.8.8.8")
        self.assertIn("Ping measurement failed", str(cm.exception))

    @patch('subprocess.run')
    def test_run_ping_concurrently_success(self, mock_run):
        # Mock 0% loss and valid latency for all targets
        mock_run.return_value = MagicMock(
            stdout="4 packets transmitted, 4 received, 0% packet loss, time 3004ms\nrtt min/avg/max/mdev = 10.1/12.5/15.2/1.1 ms",
            returncode=0
        )
        targets = ["8.8.8.8", "1.1.1.1"]
        results = run_ping_concurrently(targets)
        self.assertEqual(len(results), 2)
        for res in results:
            self.assertEqual(res['packet_loss'], 0.0)
            self.assertEqual(res['latency_avg'], 12.5)

    @patch('subprocess.run')
    def test_run_ping_concurrently_partial_failure(self, mock_run):
        # Mock some targets as successful and others as failing
        def side_effect(cmd, **kwargs):
            target = cmd[-1]
            if target == "8.8.8.8":
                return MagicMock(
                    stdout="4 packets transmitted, 4 received, 0% packet loss, time 3004ms\nrtt min/avg/max/mdev = 10.1/12.5/15.2/1.1 ms",
                    returncode=0
                )
            else:
                raise subprocess.TimeoutExpired(cmd, 15)

        mock_run.side_effect = side_effect
        targets = ["8.8.8.8", "1.1.1.1"]
        results = run_ping_concurrently(targets)

        self.assertEqual(len(results), 2)
        success = next(r for r in results if r['target'] == "8.8.8.8")
        failure = next(r for r in results if r['target'] == "1.1.1.1")
        self.assertEqual(success['packet_loss'], 0.0)
        self.assertEqual(failure['packet_loss'], 100.0)
        self.assertIn('error', failure)

    @patch('subprocess.run')
    def test_run_ping_concurrently_total_failure(self, mock_run):
        mock_run.side_effect = FileNotFoundError
        targets = ["8.8.8.8", "1.1.1.1"]

        results = run_ping_concurrently(targets)

        self.assertEqual(len(results), 2)
        for result in results:
            self.assertEqual(result['packet_loss'], 100.0)
            self.assertIn('error', result)

    @patch('subprocess.run')
    def test_run_tracepath_parsing(self, mock_run):
        # Mock a tracepath output with various formats
        mock_run.return_value = MagicMock(
            stdout=(
                "1: (192.168.1.1)  0.5 ms\n"
                "2: 10.0.0.1 2.1 ms\n"
                "3: * * *\n"
                "4: (8.8.8.8) 15.2 ms\n"
                "5: invalid-ip 10.0 ms\n"
                "6: 2001:4860:4860::8888 20.1 ms"
            ),
            returncode=0
        )

        from backend.network_monitor import run_tracepath
        results, complete = run_tracepath("google.com")

        self.assertFalse(complete)
        self.assertEqual(len(results), 6)
        # Hop 1: Parenthesized private
        self.assertEqual(results[0]['ip'], "192.168.1.1")
        self.assertEqual(results[0]['type'], "private")
        # Hop 2: Plain private
        self.assertEqual(results[1]['ip'], "10.0.0.1")
        self.assertEqual(results[1]['type'], "private")
        # Hop 3: Timeout
        self.assertEqual(results[2]['type'], "timeout")
        self.assertIsNone(results[2]['ip'])
        # Hop 4: Parenthesized public
        self.assertEqual(results[3]['ip'], "8.8.8.8")
        self.assertEqual(results[3]['type'], "public")
        # Hop 5: Invalid IP
        self.assertEqual(results[4]['ip'], None)
        self.assertEqual(results[4]['type'], "unknown")
        # Hop 6: Plain IPv6 public
        self.assertEqual(results[5]['ip'], "2001:4860:4860::8888")
        self.assertEqual(results[5]['type'], "public")

    @patch('subprocess.run')
    def test_run_tracepath_timeout_partial(self, mock_run):
        # Mock TimeoutExpired. Note: stdout is a positional arg in TimeoutExpired
        mock_run.side_effect = subprocess.TimeoutExpired(
            cmd=['tracepath'],
            timeout=15,
            output="1: (192.168.1.1) 0.5 ms\n2: 10.0.0.1 2.1 ms\n3: *"
        )

        from backend.network_monitor import run_tracepath
        results, complete = run_tracepath("google.com")

        self.assertFalse(complete)
        self.assertEqual(len(results), 3)
        self.assertEqual(results[0]['ip'], "192.168.1.1")
        self.assertEqual(results[2]['type'], "timeout")

    @patch('subprocess.run')
    def test_run_tracepath_no_valid_hops(self, mock_run):
        mock_run.return_value = MagicMock(
            stdout="Tracepath output without any valid hop lines",
            stderr="",
            returncode=0
        )

        from backend.network_monitor import run_tracepath
        with self.assertRaisesRegex(RuntimeError, "no valid hops"):
            run_tracepath("google.com")

if __name__ == '__main__':
    unittest.main()
