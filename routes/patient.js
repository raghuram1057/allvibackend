const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

// 1. Diagnostics (Check Render Logs for this)
console.log("Backend Initializing...");
console.log("Check - Gemini Key Configured:", !!process.env.GEMINI_API_KEY);
console.log("Check - Supabase Configured:", !!process.env.SUPABASE_URL);

const upload = multer({ storage: multer.memoryStorage() });

// 2. Initialize Clients
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

router.post('/process-report', upload.single('report'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: "File missing" });

        // --- STEP 1: DE-IDENTIFICATION ---
        // Generate a random ID (e.g., ALLVI-4921)
        const allviId = `ALLVI-${Math.floor(1000 + Math.random() * 9000)}`;

        // --- STEP 2: AI PARSING ---
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = "Extract biomarkers as JSON: test_date, tsh, vit_d, ferritin, free_t3, free_t4, anti_tpo. Return ONLY valid JSON. Use null if not found.";

        const result = await model.generateContent([
            prompt,
            {
                inlineData: {
                    data: req.file.buffer.toString("base64"),
                    mimeType: req.file.mimetype,
                },
            },
        ]);

        const text = result.response.text();
        
        // Clean markdown backticks if Gemini adds them (e.g. ```json ... ```)
        const cleanJson = text.replace(/```json|```/g, "").trim();
        const parsedData = JSON.parse(cleanJson);

        // --- STEP 3: RESPONSE ---
        // We return the data to the frontend for Phase1Review.jsx
        res.status(200).json({ 
            success: true, 
            parsedData: parsedData,
            allvi_id: allviId 
        });

    } catch (err) {
        console.error("CRITICAL ERROR:", err.message);
        res.status(500).json({ 
            success: false, 
            error: "Server Error", 
            details: err.message 
        });
    }
});

// Final Save Route (Used by Phase1Review.jsx)
router.post('/confirm-results', async (req, res) => {
    try {
        const { patientId, biomarkers } = req.body;

        const { data, error } = await supabase
            .from('lab_results')
            .insert([{ patient_id: patientId, ...biomarkers }]);

        if (error) throw error;

        res.status(200).json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;