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
    console.log("1. Request Received");
    try {
        if (!req.file) throw new Error("File not found in request");
        console.log("2. File size:", req.file.size);

        if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is missing from environment");

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        console.log("3. AI Model Initialized");

        // ... existing Gemini logic ...
        
        console.log("4. AI Success, Saving to DB...");

        // ... existing Supabase logic ...

        res.status(200).json({ success: true, allvi_id: finalAllviId, parsedData: parsedData });

    } catch (err) {
        console.error("CRITICAL BACKEND CRASH:", err); // THIS WILL SHOW IN RENDER LOGS
        res.status(500).json({ success: false, error: err.message });
    }
});



module.exports = router;