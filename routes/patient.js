const express = require('express');
const router = express.Router();
const multer = require('multer');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require('@supabase/supabase-js');

// 1. Setup
const upload = multer({ storage: multer.memoryStorage() });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

router.post('/process-report', upload.single('report'), async (req, res) => {
    console.log("🚀 Processing Report...");
    
    // FIX: Strictly handle 'undefined' or empty strings from frontend
    let existingId = req.body.existingId;
    if (!existingId || existingId === "undefined" || existingId === "" || existingId === "null") {
        existingId = null;
    }
    
    let finalAllviId = existingId;

    try {
        if (!req.file) throw new Error("No file received by server");

        // --- STEP 1: GEMINI AI ---
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        const prompt = `
            Extract biomarkers from this lab report. 
            Return ONLY a raw JSON object. No markdown. No preamble.
            Keys: "test_date", "tsh", "free_t3", "free_t4", "anti_tpo", "ferritin", "vit_d".
        `;

        const result = await model.generateContent([
            prompt,
            { inlineData: { data: req.file.buffer.toString("base64"), mimeType: req.file.mimetype } }
        ]);

        const text = result.response.text();
        
        // FIX: Extract ONLY the JSON part (handles cases where AI adds text)
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI output was not in JSON format");
        const parsedData = JSON.parse(jsonMatch[0]);

        // --- STEP 2: IDENTITY LOGIC ---
        if (!finalAllviId) {
            // Create NEW user if no valid ID provided
            finalAllviId = `ALLVI-${Math.floor(1000 + Math.random() * 9000)}`;
            const { error: pError } = await supabase.from('patients').insert([{ allvi_id: finalAllviId }]);
            if (pError) throw new Error("Supabase Patient Insert Fail: " + pError.message);
        } else {
            // Verify existing ID
            const { data: user, error: fError } = await supabase
                .from('patients')
                .select('allvi_id')
                .eq('allvi_id', finalAllviId)
                .single();
            
            if (fError || !user) return res.status(404).json({ error: "Provided ALLVI-ID not found" });
        }

        // --- STEP 3: DATABASE STORAGE ---
        // Ensure values are numbers or null (avoids 500 errors on empty strings)
        const { error: lError } = await supabase.from('lab_results').insert([{
            patient_id: finalAllviId,
            test_date: parsedData.test_date || new Date().toISOString().split('T')[0],
            tsh: parseFloat(parsedData.tsh) || null,
            free_t3: parseFloat(parsedData.free_t3) || null,
            free_t4: parseFloat(parsedData.free_t4) || null,
            ferritin: parseFloat(parsedData.ferritin) || null,
            vit_d: parseFloat(parsedData.vit_d) || null,
            anti_tpo: parseFloat(parsedData.anti_tpo) || null
        }]);

        if (lError) throw new Error("Supabase Lab Data Fail: " + lError.message);

        // --- STEP 4: SUCCESS ---
        res.status(200).json({
            success: true,
            allvi_id: finalAllviId,
            parsedData: parsedData
        });

    } catch (err) {
        console.error("❌ SERVER CRASH:", err.message);
        res.status(500).json({ 
            success: false, 
            error: "Process Failed", 
            details: err.message 
        });
    }
});

module.exports = router;