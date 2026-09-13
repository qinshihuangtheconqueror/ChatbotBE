/**
 * auth.service.ts — HustVA Authentication Service
 *
 * Flow:
 *   1. Nhận studentId + password từ client
 *   2. Gọi eHUST API để verify credentials (lấy student info)
 *   3. Nếu thành công → ký JWT với payload { student_id, sub }
 *   4. Trả { accessToken, studentId, fullName }
 *
 * JWT strategy:
 *   - Algorithm: HS256
 *   - Expiry: 8h (phù hợp 1 ngày làm việc)
 *   - Secret: envConfig.JWT_SECRET
 */
import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as path from 'path';
import * as bcrypt from 'bcrypt';
import { envConfig } from '@/common/config/env.config';
import { createLogger } from '@/common/logger/logger';
import { StudentGraphService } from '@/agent/services/student-graph.service';
import { StudentCacheService } from '@/agent/services/student-cache.service';

const logger = createLogger('AuthService');

export interface LoginResult {
    accessToken: string;
    studentId: string;
    fullName: string;
    program: string;
}

@Injectable()
export class AuthService {
    constructor(
        private readonly studentGraph: StudentGraphService,
        private readonly studentCache: StudentCacheService
    ) {}
    /**
     * Verify student credentials against eHUST API.
     * eHUST uses the partner API — we call /student/info with the student's
     * session credentials and validate identity.
     *
     * In practice: eHUST doesn't expose a public OAuth/SSO endpoint for partners,
     * so we use the HUST partner API token (system-level) and verify the
     * student_id exists & is active. Password check is delegated to eHUST via
     * the Authorization header that carries the student's credentials.
     */
    async login(studentId: string, password: string): Promise<LoginResult> {
        // Build Basic auth header for eHUST (username:password → base64)
        const credentials = Buffer.from(`${studentId}:${password}`).toString('base64');
        const url = `${envConfig.HUST_BASE_API_URL}/student/info?username=${studentId}`;

        logger.info('Verifying student credentials', { studentId });

        let studentInfo: any;
        try {
            const resp = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Basic ${credentials}`,
                    'token': envConfig.HUST_API_TOKEN,
                    'Content-Type': 'application/json',
                },
                signal: AbortSignal.timeout(10_000),
            });

            if (resp.status === 401 || resp.status === 403) {
                logger.warn('eHUST rejected credentials', { studentId, status: resp.status });
                throw new UnauthorizedException('Sai MSSV hoặc mật khẩu eHUST');
            }

            if (!resp.ok) {
                logger.error('eHUST API error', { studentId, status: resp.status });
                throw new UnauthorizedException('Không thể xác thực với hệ thống HUST. Thử lại sau.');
            }

            const body = await resp.json() as any;
            // eHUST partner API returns { d: { ... student fields ... } }
            studentInfo = body?.d || body;

            if (!studentInfo?.id && !studentInfo?.username) {
                throw new UnauthorizedException('Không tìm thấy sinh viên trong hệ thống HUST');
            }
        } catch (e: any) {
            if (e instanceof UnauthorizedException) throw e;
            logger.error('eHUST API unreachable', { error: e.message });
            throw new UnauthorizedException('Không thể kết nối hệ thống xác thực HUST');
        }

        const fullName: string = studentInfo.fullname || studentInfo.name || studentId;
        const program: string = studentInfo.program || studentInfo.sClass || '';

        // Sign JWT — 8h expiry
        const accessToken = jwt.sign(
            {
                sub: studentId,
                student_id: studentId,
                name: fullName,
            },
            envConfig.JWT_SECRET,
            { expiresIn: '8h', algorithm: 'HS256' },
        );

        logger.info('Login successful', { studentId, fullName });
        // Fire-and-forget: seed student graph in background (skips if already seeded this semester)
        this.studentGraph.ensureStudentGraph(studentId).catch(e =>
            logger.warn('Student graph seed failed', { studentId, error: String(e) })
        );
        return { accessToken, studentId, fullName, program };
    }

    /** Verify a JWT and return the student_id payload (used in middleware too) */
    verifyToken(token: string): { studentId: string } {
        try {
            const payload = jwt.verify(token, envConfig.JWT_SECRET) as any;
            return { studentId: payload.student_id || payload.sub };
        } catch {
            throw new UnauthorizedException('Token không hợp lệ hoặc đã hết hạn');
        }
    }

    /**
     * Demo login — validates email+password against local credentials.json
     * Returns studentId + JWT accessToken (same shape as eHUST login).
     */
    async demoLogin(email: string, password: string): Promise<{ studentId: string; displayName: string; accessToken: string }> {
        const credFile = path.join(__dirname, '..', '..', 'common', 'data', 'credentials.json');
        let creds: Array<{ email: string; password: string; studentId: string; displayName: string }>;
        try {
            creds = JSON.parse(fs.readFileSync(credFile, 'utf8'));
        } catch {
            logger.error('credentials.json not found or invalid');
            throw new UnauthorizedException('Hệ thống xác thực tạm thời không khả dụng');
        }
        const user = creds.find(c => c.email === email.trim().toLowerCase());
        if (!user || !(await bcrypt.compare(password, user.password))) {
            logger.warn('Demo login failed', { email });
            throw new UnauthorizedException('Email hoặc mật khẩu không đúng');
        }
        // Sign JWT — same shape as eHUST login
        const accessToken = jwt.sign(
            { sub: user.studentId, student_id: user.studentId, name: user.displayName },
            envConfig.JWT_SECRET,
            { expiresIn: '8h', algorithm: 'HS256' },
        );
        logger.info('Demo login success', { email, studentId: user.studentId });
        this.studentGraph.ensureStudentGraph(user.studentId).catch(e =>
            logger.warn('Student graph seed failed (demo)', { studentId: user.studentId, error: String(e) })
        );
        return { studentId: user.studentId, displayName: user.displayName, accessToken };
    }

    /**
     * Microsoft OAuth2 login. (ĐÃ THÊM DEBUG)
     * Dev/test: accepts any Microsoft account (‘common’ tenant).
     * Flow: exchange auth code → call Graph /me → derive studentId from MS oid → sign JWT.
     *
     * studentId for MS users: ‘ms_’ + first 12 chars of oid (stable, unique per MS account).
     */

    async microsoftLogin(code: string, redirectUri: string): Promise<LoginResult> {
        logger.debug('\n[DEBUG-MS] 🚀 ====== BẮT ĐẦU LUỒNG MICROSOFT LOGIN ======');
        logger.debug(`[DEBUG-MS] 1. Nhận được Code từ FE: ${code.substring(0, 15) + '...'}`);
        logger.debug(`[DEBUG-MS] 2. Redirect URI FE gửi lên (Rất quan trọng): [${redirectUri}]`);
        
        const tenant = envConfig.MS_TENANT_ID;
        const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
        
        logger.debug(`[DEBUG-MS] 3. Tenant đang dùng: [${tenant}]`);
        logger.debug(`[DEBUG-MS] 4. Client ID đang dùng: [${envConfig.MS_CLIENT_ID}]`);

        // 1. Exchange code for access token
        let msToken: string;
        try {
            const params = new URLSearchParams({
                client_id: envConfig.MS_CLIENT_ID,
                client_secret: envConfig.MS_CLIENT_SECRET,
                code,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code',
                scope: 'openid email profile User.Read',
            });
            
            logger.debug(`[DEBUG-MS] 5. Đang gọi API lấy Token của Microsoft...`);
            const resp = await fetch(tokenUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: params.toString(),
                signal: AbortSignal.timeout(10_000),
            });
            
            const body = await resp.json() as any;
            logger.debug(`[DEBUG-MS] 6. Mã HTTP phản hồi từ MS: ${resp.status}`);
            
            if (!resp.ok || body.error) {
                logger.error(`[DEBUG-MS] ❌ LỖI TỪ MICROSOFT:`, body.error);
                logger.error(`[DEBUG-MS] ❌ CHI TIẾT LỖI:`, body.error_description);
                throw new UnauthorizedException(body.error_description || 'Xác thực Microsoft thất bại');
            }
            
            msToken = body.access_token;
            logger.debug(`[DEBUG-MS] ✅ 7. Lấy Token thành công!`);
        } catch (e: any) {
            logger.error(`[DEBUG-MS] ❌ LỖI MẠNG HOẶC CATCH KHI LẤY TOKEN:`, e.message);
            if (e instanceof UnauthorizedException) throw e;
            throw new UnauthorizedException('Không kết nối được Microsoft');
        }

        // 2. Get user info from Microsoft Graph
        let msUser: { id: string; displayName: string; mail: string; userPrincipalName: string };
        try {
            logger.debug(`[DEBUG-MS] 8. Đang gọi MS Graph để lấy thông tin User...`);
            const resp = await fetch('https://graph.microsoft.com/v1.0/me', {
                headers: { Authorization: `Bearer ${msToken}` },
                signal: AbortSignal.timeout(8_000),
            });
            msUser = await resp.json() as any;
            if (!msUser?.id) throw new Error('Empty Graph response');
            logger.debug(`[DEBUG-MS] ✅ 9. Lấy thông tin thành công`);
        } catch (e: any) {
            logger.error(`[DEBUG-MS] ❌ LỖI MS GRAPH:`, e.message);
            throw new UnauthorizedException('Không lấy được thông tin tài khoản Microsoft');
        }

        const email = msUser.mail || msUser.userPrincipalName || '';
        const fullName = msUser.displayName || email;
        const emailPrefix = email.split('@')[0];
        const domain = email.split('@')[1] || '';

        let studentId: string;
        if (domain === 'sis.hust.edu.vn' || domain === 'hust.edu.vn') {
            if (/^\d+$/.test(emailPrefix)) {
                studentId = emailPrefix;
            } else {
                const match = emailPrefix.match(/(\d+)$/);
                studentId = match ? '20' + match[1] : emailPrefix;
            }
        } else {
            studentId = 'ms_' + msUser.id.replace(/-/g, '').slice(0, 12);
        }

        logger.debug(`[DEBUG-MS] 10. Xử lý xong StudentID: ${studentId}`);

        // 3. Sign JWT
        const accessToken = jwt.sign(
            { sub: studentId, student_id: studentId, name: fullName, ms_email: email },
            envConfig.JWT_SECRET,
            { expiresIn: '8h', algorithm: 'HS256' },
        );

        // this.studentGraph.ensureStudentGraph(studentId).catch(e =>
        //     logger.warn('Student graph seed failed (ms)', { studentId, error: String(e) })
        // );

        this.studentCache.prewarmPersonalData(studentId).catch(e =>
            logger.warn('Student cache prewarm failed (ms)', { studentId, error: String(e) })
        );

        logger.debug(`[DEBUG-MS] 🎉 ====== HOÀN TẤT LOGIN THÀNH CÔNG ====== \n`);
        return { accessToken, studentId, fullName, program: '' };
    }
}
