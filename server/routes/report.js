const fs = require('fs');
const path = require('path');
const express = require('express');
const puppeteer = require('puppeteer');
const { buildReport } = require('../../recon/report/buildReport');
const { renderHtml } = require('../../recon/report/renderHtml');
const config = require('../config');

const router = express.Router();

function resolveReportPath(scanId) {
  const safe = String(scanId || '').trim();
  if (!safe || !/^[A-Za-z0-9._-]+$/.test(safe)) return null;
  return path.resolve(__dirname, '..', '..', 'results', 'clean', `${safe}_viz.json`);
}

router.get('/full', (req, res) => {
  const scanId = req.query.scanId;
  const reportPath = resolveReportPath(scanId);
  if (!reportPath) return res.status(400).send('Invalid scanId');
  fs.readFile(reportPath, 'utf8', (err, data) => {
    if (err) return res.status(404).send('Report source not found');
    try {
      const graph = JSON.parse(data || '{}');
      const report = buildReport(graph, { scanId, generatedAt: new Date().toISOString() });
      const html = renderHtml(report);
      res.type('text/html').send(html);
    } catch (e) {
      res.status(500).send('Failed to build report');
    }
  });
});

router.get('/full.json', (req, res) => {
  const scanId = req.query.scanId;
  const reportPath = resolveReportPath(scanId);
  if (!reportPath) return res.status(400).json({ error: 'Invalid scanId' });
  fs.readFile(reportPath, 'utf8', (err, data) => {
    if (err) return res.status(404).json({ error: 'Report source not found' });
    try {
      const graph = JSON.parse(data || '{}');
      const report = buildReport(graph, { scanId, generatedAt: new Date().toISOString() });
      res.json(report);
    } catch (e) {
      res.status(500).json({ error: 'Failed to build report' });
    }
  });
});

router.get('/full.pdf', async (req, res) => {
  const scanId = req.query.scanId;
  const reportPath = resolveReportPath(scanId);
  if (!reportPath) return res.status(400).send('Invalid scanId');
  try {
    const raw = await fs.promises.readFile(reportPath, 'utf8');
    const graph = JSON.parse(raw || '{}');
    const report = buildReport(graph, { scanId, generatedAt: new Date().toISOString() });
    const html = renderHtml(report);

    const args = config.pdf.allowNoSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : [];
    const browser = await puppeteer.launch({
      headless: 'new',
      args,
      timeout: config.pdf.timeout
    });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(config.pdf.timeout);
      page.setDefaultNavigationTimeout(config.pdf.timeout);
      await page.setContent(html, { waitUntil: 'load' });
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '16mm', bottom: '16mm', left: '12mm', right: '12mm' }
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${scanId}_full_report.pdf"`);
      res.send(pdf);
    } finally {
      await browser.close();
    }
  } catch (e) {
    if (e && e.code === 'ENOENT') return res.status(404).send('Report source not found');
    res.status(500).send('Failed to build PDF');
  }
});

module.exports = router;
