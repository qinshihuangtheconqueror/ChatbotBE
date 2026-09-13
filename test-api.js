const jwt = require('jsonwebtoken');
const http = require('http');
const secret = 'your-jwt-secret-here';
const token = jwt.sign({ sub: '20210001', role: 'student' }, secret, { expiresIn: '1h' });
const body = JSON.stringify({
    message: 'Điều kiện để được xét cấp học bổng khuyến khích học tập tại ĐHBK là gì?',
    thread_id: 'test-final-' + Date.now(),
    student_id: '20210001'
});
const opts = {
    hostname: '127.0.0.1',
    port: 3001,
    path: '/v1/chat/respond',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        'Content-Length': Buffer.byteLength(body)
    }
};
console.log('Sending API call...');
const req = http.request(opts, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
        try {
            const j = JSON.parse(d);
            const ans = j?.output?.response || j?.response || d;
            console.log('=== RESPONSE ===\n', ans.substring(0, 800) + '...\n');
            console.log('=== CHECKS ===');
            console.log('Has http link:', /https?:\/\//.test(ans) ? 'YES' : 'NO');
            console.log('Has tham khao block:', /tham kh/i.test(ans) ? 'YES' : 'NO');
            console.log('Has leftover [Cx]:', /\[C\d\]/.test(ans) ? 'YES (BAD)' : 'NO');
        } catch (e) {
            console.log('RAW ERROR:', d);
        }
    });
});
req.on('error', e => console.error(e.message));
req.write(body);
req.end();
