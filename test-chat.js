const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const secret = 'your-jwt-secret-here';
const studentId = '202416773';
const token = jwt.sign({ sub: studentId, email: studentId + '@sis.hust.edu.vn' }, secret, { expiresIn: '1h' });

const questions = [
    { question: 'Điều kiện để được xét cấp học bổng khuyến khích học tập tại ĐHBK là gì?', type: 'rag' },
    { question: 'GPA kỳ mới nhất của tôi là bao nhiêu', type: 'academic' },
];

async function runTests() {
    for (const q of questions) {
        console.log('\n========================================');
        console.log(`[${q.type.toUpperCase()}] ${q.question}`);
        console.log('========================================');
        try {
            const res = await fetch('http://localhost:3001/v1/chat/respond', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    thread_id: 'test-' + crypto.randomUUID(),
                    message: q.question
                    // NOTE: student_id is NOT sent — auth middleware resolves it from JWT
                })
            });
            const data = await res.json();
            if (data.error || data.statusCode) {
                console.log('❌ ERROR:', JSON.stringify(data));
            } else {
                const text = data.assistant?.text || data.answer || '';
                console.log('✅ Bot:', text.substring(0, 600));
                console.log('\n--- Checks ---');
                console.log('Has link:     ', /https?:\/\//.test(text) ? '✅ YES' : '❌ NO');
                console.log('Has tham khảo:', /tham kh/i.test(text) ? '✅ YES' : '❌ NO');
                console.log('Skills used:  ', data.meta?.skills_used?.join(', ') || 'N/A');
                console.log('Latency:      ', data.meta?.latency_ms + 'ms');
            }
        } catch (e) {
            console.error('❌ Fetch error:', e.message);
        }
    }
}

runTests();
