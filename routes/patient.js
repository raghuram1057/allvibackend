const express = require('express');
const nodemailer = require('nodemailer');
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
// --- ROUTE: PROCESS REPORT (Dynamic Extraction) ---
router.post('/process-report', upload.single('report'), async (req, res) => {
    let finalAllviId = req.body.existingId;
    const userAge = req.body.age;
    const userGender = req.body.gender;
    const userMail = req.body.email;
    const userName = req.body.name;
    const userCity = req.body.city;


    try {
        if (!req.file) throw new Error("No file uploaded");

        // Force the AI to use a key-value structure that our dynamic frontend can loop through
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

        // --- 1. ROBUST CLEANING ---
        // Removes markdown blocks and extra whitespace
        const cleanJson = text.replace(/```json|```/g, "").trim();
        let parsedData;
        try {
            parsedData = JSON.parse(cleanJson);
        } catch (e) {
            console.error("AI returned invalid JSON. Raw text:", text);
            throw new Error("Could not parse lab data. Please try a clearer photo.");
        }

        // --- 2. IDENTITY MANAGEMENT ---
        // Ensure we don't pass the string "null" or "undefined" to Supabase
        const isNewPatient = !finalAllviId || finalAllviId === "null" || finalAllviId === "undefined";

        if (isNewPatient) {
            finalAllviId = `ALLVI-${Math.floor(1000 + Math.random() * 9000)}`;
            const { error: patientErr } = await supabase.from('patients').insert([{
                allvi_id: finalAllviId,
                age: userAge ? parseInt(userAge) : null,
                gender: userGender,
                name : userName,
                city: userCity,
                email: userMail
            }]);
            if (patientErr) throw patientErr;
        }

        // --- 3. DATA NORMALIZATION ---
        // Ensures the frontend always receives the structure: { test_date, biomarkers: {} }
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
        console.log(biomarkers)

        // Store the entire 'biomarkers' object into a single JSONB column
        const { error } = await supabase.from('lab_results').insert([{
            patient_id: patientId,
            test_date: test_date || new Date().toISOString().split('T')[0],
            data: biomarkers
            // This 'data' column in Supabase should be type JSONB
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
        console.log("📊 Fetching dynamic clinical profile for:", patientId);

        // 1. Fetch Patient Demographics
        const { data: patient, error: pErr } = await supabase
            .from('patients')
            .select('age, gender')
            .eq('allvi_id', patientId)
            .single();

        if (pErr) console.error("⚠️ Demographics not found:", pErr.message);

        // 2. Fetch Lab Results (Dynamic JSONB)
        const { data: labs, error: labErr } = await supabase
            .from('lab_results')
            .select('id, test_date, data, report_type')
            .eq('patient_id', patientId)
            .order('test_date', { ascending: true });

        if (labErr) throw labErr;

        // 3. THE FIX: Proper Flattening for Recharts + Metadata for UI
        // Inside your GET /dashboard/:patientId route
        const formattedLabs = labs.map(row => {
            const transformedRow = {
                id: row.id,
                test_date: row.test_date,
                meta: {}
            };

            if (row.data) {
                Object.entries(row.data).forEach(([key, info]) => {
                    // FORCE CONVERSION TO NUMBER
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

        // 4. Fetch Symptom Data
        const { data: symptoms, error: sympErr } = await supabase
            .from('symptoms')
            .select('*')
            .eq('patient_id', patientId)
            .order('date', { ascending: true });

        // 5. Send Combined Response
        res.status(200).json({
            success: true,
            profile: {
                age: patient?.age || '—',
                gender: patient?.gender || '—',
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



router.post('/request-appointment', async (req, res) => {
    const { patientId, notes } = req.body;

    try {
        // Configure your email provider (Gmail, Outlook, SendGrid, etc.)
        const transporter = nodemailer.createTransport({
            service: 'gmail', 
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: 'support@allvihealth.com',
            subject: `Appointment Request: ${patientId}`,
            text: `Patient ID: ${patientId}\n\nNotes from Patient:\n${notes || "No notes provided."}`
        };

        await transporter.sendMail(mailOptions);
        res.status(200).json({ success: true, message: "Request sent successfully" });
    } catch (error) {
        console.error("Email Error:", error);
        res.status(500).json({ success: false, error: "Failed to send request" });
    }
});



module.exports = router;