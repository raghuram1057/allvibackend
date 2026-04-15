const express = require('express');
const router = express.Router();
const multer = require('multer');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require('@supabase/supabase-js');

// 1. Setup Middleware & Clients
const upload = multer({ storage: multer.memoryStorage() });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * @route   POST /api/patient/process-report
 * @desc    AI Parsing with Gemini + Supabase Create/Update
 */
router.post('/process-report', upload.single('report'), async (req, res) => {
    console.log("🚀 Starting AI Processing...");
    
    const { existingId } = req.body;
    let finalAllviId = existingId;

    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: "No file uploaded" });
        }

        // --- STEP 1: GEMINI AI PARSING ---
        // Using the stable model identifier to avoid 404 Fetch errors
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        const prompt = `
            Analyze this lab report image/PDF. Extract the following biomarkers:
            - test_date (Format: YYYY-MM-DD)
            - tsh
            - free_t3
            - free_t4
            - anti_tpo
            - ferritin
            - vit_d
            
            Return ONLY a raw JSON object. Do not include markdown code blocks.
            If a value is not found, use null.
            Example: {"test_date": "2024-01-01", "tsh": 2.5, "vit_d": 30}
        `;

        const result = await model.generateContent([
            prompt,
            {
                inlineData: {
                    data: req.file.buffer.toString("base64"),
                    mimeType: req.file.mimetype
                }
            }
        ]);

        const response = await result.response;
        const text = response.text();
        
        // CLEANING: Gemini often wraps JSON in ```json blocks; we strip those out
        const cleanJson = text.replace(/```json|```/g, "").trim();
        const parsedData = JSON.parse(cleanJson);
        
        console.log("✅ AI Extraction Complete:", parsedData);

        // --- STEP 2: IDENTITY MANAGEMENT ---
        if (!finalAllviId) {
            // New User: Generate a unique de-identified ID
            finalAllviId = `ALLVI-${Math.floor(1000 + Math.random() * 9000)}`;
            const { error: pError } = await supabase
                .from('patients')
                .insert([{ allvi_id: finalAllviId }]);
            
            if (pError) throw new Error("Supabase Patient Error: " + pError.message);
        } else {
            // Returning User: Verify ID exists
            const { data: existing, error: fError } = await supabase
                .from('patients')
                .select('allvi_id')
                .eq('allvi_id', finalAllviId)
                .single();
            
            if (fError || !existing) {
                return res.status(404).json({ success: false, error: "ALLVI-ID not found in database." });
            }
        }

        // --- STEP 3: STORE DATA IN SUPABASE ---
        const { error: lError } = await supabase
            .from('lab_results')
            .insert([{
                patient_id: finalAllviId,
                test_date: parsedData.test_date || new Date().toISOString().split('T')[0],
                tsh: parseFloat(parsedData.tsh) || null,
                free_t3: parseFloat(parsedData.free_t3) || null,
                free_t4: parseFloat(parsedData.free_t4) || null,
                ferritin: parseFloat(parsedData.ferritin) || null,
                vit_d: parseFloat(parsedData.vit_d) || null,
                anti_tpo: parseFloat(parsedData.anti_tpo) || null
            }]);

        if (lError) throw new Error("Supabase Lab Error: " + lError.message);

        // --- STEP 4: SUCCESS ---
        res.status(200).json({
            success: true,
            allvi_id: finalAllviId,
            parsedData: parsedData
        });

    } catch (err) {
        console.error("❌ CRITICAL ERROR:", err.message);
        res.status(500).json({ 
            success: false, 
            error: "AI Parsing or Database error", 
            details: err.message 
        });
    }
});

// Test route to verify server is live
router.get('/test', (req, res) => {
    res.json({ message: "Patient route is working!" });
});

module.exports = router;