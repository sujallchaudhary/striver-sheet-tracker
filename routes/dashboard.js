const { Router } = require('express');
const { buildDashboard } = require('../lib/dashboard');

const router = Router();

router.get('/dashboard', (req, res) => res.json(buildDashboard()));

module.exports = router;
