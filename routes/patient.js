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

// --- NEW ROUTE: DIRECT FORM SUBMISSION FROM FRONTEND ---
router.post('/submit-intake', async (req, res) => {
    try {
        const formData = req.body;

        // 1. Generate a new ALLVI ID
        const allvi_id = `ALLVI-${Math.floor(1000 + Math.random() * 9000)}`;

        // 2. Calculate age from Date of Birth (DOB)
        let age = null;
        if (formData.dob) {
            const birthDate = new Date(formData.dob);
            const difference = Date.now() - birthDate.getTime();
            age = Math.floor(difference / (1000 * 60 * 60 * 24 * 365.25));
        }

        // 3. Map gender to match your DB CHECK constraint: ['Male', 'Female', 'Other']
        let safeGender = 'Other'; 
        if (formData.gender === 'Male' || formData.gender === 'Female') {
            safeGender = formData.gender;
        }

        // 4. Insert into the `patients` table
        const { error: patientErr } = await supabase.from('patients').insert([{
            allvi_id: allvi_id,
            name: formData.fullName || 'Unknown',
            email: formData.email ? formData.email.toLowerCase().trim() : null,
            gender: safeGender,
            city: formData.location,
            age: age
        }]);

        if (patientErr) throw patientErr;

        // 5. Consolidate Symptoms & Diagnoses for the `patient_intake` table
        // We flatten all the symptom arrays from step 2 into a single array
        const allSymptoms = [
            ...formData.symptomsEnergy,
            ...formData.symptomsDigestion,
            ...formData.symptomsMental,
            ...formData.symptomsSleep,
            ...formData.symptomsOther
        ];
        if (formData.symptomsOtherText) allSymptoms.push(`Other: ${formData.symptomsOtherText}`);

        // Consolidate diagnoses
        const allDiagnoses = [...formData.conditions];
        if (formData.conditionOther) allDiagnoses.push(`Other: ${formData.conditionOther}`);

        // 6. Insert into `patient_intake` table
        const { error: intakeErr } = await supabase.from('patient_intake').insert([{
            patient_id: allvi_id,
            diagnoses: allDiagnoses,   // Maps to text[]
            symptoms: allSymptoms,     // Maps to text[]
            goals: formData.topGoals,  // Maps to text
            stated_concern: formData.topHelp + (formData.anythingElse ? ` | Extra Notes: ${formData.anythingElse}` : '')
        }]);

        if (intakeErr) {
            // If intake fails, log it, but the user is already created
            console.error("⚠️ Intake insertion failed:", intakeErr.message);
            throw intakeErr; 
        }

        console.log(`✅ Direct form submission successful for: ${allvi_id}`);
        res.status(200).json({ success: true, allvi_id, message: "Intake form submitted successfully!" });

    } catch (err) {
        console.error("❌ SUBMIT INTAKE ERROR:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

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
        // Fetch all patients and their latest lab result date
        const { data: patients, error } = await supabase
            .from('patients')
            .select(`
                allvi_id,
                created_at,
                lab_results (test_date)
            `);
        if (error) throw error;
        // Simplify data: find the most recent test date for each patien
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
// Step 3: Fixed sync route that matches your Supabase schema correctly
router.get('/sync-past-tally', async (req, res) => {
    try {
        const response = await axios.get(`https://api.tally.so/forms/${FORM_ID}/submissions`, {
            headers: { 'Authorization': `Bearer ${TALLY_API_KEY}` }
        });

        const submissions = response.data.submissions;
        if (!submissions?.length) {
            return res.status(200).json({ success: true, message: "No submissions found." });
        }

        let synced = 0;
        let skipped = 0;
        const errors = [];

        for (const sub of submissions) {
            const resps = sub.responses;

            // Extract fields using corrected TALLY_MAP
            const email = getTallyAnswer(resps, TALLY_MAP.EMAIL);
            const name  = getTallyAnswer(resps, TALLY_MAP.NAME);
            const city  = getTallyAnswer(resps, TALLY_MAP.CITY);
            const symptoms = getTallyAnswer(resps, TALLY_MAP.SYMPTOMS); // text or array
            const goals    = getTallyAnswer(resps, TALLY_MAP.GOALS);

            // Gender: Tally sometimes returns array for multiple choice
            let gender = getTallyAnswer(resps, TALLY_MAP.GENDER);
            if (Array.isArray(gender)) gender = gender[0];

            // Validate against your schema's CHECK constraint
            const validGenders = ['Male', 'Female', 'Other'];
            const safeGender = validGenders.includes(gender) ? gender : null;

            if (!email) {
                console.warn(`⚠️ Skipping ${sub.id}: no email`);
                skipped++;
                continue;
            }

            const allvi_id = `ALLVI-${Math.floor(1000 + Math.random() * 9000)}`;

            // --- Insert Patient (schema: patients table) ---
            // onConflict: 'email' — updates existing patient if email already exists
            const { data: patientData, error: pError } = await supabase
                .from('patients')
                .upsert([{
                    allvi_id,
                    name:   name  || 'Unknown',
                    email:  email.toLowerCase().trim(),
                    gender: safeGender,
                    city:   city  || null,
                    created_at: sub.createdAt
                }], { onConflict: 'email' })
                .select('allvi_id')  // get back the actual allvi_id (may differ if row existed)
                .single();

            if (pError) {
                console.error(`❌ Patient upsert failed (${email}):`, pError.message);
                errors.push({ email, error: pError.message });
                continue;
            }

            // Use the DB's actual allvi_id (important when row already existed)
            const actualAllviId = patientData.allvi_id;

            // --- Insert Intake (schema: patient_intake table) ---
            // symptoms column is ARRAY type in your schema
            const symptomsArray = Array.isArray(symptoms)
                ? symptoms
                : (symptoms ? [symptoms] : []);  // wrap string in array

            const { error: intakeError } = await supabase
                .from('patient_intake')
                .insert([{
                    patient_id: actualAllviId,
                    symptoms:   symptomsArray,   // text[] in schema
                    goals:      goals || null,   // text in schema
                }]);

            if (intakeError) {
                // Non-fatal: log but don't skip
                console.warn(`⚠️ Intake insert failed (${actualAllviId}):`, intakeError.message);
            }

            synced++;
            console.log(`✅ Synced: ${email} → ${actualAllviId}`);
        }

        res.status(200).json({
            success: true,
            message: `Synced ${synced}, skipped ${skipped}`,
            errors: errors.length ? errors : undefined
        });

    } catch (err) {
        console.error("❌ Tally Sync Error:", err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Step 1: Add this debug route FIRST to see your real question IDs
router.get('/debug-tally', async (req, res) => {
    try {
        const response = await axios.get(`https://api.tally.so/forms/${FORM_ID}/submissions`, {
            headers: { 'Authorization': `Bearer ${TALLY_API_KEY}` }
        });

        const firstSub = response.data.submissions?.[0];
        if (!firstSub) return res.json({ message: "No submissions" });

        // Returns all questionIds + answers so you can build your map
        const questionMap = firstSub.responses.map(r => ({
            questionId: r.questionId,
            answer: r.answer
        }));

        res.json({ questionMap });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
module.exports = router;