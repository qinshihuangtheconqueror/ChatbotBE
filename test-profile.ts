import { EHustDbApiClient } from './src/agent/tools/clients/ehust-db.client';

async function verifyPayload() {
    const dbApi = new EHustDbApiClient();

    try {
        console.log('Testing Default Payload [2022]...');
        try {
            await dbApi.fetchProfileStudent({ admission_years: [2022], semesters: [], student_ids: ['20225976'] });
        } catch (e) {
            console.log('Got expected 502/504 error');
        }

        console.log('Testing Fallback Payload []...');
        const pData = await dbApi.fetchProfileStudent({ admission_years: [], semesters: [], student_ids: ['20225976'] });

        console.log('IsArray:', Array.isArray(pData));
        console.log('Length:', pData?.length);
        console.log('Keys:', Object.keys(pData));

        if (Array.isArray(pData)) {
            console.log('pData[0] keys:', Object.keys(pData[0]));
            console.log('pData[0].encode_studentId:', pData[0].encode_studentId);
        } else {
            console.log('pData (not array) keys:', Object.keys(pData));
        }

    } catch (err) {
        console.error(err);
    }
}
verifyPayload();
