const { GoogleGenerativeAI } = require('@google/generative-ai'); // Correct SDK import
const express = require('express');
const router = express.Router();
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });

// Initialize the Gemini AI Client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
    model: "gemini-1.5-flash",
    generationConfig: { responseMimeType: "application/json" } // Ensures clean JSON output
});

router.post('/process-report', upload.single('report'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: "File missing" });
        }

        const prompt = "Extract biomarkers as JSON with these keys: test_date, tsh, vit_d, ferritin. If a value is missing, use null.";

        const result = await model.generateContent([
            prompt,
            {
                inlineData: {
                    data: req.file.buffer.toString("base64"),
                    mimeType: req.file.mimetype,
                },
            },
        ]);

        const response = await result.response;
        const text = response.text();
        
        // Parse the JSON directly
        const parsedData = JSON.parse(text);

        // ... Your Supabase logic goes here ...

        res.status(200).json({ success: true, data: parsedData });

    } catch (err) {
        console.error("Gemini SDK Error:", err);
        res.status(500).json({ 
            success: false, 
            error: "Internal Server Error", 
            details: err.message 
        });
    }
});

module.exports = router;