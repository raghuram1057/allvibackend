const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid'); // To generate unique IDs

const upload = multer({ storage: multer.memoryStorage() });

// Initialize Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

router.post('/process-report', upload.single('report'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "File missing" });

        // --- STEP 1: DE-IDENTIFICATION ---
        // Create a unique Patient ID (e.g., ALLVI-XXXX)
        const shortId = Math.floor(1000 + Math.random() * 9000); 
        const patientId = `ALLVI-${shortId}`;

        // --- STEP 2: AI PARSING ---
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `
            Extract these specific biomarkers from the lab report: 
            test_date, tsh, free_t3, free_t4, anti_tpo, ferritin, vit_d. 
            Return ONLY a valid JSON object. Use null for missing values.
        `;

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
        const cleanJson = text.replace(/```json|```/g, "").trim();
        const parsedData = JSON.parse(cleanJson);

        // --- STEP 3: DATABASE STORAGE (Supabase) ---
        // We store ONLY the Patient ID and the clinical data
        const { data, error } = await supabase
            .from('lab_results') // Ensure this table exists in Supabase
            .insert([
                { 
                    patient_id: patientId, 
                    ...parsedData,
                    created_at: new Date() 
                }
            ]);

        if (error) throw error;

        // --- STEP 4: RESPONSE ---
        res.status(200).json({ 
            success: true, 
            patientId: patientId, // Return this so the user knows their ID
            data: parsedData 
        });

    } catch (err) {
        console.error("Backend Error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;