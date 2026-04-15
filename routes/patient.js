const { createDataClient } = require('@google/genai'); // Note the change here
const express = require('express');
const router = express.Router();
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });

// Initialize the new client
const client = createDataClient({ 
  apiKey: process.env.GEMINI_API_KEY, 
  apiVersion: 'v1alpha' // Use latest version for better support
});

router.post('/process-report', upload.single('report'), async (req, res) => {
    try {
        if (!req.file) throw new Error("File missing");

        // Using the new client.models.generateContent syntax
        const result = await client.models.generateContent({
            model: 'gemini-1.5-flash',
            contents: [{
                role: 'user',
                parts: [
                    { text: "Extract biomarkers as JSON: test_date, tsh, vit_d, ferritin." },
                    { 
                        inlineData: { 
                            data: req.file.buffer.toString('base64'), 
                            mimeType: req.file.mimetype 
                        } 
                    }
                ]
            }]
        });

        // The response structure is also slightly different
        const text = result.response.candidates[0].content.parts[0].text;
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        const parsedData = JSON.parse(jsonMatch[0]);

        // ... Proceed with Supabase logic as before ...

        res.status(200).json({ success: true, parsedData });

    } catch (err) {
        console.error("SDK Error:", err);
        res.status(500).json({ success: false, details: err.message });
    }
});