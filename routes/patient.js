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
    let finalAllviId = req.body.existingId;
    if (!finalAllviId || finalAllviId === "undefined" || finalAllviId === "null") {
        finalAllviId = null;
    }

    try {
        if (!req.file) throw new Error("No file uploaded");

        // 1. UPDATED PROMPT: Requesting all Phase 2 biomarkers
        const prompt = `
            Extract biomarkers from this lab report. 
            Return ONLY raw JSON. No markdown backticks.
            Include these specific keys: 
            {
              "test_date": "YYYY-MM-DD", 
              "tsh": number, 
              "free_t3": number, 
              "free_t4": number, 
              "vit_d": number, 
              "ferritin": number,
              "anti_tpo": number
            }
            If a value is missing or not found, return null for that key.
        `;

        const result = await model.generateContent([
            prompt,
            { inlineData: { data: req.file.buffer.toString("base64"), mimeType: req.file.mimetype } }
        ]);

        const text = result.response.text();
        const cleanJson = text.replace(/```json|```/g, "").trim();
        const parsedData = JSON.parse(cleanJson);

        // 2. DATE VALIDATION: Fallback to today if extraction fails
        let reportDate = parsedData.test_date;
        const isValidDate = (d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d).getTime());
        
        if (!isValidDate(reportDate)) {
            reportDate = new Date().toISOString().split('T')[0]; 
            console.log("⚠️ Valid date not found. Using today:", reportDate);
        }

        // 3. IDENTITY MANAGEMENT
        if (!finalAllviId) {
            finalAllviId = `ALLVI-${Math.floor(1000 + Math.random() * 9000)}`;
            const { error: pError } = await supabase.from('patients').insert([{ allvi_id: finalAllviId }]);
            if (pError) throw pError;
        }

        // 4. DATABASE INSERTION: mapping all extracted fields
        const { error: dbError } = await supabase.from('lab_results').insert([{
            patient_id: finalAllviId,
            test_date: reportDate,
            tsh: parseFloat(parsedData.tsh) || null,
            free_t3: parseFloat(parsedData.free_t3) || null,
            free_t4: parseFloat(parsedData.free_t4) || null,
            vit_d: parseFloat(parsedData.vit_d) || null,
            ferritin: parseFloat(parsedData.ferritin) || null,
            anti_tpo: parseFloat(parsedData.anti_tpo) || null
        }]);

        if (dbError) throw dbError;

        res.status(200).json({ 
            success: true, 
            allvi_id: finalAllviId, 
            parsedData: { ...parsedData, test_date: reportDate } 
        });

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

router.get('/insights/:patientId', async (req, res) => {
    try {
        const { patientId } = req.params;

        // 1. Fetch the full history
        const { data: labs } = await supabase.from('lab_results').select('*').eq('patient_id', patientId).order('test_date', { ascending: true });
        const { data: symptoms } = await supabase.from('symptoms').select('*').eq('patient_id', patientId).order('date', { ascending: true });

        if (!labs || labs.length === 0) {
            return res.json({ success: true, insights: "Not enough data to generate insights yet. Please upload more reports." });
        }

        // 2. Format data for the AI
        const dataSummary = `
            Patient Lab History: ${JSON.stringify(labs)}
            Patient Symptom History: ${JSON.stringify(symptoms)}
        `;

        // 3. Generate AI Insights
        const prompt = `
            You are a clinical data analyst. Analyze this patient's health data and provide a structured summary in exactly three sections. 
            Keep it professional, clear, and bulleted.
            
            1. POSITIVE TRENDS: What is improving or stable?
            2. AREAS OF CONCERN: What markers are trending outside normal ranges or symptoms worsening?
            3. NEEDS ATTENTION: What patterns suggest a clinical review or lifestyle change?
            
            Return ONLY the summary. No preamble. Use Markdown.
        `;

        const result = await model.generateContent([prompt, dataSummary]);
        const insights = result.response.text();

        res.status(200).json({ success: true, insights });
    } catch (err) {
        console.error("❌ INSIGHTS ERROR:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/admin/patients', async (req, res) => {
    try {
        // Fetch all patients and their latest lab result date
        const { data: patients, error } = await supabase
            .from('patients')
            .select(`
                allvi_id,
                created_at,
                lab_results (test_date)
            `);

        if (error) throw error;

        // Simplify data: find the most recent test date for each patient
        const formattedPatients = patients.map(p => ({
            id: p.allvi_id,
            joined: p.created_at,
            lastActivity: p.lab_results?.length > 0 
                ? p.lab_results.sort((a,b) => new Date(b.test_date) - new Date(a.test_date))[0].test_date 
                : 'No reports yet'
        }));

        res.status(200).json({ success: true, patients: formattedPatients });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
module.exports = router;