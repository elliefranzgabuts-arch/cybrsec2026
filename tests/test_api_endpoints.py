import unittest
from unittest.mock import patch, MagicMock
from backend.main import app

class TestApiEndpoints(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_endpoints_route_success(self):
        """Verify /api/endpoints returns a list of authorized servers with required fields."""
        response = self.client.get('/api/endpoints')
        self.assertEqual(response.status_code, 200)

        data = response.get_json()
        self.assertIsInstance(data, list)

        if len(data) > 0:
            first_ep = data[0]
            self.assertIn('name', first_ep)
            self.assertIn('target', first_ep)
            self.assertIn('lat', first_ep)
            self.assertIn('lon', first_ep)

if __name__ == '__main__':
    unittest.main()
