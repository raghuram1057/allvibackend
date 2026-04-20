const express = require('express');
const router = express.Router();
const multer = require('multer');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require('@supabase/supabase-js');

const upload = multer({ storage: multer.memoryStorage() });

// 1. Initialize Clients
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 2. Initialize Gemini Model
const model = genAI.getGenerativeModel(
    { model: "gemini-3-flash-preview" },
    { apiVersion: "v1beta" }
);

// Helper Function to Validate Date
const isValidDate = (dateString) => {
    const regEx = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateString || !dateString.match(regEx)) return false;
    const d = new Date(dateString);
    return d instanceof Date && !isNaN(d.getTime());
};

// --- ROUTE: PROCESS REPORT ---
router.post('/process-report', upload.single('report'), async (req, res) => {
    let finalAllviId = req.body.existingId;
    const userAge = req.body.age;
    const userGender = req.body.gender;

    try {
        if (!req.file) throw new Error("No file uploaded");

        // 1. IMPROVED PROMPT: Forces the AI to find the markers even if hidden
        const prompt = `
            Analyze this medical lab report. 
            Step 1: Locate TSH, Free T3, Free T4, Vitamin D, Ferritin, and Anti-TPO.
            Step 2: Return a raw JSON object. NO MARKDOWN.
            
            Format:
            {
              "test_date": "YYYY-MM-DD",
              "biomarkers": [
                { "name": "tsh", "value": 1.2 },
                { "name": "vit_d", "value": 30.5 },
                { "name": "ferritin", "value": 50 },
                { "name": "free_t3", "value": 3.2 },
                { "name": "free_t4", "value": 1.1 },
                { "name": "anti_tpo", "value": 10 }
              ]
            }
            If a marker is missing, exclude it from the array.
        `;

        const result = await model.generateContent([
            prompt,
            { inlineData: { data: req.file.buffer.toString("base64"), mimeType: req.file.mimetype } }
        ]);

        const text = result.response.text();
        // Robust cleaning of the AI response
        const cleanJson = text.replace(/```json|```/g, "").trim();
        const parsedData = JSON.parse(cleanJson);

        // Date Check
        let reportDate = parsedData.test_date || new Date().toISOString().split('T')[0];

        // 2. IDENTITY MANAGEMENT
        if (!finalAllviId || finalAllviId === "null") {
            finalAllviId = `ALLVI-${Math.floor(1000 + Math.random() * 9000)}`;
            await supabase.from('patients').insert([{ 
                allvi_id: finalAllviId, 
                age: parseInt(userAge), 
                gender: userGender 
            }]);
        }

        // 3. LOGGING FOR DEBUGGING (Watch your terminal!)
        console.log("Extracted Markers:", parsedData.biomarkers);

        res.status(200).json({ 
            success: true, 
            allvi_id: finalAllviId, 
            parsedData: parsedData // Ensure this object has the 'biomarkers' key
        });

    } catch (err) {
        console.error("❌ PROCESS ERROR:", err.message);
        res.status(500).json({ success: false, details: err.message });
    }
});
// --- ROUTE: CONFIRM RESULTS ---
router.post('/confirm-results', async (req, res) => {
    try {
        const { patientId, biomarkers } = req.body;

        const finalDate = isValidDate(biomarkers.test_date)
            ? biomarkers.test_date
            : new Date().toISOString().split('T')[0];

        const { error } = await supabase.from('lab_results').insert([{
            patient_id: patientId,
            test_date: finalDate,
            tsh: parseFloat(biomarkers.tsh) || null,
            free_t3: parseFloat(biomarkers.free_t3) || null,
            free_t4: parseFloat(biomarkers.free_t4) || null,
            anti_tpo: parseFloat(biomarkers.anti_tpo) || null,
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



// --- UPDATED GET DASHBOARD DATA ---
router.get('/dashboard/:patientId', async (req, res) => {
    try {
        const { patientId } = req.params;
        console.log("📊 Fetching clinical profile for:", patientId);

        // 1. NEW: Fetch Patient Demographics (Age and Gender)
        // We use .single() because we expect exactly one record for this ID
        const { data: patient, error: pErr } = await supabase
            .from('patients')
            .select('age, gender')
            .eq('allvi_id', patientId)
            .single();

        if (pErr) {
            console.error("⚠️ Demographics not found for this ID:", pErr.message);
            // We don't throw an error here so the charts can still load even if age is missing
        }

        // 2. Fetch Lab Results
        const { data: labs, error: labErr } = await supabase
            .from('lab_results')
            .select('*')
            .eq('patient_id', patientId)
            .order('test_date', { ascending: true });

        if (labErr) throw labErr;

        // 3. Fetch Symptom Data
        let symptoms = [];
        try {
            const { data: sympData, error: sympErr } = await supabase
                .from('symptoms')
                .select('*')
                .eq('patient_id', patientId)
                .order('date', { ascending: true });
            
            if (!sympErr) symptoms = sympData;
        } catch (e) {
            console.log("⚠️ Symptoms table check skipped...");
        }

        // 4. COMBINED RESPONSE: Sending everything the frontend needs
        res.status(200).json({ 
            success: true, 
            age: patient?.age || '—', 
            gender: patient?.gender || '—', 
            labs: labs || [], 
            symptoms: symptoms || [] 
        });

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
                ? p.lab_results.sort((a, b) => new Date(b.test_date) - new Date(a.test_date))[0].test_date
                : 'No reports yet'
        }));

        res.status(200).json({ success: true, patients: formattedPatients });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- ADMIN: DELETE PATIENT AND ALL DATA ---
router.delete('/admin/patients/:patientId', async (req, res) => {
    try {
        const { patientId } = req.params;

        // Deleting from the 'patients' table triggers a cascade delete
        // for 'lab_results' and 'symptoms' in Supabase.
        const { error } = await supabase
            .from('patients')
            .delete()
            .eq('allvi_id', patientId);

        if (error) throw error;

        res.status(200).json({
            success: true,
            message: `Patient ${patientId} and all associated records deleted.`
        });
    } catch (err) {
        console.error("❌ DELETE ERROR:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- ROUTE: IMPORT SYMPTOMS (CSV Tally Data) ---
router.post('/import-symptoms', async (req, res) => {
    try {
        const { patientId, symptoms } = req.body;

        if (!patientId || !Array.isArray(symptoms)) {
            throw new Error("Invalid data format. Patient ID and symptoms array required.");
        }

        // Map CSV rows to database schema with "Positive Default" values
        const symptomRows = symptoms.map(row => {
            // Helper to clean and provide a positive default (8/10) if value is missing
            const val = (v) => {
                const parsed = parseInt(v);
                return isNaN(parsed) ? 8 : parsed; // Defaulting to 8 (Positive/Healthy)
            };

            return {
                patient_id: patientId,
                // Ensure date format is YYYY-MM-DD
                date: row.date || new Date().toISOString().split('T')[0],
                energy: val(row.energy),
                sleep: val(row.sleep),
                mood: val(row.mood),
                stress: val(row.stress),
                joint_pain: val(row.joint_pain)
            };
        });

        // Insert into Supabase
        const { error } = await supabase
            .from('symptoms')
            .insert(symptomRows);

        if (error) throw error;

        res.status(200).json({ 
            success: true, 
            message: `${symptomRows.length} symptom records imported with defaults.` 
        });

    } catch (err) {
        console.error("❌ SYMPTOM IMPORT ERROR:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;