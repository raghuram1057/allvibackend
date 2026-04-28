require('dotenv').config();
const express = require('express');
const cors = require('cors');
const patientRoutes = require('./routes/patient');

const app = express();

// Middleware
app.use(cors({methods: ['GET', 'POST', 'PUT', 'DELETE']})); // Allows React to talk to Express
app.use(express.json()); // Parses the data you send from React
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Routes
app.use('/api/patient', patientRoutes);

// Health check to verify server is alive
app.get('/', (req, res) => res.send('Allvi Server is Running!'));

const PORT = 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is live at http://localhost:${PORT}`);
    console.log(`🚀 Also reachable at http://127.0.0.1:${PORT}`);
});