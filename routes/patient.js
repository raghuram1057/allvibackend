const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

router.post('/onboard', async (req, res) => {
    console.log("--- New Onboarding Request Received ---");
    const { labData } = req.body;
    const allviId = `ALLVI-${Math.floor(1000 + Math.random() * 9000)}`;

    try {
        // Step 1: Create Patient
        const { error: pError } = await supabase
            .from('patients')
            .insert([{ allvi_id: allviId }]);
        
        if (pError) throw new Error("Patient creation failed: " + pError.message);
        console.log("✅ Step 1: Patient Created", allviId);

        // Step 2: Format & Insert Labs
        const { error: lError } = await supabase
            .from('lab_results')
            .insert([{
                patient_id: allviId,
                test_date: labData.test_date,
                tsh: parseFloat(labData.tsh) || null,
                free_t3: parseFloat(labData.free_t3) || null,
                free_t4: parseFloat(labData.free_t4) || null,
                ferritin: parseFloat(labData.ferritin) || null,
                vit_d: parseFloat(labData.vit_d) || null
            }]);

        if (lError) throw new Error("Lab storage failed: " + lError.message);
        console.log("✅ Step 2: Labs Stored");

        res.status(200).json({ success: true, allvi_id: allviId });
    } catch (err) {
        console.error("❌ SERVER ERROR:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;