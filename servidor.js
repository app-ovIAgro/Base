/**
 * servidor.js — Servidor HTTP local para desarrollo de OvIAgro
 * Sirve los archivos estáticos de la app sin necesidad de instalar nada.
 * Uso: node servidor.js
 */
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PUERTO = 8080;
const DIR    = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
};

const servidor = http.createServer((req, res) => {
  // Cabeceras de seguridad y CORS para Service Workers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  let urlPath = req.url === '/' ? '/index.html' : req.url;
  // Ignorar query strings
  urlPath = urlPath.split('?')[0];

  const archivoLocal = path.join(DIR, urlPath);
  const ext = path.extname(archivoLocal).toLowerCase();
  const tipoMime = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(archivoLocal, (err, data) => {
    if (err) {
      // Si no encuentra el archivo, sirve index.html (SPA fallback)
      fs.readFile(path.join(DIR, 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': tipoMime });
    res.end(data);
  });
});

servidor.listen(PUERTO, '127.0.0.1', () => {
  console.log(`\n🐑 OvIAgro — Servidor corriendo en: http://127.0.0.1:${PUERTO}`);
  console.log('   Presioná Ctrl+C para detenerlo.\n');
});
