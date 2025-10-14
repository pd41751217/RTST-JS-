import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function mountFrontend(app) {
  const frontendDir = path.resolve(__dirname, '../../frontend/public');
  app.use('/', express.static(frontendDir));
}


