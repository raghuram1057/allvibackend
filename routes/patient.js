const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const router = express.Router();
const multer = require('multer');

// Use memory storage to handle file buffers
const upload = multer({ storage: multer.memoryStorage() });

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

router.post('/process-report', upload.single('report'), async (req, res) => {
    try {
        // 1. Check if file exists
        if (!req.file) {
            return res.status(400).json({ success: false, error: "No file uploaded" });
        }

        // 2. Initialize Model
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        // 3. Prepare the data for Gemini
        const prompt = "Extract biomarkers as JSON: test_date, tsh, vit_d, ferritin. Return ONLY valid JSON.";
        const imagePart = {
            inlineData: {
                data: req.file.buffer.toString("base64"),
                mimeType: req.file.mimetype
            }
        };

        // 4. Generate Content
        const result = await model.generateContent([prompt, imagePart]);
        const response = await result.response;
        const text = response.text();

        // 5. Clean and Parse JSON
        // Sometimes Gemini wraps JSON in ```json ... ``` blocks
        const cleanJson = text.replace(/```json|```/g, "").trim();
        const parsedData = JSON.parse(cleanJson);

        res.status(200).json({ success: true, parsedData });

    } catch (err) {
        // This log will appear in your Render "Logs" tab
        console.error("DETAILED SERVER ERROR:", err);
        
        res.status(500).json({ 
            success: false, 
            error: "Internal Server Error",
            message: err.message 
        });
    }
});

module.exports = router;