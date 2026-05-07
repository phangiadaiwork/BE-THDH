require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ensureDefaultAdmin } = require('./utils/ensureDefaultAdmin');

const authRoutes = require('./routes/auth');
const studentRoutes = require('./routes/students');
const examRoutes = require('./routes/exams');
const attemptRoutes = require('./routes/attempts');

const app = express();

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
  })
);
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/exams', examRoutes);
app.use('/api/attempts', attemptRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use((err, _req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3001;

async function startServer() {
  try {
    await ensureDefaultAdmin();
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  } catch (error) {
    console.error('Failed to initialize server:', error);
    process.exit(1);
  }
}

startServer();
