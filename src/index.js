import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './database.js';
import authRoutes from './routes/auth.js';
import photoRoutes from './routes/photos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use((_req, res, next) => {
  const origEnd = res.end;
  res.end = function (...args) {
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(_req.method)) {
      db.save();
    }
    return origEnd.apply(this, args);
  };
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/photos', photoRoutes);

app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.use(express.static(path.join(__dirname, '..', 'dist')));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PicFlow server running on http://0.0.0.0:${PORT}`);
});
