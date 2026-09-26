const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const ratingRoutes = require('./routes/rating.routes');
const timesheetRoutes = require('./routes/timesheet.routes');
const paymentRoutes = require('./routes/payment.routes');
const adminRoutes = require('./routes/admin.routes');
const errorHandler = require('./middleware/errorHandler');


const app = express();

// CORS — must come before other middleware
const allowedOrigins = [
  "http://localhost:3000",
  "https://airhub-tool.vercel.app",
];

const corsOptions = {
  origin: allowedOrigins,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // handle preflight for all routes

// Security & Performance
app.use(helmet());
app.use(compression());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 100,
  message: { success: false, message: 'Too many requests. Please try again later.' },
});
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, message: 'AI rate limit reached. Wait 1 minute.' },
});

app.use('/api/', limiter);
app.use('/api/ratings/evaluate', aiLimiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Logging
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/ratings', ratingRoutes);
app.use('/api/timesheets', timesheetRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin', adminRoutes);
const toolsRoutes = require('./routes/tools.routes');
app.use('/api/tools', toolsRoutes);

// 404
app.use('*', (req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// Global error handler
app.use(errorHandler);

module.exports = app;
 