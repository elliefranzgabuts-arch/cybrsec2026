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
            returncode=1
        )
        # The parser should default to 100% loss if "packet loss" string is missing
        res = run_ping("8.8.8.8")
        self.assertEqual(res['packet_loss'], 100.0)
        self.assertIsNone(res['latency_avg'])

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
        # Mock total failure (ping utility missing)
        mock_run.side_effect = FileNotFoundError
        targets = ["8.8.8.8", "1.1.1.1"]
        results = run_ping_concurrently(targets)
        self.assertEqual(len(results), 2)
        for res in results:
            self.assertEqual(res['packet_loss'], 100.0)
            self.assertIn('error', res)

if __name__ == '__main__':
    unittest.main()
