const express = require('express');
const nodemailer = require('nodemailer');
const router = express.Router();
const multer = require('multer');
const axios = require('axios'); // Ensure axios is installed

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

// --- NEW UPDATE: TALLY CONFIGURATION & MAPPING ---
const TALLY_API_KEY = process.env.TALLY_API_KEY;
const FORM_ID = 'zxYlVZ';

const TALLY_MAP = {
    NAME: "QA2rQg",
    EMAIL: "9dG1kG",
    GENDER: "aBNxL9",
    CITY: "7dlDAL",
    SYMPTOMS: "YZDOAd",
    GOALS: "42Xkbb",
    DOB: "WA9oWJ"
};

// Helper: Extract answer from Tally responses array
const getTallyAnswer = (responses, qid) => {
    const found = responses.find(r => r.questionId === qid);
    if (!found) return null;
    return Array.isArray(found.answer) ? found.answer[0] : found.answer;
};

// --- NEW UPDATE: LOGIN ROUTE ---
// routes/patient.js

// ✅ CORRECT: Just '/login'
// --- NEW UPDATE: LOGIN ROUTE ---
// routes/patient.js

// routes/patient.js

router.post('/login', async (req, res) => {
    // 1. Clean the input from the frontend
    const inputId = req.body.allviId ? req.body.allviId.trim() : '';
    
    console.log(`🔍 Attempting login for cleaned ID: [${inputId}]`);

    try {
        const { data: patient, error } = await supabase
            .from('patients')
            .select('*')
            // Using .ilike for case-insensitivity
            // Adding % trims allows it to find the ID even if there are hidden spaces in the DB
            .ilike('allvi_id', `%${inputId}%`) 
            .maybeSingle();

        if (error) {
            console.error("❌ Supabase Database Error:", error.message);
            return res.status(500).json({ success: false, message: "Database error" });
        }

        if (!patient) {
            console.log("⚠️ No patient record matched that ID string.");
            return res.status(401).json({ success: false, message: "Invalid ALLVI ID" });
        }

        console.log("✅ Match found:", patient.name);
        res.status(200).json({ success: true, patient });

    } catch (err) {
        console.error("❌ Server Error:", err.message);
        res.status(500).json({ success: false, error: "Internal server error" });
    }
});
// --- NEW UPDATE: PROFILE UPDATE ROUTE ---
router.put('/profile/update/:allviId', async (req, res) => {
    const { allviId } = req.params;
    const { name, email, age, gender, city } = req.body;
    try {
        const { data, error } = await supabase
            .from('patients')
            .update({ 
                name, 
                email, 
                age: parseInt(age), 
                gender, 
                city 
            })
            .eq('allvi_id', allviId)
            .select();

        if (error) throw error;
        res.status(200).json({ success: true, message: "Profile updated successfully", data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

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
    const userMail = req.body.email;
    const userName = req.body.name;
    const userCity = req.body.city;

    try {
        if (!req.file) throw new Error("No file uploaded");

        const prompt = `
            ACT AS: A clinical data extraction engine.
            TASK: Extract every lab result from the provided document.

            REQUIRED JSON STRUCTURE:
            {
              "test_date": "YYYY-MM-DD",
              "biomarkers": {
                "standardized_key": {
                  "label": "Full Test Name",
                  "value": 0.0,
                  "unit": "string",
                  "ref_range": "string"
                }
              }
            }

            INSTRUCTIONS:
            1. "test_date": Locate the sample collection or report date.
            2. "standardized_key": Use a short, lowercase_underscored name (e.g., "vit_b12", "hba1c").
            3. "label": Extract the exact, formal test name as printed on the report (e.g., "Hemoglobin A1c").
            4. "value": Extract ONLY the number. If a value is "<0.1", return 0.1.
            5. "unit": Extract the measurement unit (e.g., "mg/dL", "uIU/mL").
            6. "ref_range": Extract the reference interval provided by the lab (e.g., "0.45 - 4.50").

            RULES:
            - Identify EVERY marker present on the page.
            - Return ONLY the raw JSON object.
            - NO markdown code blocks (no \`\`\`json).
            - NO conversational text or explanations.
        `;
        const result = await model.generateContent([
            prompt,
            { inlineData: { data: req.file.buffer.toString("base64"), mimeType: req.file.mimetype } }
        ]);

        const text = result.response.text();
        const cleanJson = text.replace(/```json|```/g, "").trim();
        let parsedData;
        try {
            parsedData = JSON.parse(cleanJson);
        } catch (e) {
            console.error("AI returned invalid JSON. Raw text:", text);
            throw new Error("Could not parse lab data. Please try a clearer photo.");
        }

        const isNewPatient = !finalAllviId || finalAllviId === "null" || finalAllviId === "undefined";

        if (isNewPatient) {
            finalAllviId = `ALLVI-${Math.floor(1000 + Math.random() * 9000)}`;
            const { error: patientErr } = await supabase.from('patients').insert([{
                allvi_id: finalAllviId,
                age: userAge ? parseInt(userAge) : null,
                gender: userGender,
                name: userName,
                city: userCity,
                email: userMail
            }]);
            if (patientErr) throw patientErr;
        }

        const responsePayload = {
            test_date: parsedData.test_date || new Date().toISOString().split('T')[0],
            biomarkers: parsedData.biomarkers || {}
        };

        console.log("✅ Extracted Markers:", Object.keys(responsePayload.biomarkers));

        res.status(200).json({
            success: true,
            allvi_id: finalAllviId,
            parsedData: responsePayload
        });

    } catch (err) {
        console.error("❌ PROCESS ERROR:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- ROUTE: CONFIRM RESULTS ---
router.post('/confirm-results', async (req, res) => {
    try {
        const { patientId, test_date, biomarkers } = req.body;
        const { error } = await supabase.from('lab_results').insert([{
            patient_id: patientId,
            test_date: test_date || new Date().toISOString().split('T')[0],
            data: biomarkers
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
        const { data: patient, error: pErr } = await supabase
            .from('patients')
            .select('*')
            .eq('allvi_id', patientId)
            .single();

        if (pErr) console.error("⚠️ Demographics not found:", pErr.message);

        const { data: labs, error: labErr } = await supabase
            .from('lab_results')
            .select('id, test_date, data, report_type')
            .eq('patient_id', patientId)
            .order('test_date', { ascending: true });

        if (labErr) throw labErr;

        const formattedLabs = labs.map(row => {
            const transformedRow = {
                id: row.id,
                test_date: row.test_date,
                meta: {}
            };

            if (row.data) {
                Object.entries(row.data).forEach(([key, info]) => {
                    const val = parseFloat(info.value);
                    transformedRow[key] = isNaN(val) ? 0 : val;
                    transformedRow.meta[key] = {
                        label: info.label || key,
                        unit: info.unit || '',
                        ref_range: info.ref_range || ''
                    };
                });
            }
            return transformedRow;
        });

        const { data: symptoms } = await supabase
            .from('symptoms')
            .select('*')
            .eq('patient_id', patientId)
            .order('date', { ascending: true });

        res.status(200).json({
            success: true,
            profile: {
                name: patient?.name || '—',
                email: patient?.email || '—',
                age: patient?.age || '—',
                gender: patient?.gender || '—',
                city: patient?.city || '—',
                allvi_id: patientId
            },
            labs: formattedLabs,
            symptoms: symptoms || []
        });

    } catch (err) {
        console.error("❌ DASHBOARD DATA ERROR:", err.message);
        res.status(500).json({ success: false, details: err.message });
    }
});

// --- REMAINING ROUTES: INSIGHTS, ADMIN, IMPORT SYMPTOMS, APPOINTMENT ---
router.get('/insights/:patientId', async (req, res) => {
    try {
        const { patientId } = req.params;
        const { data: labs } = await supabase.from('lab_results').select('*').eq('patient_id', patientId).order('test_date', { ascending: true });
        const { data: symptoms } = await supabase.from('symptoms').select('*').eq('patient_id', patientId).order('date', { ascending: true });

        if (!labs || labs.length === 0) {
            return res.json({ success: true, insights: "Not enough data yet." });
        }

        const dataSummary = `Patient Lab History: ${JSON.stringify(labs)} Patient Symptom History: ${JSON.stringify(symptoms)}`;
        const prompt = `You are a clinical data analyst. Analyze this patient's health data and provide a structured summary in three sections: POSITIVE TRENDS, AREAS OF CONCERN, NEEDS ATTENTION.`;
        
        const result = await model.generateContent([prompt, dataSummary]);
        res.status(200).json({ success: true, insights: result.response.text() });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/admin/patients', async (req, res) => {
    try {
        const { data: patients, error } = await supabase.from('patients').select(`allvi_id, created_at, lab_results (test_date)`);
        if (error) throw error;
        const formattedPatients = patients.map(p => ({
            id: p.allvi_id,
            joined: p.created_at,
            lastActivity: p.lab_results?.length > 0 ? p.lab_results.sort((a, b) => new Date(b.test_date) - new Date(a.test_date))[0].test_date : 'No reports yet'
        }));
        res.status(200).json({ success: true, patients: formattedPatients });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete('/admin/patients/:patientId', async (req, res) => {
    try {
        const { error } = await supabase.from('patients').delete().eq('allvi_id', req.params.patientId);
        if (error) throw error;
        res.status(200).json({ success: true, message: "Deleted" });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/import-symptoms', async (req, res) => {
    try {
        const { patientId, symptoms } = req.body;
        const symptomRows = symptoms.map(row => ({
            patient_id: patientId,
            date: row.date || new Date().toISOString().split('T')[0],
            energy: parseInt(row.energy) || 8,
            sleep: parseInt(row.sleep) || 8,
            mood: parseInt(row.mood) || 8,
            stress: parseInt(row.stress) || 8,
            joint_pain: parseInt(row.joint_pain) || 8
        }));
        const { error } = await supabase.from('symptoms').insert(symptomRows);
        if (error) throw error;
        res.status(200).json({ success: true, message: "Imported" });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/request-appointment', async (req, res) => {
    try {
        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
        await transporter.sendMail({ from: process.env.EMAIL_USER, to: 'support@allvihealth.com', subject: `Appointment: ${req.body.patientId}`, text: req.body.notes });
        res.status(200).json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// --- SYNC PAST TALLY DATA ROUTE (Using the ID Mapping) ---
// --- SYNC PAST TALLY DATA ROUTE ---
router.get('/sync-past-tally', async (req, res) => {
    try {
        console.log("🔄 Starting Tally Sync...");
        const response = await axios.get(`https://api.tally.so/forms/${FORM_ID}/submissions`, {
            headers: { 'Authorization': `Bearer ${TALLY_API_KEY}` }
        });

        const submissions = response.data.submissions;
        if (!submissions || submissions.length === 0) {
            return res.status(200).json({ success: true, message: "No submissions found in Tally." });
        }

        let count = 0;
        for (const sub of submissions) {
            const resps = sub.responses;

            // Extract values using your TALLY_MAP IDs
            const email = getTallyAnswer(resps, TALLY_MAP.EMAIL);
            const name = getTallyAnswer(resps, TALLY_MAP.NAME);
            const gender = getTallyAnswer(resps, TALLY_MAP.GENDER);
            const city = getTallyAnswer(resps, TALLY_MAP.CITY);

            // CRITICAL CHECK: If Tally doesn't have an email, Supabase might reject it
            if (!email) {
                console.warn(`⚠️ Skipping submission ${sub.id}: No email found.`);
                continue;
            }

            // Generate the ID that the user will use to log in
            const allvi_id = `ALLVI-${Math.floor(1000 + Math.random() * 9000)}`;

            // 1. Insert/Update Patient
            const { error: pError } = await supabase.from('patients').upsert([{
                allvi_id,
                name: name || 'Unknown Patient',
                email: email.toLowerCase().trim(),
                gender: Array.isArray(gender) ? gender[0] : gender,
                city: city,
                created_at: sub.createdAt
            }], { onConflict: 'email' });

            if (pError) {
                console.error(`❌ Supabase Patient Error (${email}):`, pError.message);
                continue;
            }

            // 2. Insert Intake Data
            await supabase.from('patient_intake').insert([{
                patient_id: allvi_id,
                symptoms: getTallyAnswer(resps, TALLY_MAP.SYMPTOMS),
                goals: getTallyAnswer(resps, TALLY_MAP.GOALS)
            }]);

            count++;
            console.log(`✅ Successfully synced: ${email} as ${allvi_id}`);
        }

        res.status(200).json({ success: true, message: `Successfully synced ${count} records.` });
    } catch (err) {
        console.error("❌ Tally API Error:", err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});
module.exports = router;