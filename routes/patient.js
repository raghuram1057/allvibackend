const express = require('express');
const router = express.Router();
const multer = require('multer');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require('@supabase/supabase-js');

// 1. Config & Middleware
const upload = multer({ storage: multer.memoryStorage() });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * @route   POST /api/patient/process-report
 * @desc    AI Parsing + Create/Update Patient Data
 */
router.post('/process-report', upload.single('report'), async (req, res) => {
    console.log("🚀 Processing Upload Request...");
    
    const { existingId } = req.body;
    let finalAllviId = existingId;

    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: "No file uploaded" });
        }

        // --- STEP 1: GEMINI AI PARSING ---
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        const prompt = `
            Extract biomarkers from this lab report. 
            Return ONLY a valid JSON object. No preamble, no explanation.
            Keys: "test_date" (YYYY-MM-DD), "tsh", "free_t3", "free_t4", "anti_tpo", "ferritin", "vit_d".
            Use null for missing values.
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

        const text = result.response.text();
        
        // BULLETPROOF PARSING: Extract JSON even if AI adds extra text
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI failed to return valid data format");
        const parsedData = JSON.parse(jsonMatch[0]);
        
        console.log("✅ AI Parsed Data:", parsedData);

        // --- STEP 2: IDENTITY MANAGEMENT ---
        if (!finalAllviId || finalAllviId === "undefined") {
            // New User
            finalAllviId = `ALLVI-${Math.floor(1000 + Math.random() * 9000)}`;
            const { error: pError } = await supabase
                .from('patients')
                .insert([{ allvi_id: finalAllviId }]);
            
            if (pError) throw new Error("Database error (Patient ID): " + pError.message);
        } else {
            // Returning User: Verify ID
            const { data: existing, error: fError } = await supabase
                .from('patients')
                .select('allvi_id')
                .eq('allvi_id', finalAllviId)
                .single();
            
            if (fError || !existing) {
                return res.status(404).json({ success: false, error: "ALLVI-ID not found." });
            }
        }

        // --- STEP 3: STORE IN SUPABASE ---
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

        if (lError) throw new Error("Database error (Lab Results): " + lError.message);

        // --- STEP 4: SUCCESS ---
        res.status(200).json({
            success: true,
            allvi_id: finalAllviId,
            parsedData: parsedData
        });

    } catch (err) {
        console.error("❌ ERROR:", err.message);
        res.status(500).json({ 
            success: false, 
            error: "Process Failed", 
            details: err.message 
        });
    }
});

// Health check
router.get('/test', (req, res) => res.json({ message: "Server is online!" }));

module.exports = router;