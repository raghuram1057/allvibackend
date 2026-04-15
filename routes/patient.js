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
    console.log("🚀 Request received");
    
    // Initialize variable outside the try block so it's always defined
    let finalAllviId = null; 

    try {
        if (!req.file) throw new Error("No file uploaded");

        // 1. Handle incoming ID (clean it)
        const inputId = req.body.existingId;
        finalAllviId = (inputId && inputId !== "undefined" && inputId !== "null") ? inputId : null;

        // 2. Gemini Parsing
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `Extract biomarkers: test_date, tsh, free_t3, free_t4, anti_tpo, ferritin, vit_d. Return ONLY JSON.`;

        const result = await model.generateContent([
            prompt,
            { inlineData: { data: req.file.buffer.toString("base64"), mimeType: req.file.mimetype } }
        ]);

        const text = result.response.text();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI failed to return valid JSON");
        const parsedData = JSON.parse(jsonMatch[0]);

        // 3. Identity Logic
        if (!finalAllviId) {
            // New User
            finalAllviId = `ALLVI-${Math.floor(1000 + Math.random() * 9000)}`;
            const { error: pError } = await supabase.from('patients').insert([{ allvi_id: finalAllviId }]);
            if (pError) throw pError;
        } else {
            // Check if existing ID is valid
            const { data: user } = await supabase.from('patients').select('allvi_id').eq('allvi_id', finalAllviId).single();
            if (!user) return res.status(404).json({ success: false, error: "ID not found" });
        }

        // 4. Save Lab Data
        const { error: lError } = await supabase.from('lab_results').insert([{
            patient_id: finalAllviId,
            test_date: parsedData.test_date || new Date().toISOString().split('T')[0],
            tsh: parseFloat(parsedData.tsh) || null,
            anti_tpo: parseFloat(parsedData.anti_tpo) || null
            // ... add other fields here
        }]);

        if (lError) throw lError;

        // Success!
        res.status(200).json({
            success: true,
            allvi_id: finalAllviId,
            parsedData: parsedData
        });

    } catch (err) {
        console.error("❌ Error details:", err.message);
        res.status(500).json({ 
            success: false, 
            error: "Process Failed", 
            details: err.message,
            id_attempted: finalAllviId // This won't crash now because it's defined above
        });
    }
});



module.exports = router;