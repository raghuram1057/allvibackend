require('dotenv').config();
const express = require('express');
const cors = require('cors');
const patientRoutes = require('./routes/patient');

const app = express();

// Middleware
app.use(cors()); // Allows React to talk to Express
app.use(express.json()); // Parses the data you send from React

// Routes
app.use('/api/patient', patientRoutes);

// Health check to verify server is alive
app.get('/', (req, res) => res.send('Allvi Server is Running!'));

const PORT = 5000;
app.listen(PORT, () => {
    console.log(`🚀 Server started on http://localhost:${PORT}`);
});