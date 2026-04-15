const express = require('express');
const router = express.Router();
const multer = require('multer');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require('@supabase/supabase-js');

// Config
const upload = multer({ storage: multer.memoryStorage() });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

router.post('/process-report', upload.single('report'), async (req, res) => {
    const { existingId } = req.body; // Sent from frontend
    let finalAllviId = existingId;

    try {
        if (!req.file) throw new Error("No file uploaded");

        // --- STEP 1: GEMINI AI PARSING ---
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `
            Analyze this lab report. Extract: test_date, tsh, free_t3, free_t4, anti_tpo, ferritin, vit_d.
            Return ONLY a raw JSON object. Use null for missing values. 
            Format: {"test_date": "YYYY-MM-DD", "tsh": 0.0, ...}
        `;

        const result = await model.generateContent([
            prompt,
            { inlineData: { data: req.file.buffer.toString("base64"), mimeType: req.file.mimetype } }
        ]);

        // Clean the AI response (remove markdown if any)
        const cleanJson = result.response.text().replace(/```json|```/g, "").trim();
        const parsedData = JSON.parse(cleanJson);

        // --- STEP 2: IDENTITY LOGIC (Create or Verify) ---
        if (!finalAllviId) {
            // New User
            finalAllviId = `ALLVI-${Math.floor(1000 + Math.random() * 9000)}`;
            await supabase.from('patients').insert([{ allvi_id: finalAllviId }]);
        } else {
            // Returning User: Verify ID exists
            const { data } = await supabase.from('patients').select('allvi_id').eq('allvi_id', finalAllviId).single();
            if (!data) return res.status(404).json({ error: "ALLVI-ID not found" });
        }

        // --- STEP 3: STORE IN SUPABASE ---
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

        if (lError) throw lError;

        // Return the parsed data for the Review Screen
        res.status(200).json({
            success: true,
            allvi_id: finalAllviId,
            parsedData: parsedData
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "AI Parsing or Database error: " + err.message });
    }
});

module.exports = router;