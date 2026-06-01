import http from 'node:http';
import process from 'node:process';
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientDir = join(__dirname, 'dist', 'client');

// Load .env file (native, no dotenv dependency needed)
try {
  const envPath = join(__dirname, '.env');
  readFileSync(envPath, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .forEach(line => {
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) return;
      const key = line.slice(0, eqIdx).trim();
      let val = line.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = val;
      }
    });
} catch { /* .env not found, skip */ }

// Load catalog module for debugging
const assetsDir = join(__dirname, 'dist', 'server', 'assets');
const catalogFile = readdirSync(assetsDir).find(f => f.startsWith('catalog.functions-'));
if (catalogFile) {
  try {
    const catalogModule = await import(pathToFileURL(join(assetsDir, catalogFile)));
    const handler = catalogModule.getHomeData_createServerFn_handler;
    if (handler) {
      try {
        const result = await handler();
        console.log('[CATALOG] womenTops:', result.womenTops?.length, 'menNew:', result.menNewArrivals?.length, 'menBest:', result.menBestSellers?.length);
      } catch (e) {
        // Expected: No Start context - this is fine
      }
    }
  } catch { /* skip */ }
}

const server = await import(pathToFileURL(join(__dirname, 'dist', 'server', 'server.js'))).then(m => m.default);

const MIME_TYPES = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.html': 'text/html',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
};

function serveStaticFile(res, filePath) {
  try {
    const stats = statSync(filePath);
    const ext = extname(filePath).toLowerCase();
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': mimeType,
      'Content-Length': stats.size,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    createReadStream(filePath).pipe(res);
    return true;
  } catch {
    return false;
  }
}

const port = process.env.PORT || 3000;

http.createServer(async (req, res) => {
  // Serve static files from dist/client/
  if (req.url && (req.url.startsWith('/assets/') || req.url === '/favicon.ico')) {
    const filePath = join(clientDir, req.url.split('?')[0]);
    if (serveStaticFile(res, filePath)) return;
  }

  // SSR: forward to TanStack Start server
  const protocol = req.socket.encrypted ? 'https' : 'http';
  const host = req.headers.host || 'localhost';
  const url = new URL(req.url, `${protocol}://${host}`);

  let body = undefined;
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  }

  const fetchRequest = new Request(url, {
    method: req.method,
    headers: req.headers,
    body,
  });

  try {
    const response = await server.fetch(fetchRequest, {}, {});
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Server Error</h1>');
  }
}).listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
