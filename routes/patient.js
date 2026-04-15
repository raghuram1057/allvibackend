const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * @route   POST /api/patient/onboard
 * @desc    Handles de-identification and stores parsed lab results
 */
router.post('/onboard', async (req, res) => {
    console.log("📥 Processing Lab Report Data...");
    
    const { labData } = req.body;
    let finalAllviId = labData.existingId; // Check if user provided an ID

    try {
        // --- STEP 1: IDENTITY MANAGEMENT ---
        if (!finalAllviId) {
            // New User: Generate a fresh de-identified ID
            finalAllviId = `ALLVI-${Math.floor(1000 + Math.random() * 9000)}`;
            
            const { error: pError } = await supabase
                .from('patients')
                .insert([{ allvi_id: finalAllviId }]);

            if (pError) throw new Error("Failed to create new patient ID: " + pError.message);
            console.log(`✅ New Patient Created: ${finalAllviId}`);
        } else {
            // Returning User: Verify the ID exists in the database
            const { data: existingPatient, error: fetchError } = await supabase
                .from('patients')
                .select('allvi_id')
                .eq('allvi_id', finalAllviId)
                .single();

            if (fetchError || !existingPatient) {
                return res.status(404).json({ 
                    success: false, 
                    error: "Provided ALLVI-ID not found. Please check the ID or leave blank for a new one." 
                });
            }
            console.log(`🔄 Returning Patient Verified: ${finalAllviId}`);
        }

        // --- STEP 2: STORE PARSED LAB RESULTS ---
        const formattedData = {
            patient_id: finalAllviId,
            test_date: labData.test_date || new Date().toISOString().split('T')[0],
            tsh: parseFloat(labData.tsh) || null,
            free_t3: parseFloat(labData.free_t3) || null,
            free_t4: parseFloat(labData.free_t4) || null,
            ferritin: parseFloat(labData.ferritin) || null,
            vit_d: parseFloat(labData.vit_d) || null,
            anti_tpo: parseFloat(labData.anti_tpo) || null // Added as per your Phase 1 list
        };

        const { error: lError } = await supabase
            .from('lab_results')
            .insert([formattedData]);

        if (lError) throw new Error("Failed to store lab data: " + lError.message);
        
        console.log("✅ Lab results successfully linked to ID");

        // --- STEP 3: SUCCESS RESPONSE ---
        res.status(200).json({ 
            success: true, 
            allvi_id: finalAllviId,
            message: "Data processed and stored successfully."
        });

    } catch (err) {
        console.error("❌ Server Process Error:", err.message);
        res.status(500).json({ 
            success: false, 
            error: err.message 
        });
    }
});

module.exports = router;