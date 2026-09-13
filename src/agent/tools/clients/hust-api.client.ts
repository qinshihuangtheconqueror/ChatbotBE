import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { envConfig } from '@/common/config/env.config';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('HustApiClient');

/**
 * eHUST Partner API Client
 *
 * Method:  POST (all endpoints)
 * Params:  passed as query string (no request body)
 * Auth:    token= query param + Authorization header
 * Shape:   response.data = { data: T } or T directly
 *
 * Verified from V2 production code (hust_student_client.py):
 *   response = client.post(path, params=merged_params)
 *   if isinstance(payload, Mapping) and "data" in payload:
 *       return payload["data"]
 */
export class HustApiClient {
    private readonly http: AxiosInstance;
    private readonly token: string;

    constructor() {
        this.token = envConfig.HUST_API_TOKEN;
        const headers: Record<string, string> = {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: envConfig.HUST_AUTHORIZATION_TOKEN,
        };
        // JSESSIONID is required by /student/info endpoint (confirmed from V2 production env)
        if (envConfig.HUST_JSESSIONID) {
            headers['Cookie'] = `JSESSIONID=${envConfig.HUST_JSESSIONID}`;
        }
        this.http = axios.create({
            baseURL: envConfig.HUST_BASE_API_URL,
            headers,
            timeout: envConfig.HUST_API_TIMEOUT,
        });
        axiosRetry(this.http, {
            retries: envConfig.HUST_API_RETRY_COUNT,
            retryDelay: (retryNumber) =>
                envConfig.HUST_API_RETRY_DELAY * retryNumber,
        });
    }

    /**
     * POST with ALL params as query string, body is ALWAYS empty.
     * Confirmed from Postman collection: no request body, all params in QS.
     * Unwraps { data: T } envelope automatically.
     */
    private async request<T = unknown>(
        path: string,
        extra: Record<string, string | number | undefined> = {},
    ): Promise<T> {
        const params: Record<string, string> = { token: this.token };
        for (const [k, v] of Object.entries(extra)) {
            if (v !== undefined && v !== '') params[k] = String(v);
        }
        // Body is intentionally undefined — Postman collection confirms empty body
        const res = await this.http.post<{ data: T } | T>(path, undefined, { params });
        const payload = res.data as any;
        if (payload && typeof payload === 'object' && 'data' in payload) {
            return payload.data as T;
        }
        return payload as T;
    }

    /** POST /student/info — thông tin sinh viên */
    async getStudentInfo(studentId: string) {
        try {
            return await this.request<Record<string, unknown>>('/student/info', { studentId });
        } catch (e) {
            logger.error('getStudentInfo failed', { studentId, error: String(e) });
            throw e;
        }
    }

    /**
     * POST /grades — kết quả học tập
     * Postman: ?semester=20241&studentId=202416773&token=...
     * semester is OPTIONAL (omit = all semesters)
     */
    async getGrades(studentId: string, semester?: string) {
        try {
            return await this.request('/grades', { studentId, semester });
        } catch (e) {
            logger.error('getGrades failed', { studentId, error: String(e) });
            throw e;
        }
    }

    /**
     * POST /academicresult — GPA, CPA, cảnh báo học tập theo kỳ   ****KHÔNG CÓ KỲ HÈ
     * Postman: ?semester=20241&studentId=...&token=...
     */
    async getAcademicResult(studentId: string, semester?: string) {
        try {
            return await this.request('/academicresult', { studentId, semester });
        } catch (e) {
            logger.error('getAcademicResult failed', { studentId, error: String(e) });
            throw e;
        }
    }

    /**
     * POST /classes — thời khóa biểu  **** CÓ KỲ HÈ
     * Postman: ?semester=20241&studentId=...&token=...
     */
    async getClasses(studentId: string, semester?: string) {
        try {
            return await this.request('/classes', { studentId, semester });
        } catch (e) {
            logger.error('getClasses failed', { studentId, semester, error: String(e) });
            throw e;
        }
    }

    /**
     * POST /exams — lịch thi   **** KHÔNG CÓ KỲ HÈ
     * Postman: ?semester=20241&studentId=...&token=...
     */
    async getExams(studentId: string, semester?: string) {
        try {
            return await this.request('/exams', { studentId, semester });
        } catch (e) {
            logger.error('getExams failed', { studentId, semester, error: String(e) });
            throw e;
        }
    }

    /** POST /semesters — danh sách học kỳ */
    async getSemesters() {
        try {
            return await this.request('/semesters');
        } catch (e) {
            logger.error('getSemesters failed', { error: String(e) });
            throw e;
        }
    }

    /** POST /program — thông tin chương trình đào tạo */
    async getProgram(programId: string) {
        try {
            return await this.request('/program', { programId });
        } catch (e) {
            logger.error('getProgram failed', { programId, error: String(e) });
            throw e;
        }
    }

    /** POST /gradebycourseid — điểm theo môn */
    async getGradeByCourseId(studentId: string, courseId: string) {
        try {
            return await this.request('/gradebycourseid', { studentId, courseId });
        } catch (e) {
            logger.error('getGradeByCourseId failed', { studentId, courseId, error: String(e) });
            throw e;
        }
    }

    /** POST /teacher/search — tìm kiếm giảng viên */
    async searchTeacher(keyWord: string) {
        try {
            return await this.request('/teacher/search', { keyWord });
        } catch (e) {
            logger.error('searchTeacher failed', { keyWord, error: String(e) });
            throw e;
        }
    }

    /**
     * POST /student/study-conditions — điều kiện KS/ThS
     * Postman: chỉ cần ?token=... (không có studentId!)
     * Response: { kscs: { project, credit }, ths: { cpa, status } }
     */
    async getStudyConditions() {
        try {
            return await this.request<{ kscs: Record<string, string>; ths: Record<string, string> }>(
                '/student/study-conditions'
            );
        } catch (e) {
            logger.error('getStudyConditions failed', { error: String(e) });
            throw e;
        }
    }

    /** POST /teacher/research-topic — đề tài NCKH của giảng viên */
    async getTeacherResearchTopics(teacherId: string) {
        try {
            return await this.request('/teacher/research-topic', { teacherId });
        } catch (e) {
            logger.warn('getTeacherResearchTopics failed', { teacherId, error: String(e) });
            return { data: [] };
        }
    }

    /** POST /company/search — tìm kiếm công ty đối tác */
    async searchCompanies(keyWord: string = '') {
        try {
            return await this.request('/company/search', { keyWord });
        } catch (e) {
            logger.warn('searchCompanies failed', { keyWord, error: String(e) });
            return { data: [] };
        }
    }

    /** POST /company/research-topic — đề tài thực tập/NCKH của công ty */
    async getCompanyTopics(companyId: string) {
        try {
            return await this.request('/company/research-topic', { companyId });
        } catch (e) {
            logger.warn('getCompanyTopics failed', { companyId, error: String(e) });
            return { data: [] };
        }
    }

    /**
     * POST /student/kscs — điều kiện học KSCS có thể đăng ký
     * Postman: ?programId=IT-E15&token=... (dùng programId, KHÔNG phải studentId)
     * Returns list of KSCS programs student can enroll in
     */
    async getKscsPrograms(programId: string) {
        try {
            return await this.request('/student/kscs', { programId });
        } catch (e) {
            logger.warn('getKscsPrograms failed', { programId, error: String(e) });
            return null;
        }
    }
}
