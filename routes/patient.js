const express = require('express');
const router = express.Router();
const multer = require('multer');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require('@supabase/supabase-js');

const upload = multer({ storage: multer.memoryStorage() });

// 1. Initialize Clients
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 2. Initialize Gemini Model (April 2026 stable config)
const model = genAI.getGenerativeModel(
    { model: "gemini-3-flash-preview" }, 
    { apiVersion: "v1beta" }
);

// --- Helper Function to Validate Date ---
const isValidDate = (dateString) => {
    const regEx = /^\d{4}-\d{2}-\d{2}$/;
    if(!dateString || !dateString.match(regEx)) return false; // Invalid format
    const d = new Date(dateString);
    return d instanceof Date && !isNaN(d.getTime()); // Check if it's a real date
};

router.post('/process-report', upload.single('report'), async (req, res) => {
    let finalAllviId = req.body.existingId || null;

    try {
        if (!req.file) throw new Error("No file uploaded");

        const result = await model.generateContent([
            "Extract: test_date (YYYY-MM-DD), tsh, vit_d, ferritin. Return ONLY JSON.",
            { inlineData: { data: req.file.buffer.toString("base64"), mimeType: req.file.mimetype } }
        ]);

        const text = result.response.text();
        const cleanJson = text.replace(/```json|```/g, "").trim();
        const parsedData = JSON.parse(cleanJson);

        // FIX: If AI gives "20XX-XX-XX" or null, use Today's Date
        let reportDate = parsedData.test_date;
        if (!isValidDate(reportDate)) {
            reportDate = new Date().toISOString().split('T')[0]; 
            console.log("⚠️ AI provided invalid date. Using fallback:", reportDate);
        }

        if (!finalAllviId || finalAllviId === "undefined") {
            finalAllviId = `ALLVI-${Math.floor(1000 + Math.random() * 9000)}`;
            await supabase.from('patients').insert([{ allvi_id: finalAllviId }]);
        }

        const { error } = await supabase.from('lab_results').insert([{
            patient_id: finalAllviId,
            test_date: reportDate, // Use the validated date
            tsh: parseFloat(parsedData.tsh) || null,
            vit_d: parseFloat(parsedData.vit_d) || null,
            ferritin: parseFloat(parsedData.ferritin) || null
        }]);

        if (error) throw error;
        res.status(200).json({ success: true, allvi_id: finalAllviId, parsedData: { ...parsedData, test_date: reportDate } });

    } catch (err) {
        console.error("❌ PROCESS ERROR:", err.message);
        res.status(500).json({ success: false, details: err.message });
    }
});

router.post('/confirm-results', async (req, res) => {
    try {
        const { patientId, biomarkers } = req.body;
        
        // FIX: Fallback for manual confirmation too
        const finalDate = isValidDate(biomarkers.test_date) 
            ? biomarkers.test_date 
            : new Date().toISOString().split('T')[0];

        const { error } = await supabase.from('lab_results').insert([{
            patient_id: patientId,
            test_date: finalDate,
            tsh: parseFloat(biomarkers.tsh) || null,
            vit_d: parseFloat(biomarkers.vit_d) || null,
            ferritin: parseFloat(biomarkers.ferritin) || null
        }]);

        if (error) throw error;
        res.status(200).json({ success: true });
    } catch (err) {
        console.error("❌ CONFIRM ERROR:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});



// --- GET DASHBOARD DATA ---
router.get('/dashboard/:patientId', async (req, res) => {
    try {
        const { patientId } = req.params;
        console.log("📊 Fetching dashboard for:", patientId);

        // Fetch Lab Results
        const { data: labs, error: labErr } = await supabase
            .from('lab_results')
            .select('*')
            .eq('patient_id', patientId)
            .order('test_date', { ascending: true });

        if (labErr) throw labErr;

        // Fetch Symptom Data - Added a fallback empty array if table doesn't exist
        let symptoms = [];
        try {
            const { data, error: sympErr } = await supabase
                .from('symptoms')
                .select('*')
                .eq('patient_id', patientId)
                .order('date', { ascending: true });
            
            if (!sympErr) symptoms = data;
        } catch (e) {
            console.log("⚠️ Symptoms table might be missing, skipping...");
        }

        res.status(200).json({ success: true, labs: labs || [], symptoms: symptoms || [] });
    } catch (err) {
        console.error("❌ DASHBOARD DATA ERROR:", err.message);
        res.status(500).json({ success: false, details: err.message });
    }
});

module.exports = router;