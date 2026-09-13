import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { envConfig } from '@/common/config/env.config';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('EHustDbApiClient');

export interface FetchProfileFilters {
    admission_years?: number[];
    semesters?: string[];
    student_ids?: string[];
}

export interface FetchTranscriptFilters {
    student_ids: string[];
}

export class EHustDbApiClient {
    private readonly http: AxiosInstance;

    constructor() {
        const headers: Record<string, string> = {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            // Default configured token or fallback for public api
            Authorization: envConfig.EHUST_DB_API_TOKEN || '',
        };

        this.http = axios.create({
            baseURL: envConfig.EHUST_DB_API_URL || 'https://e.hust.edu.vn/db-api/public-api',
            headers,
            timeout: 60000, // 60 seconds (these APIs can be very slow)
        });

        axiosRetry(this.http, {
            retries: 3,
            retryDelay: (retryNumber) => 2000 * retryNumber,
            retryCondition: (error) => {
                // Retry on 502/504 as well, since eHUST DB API often throws 502
                return axiosRetry.isNetworkOrIdempotentRequestError(error) || error.response?.status === 502 || error.response?.status === 504;
            }
        });
    }

    /**
     * fetch_profile_student
     * Lấy thông tin sinh viên theo khoá hoặc ID (bao gồm cả bảng điểm, danh hiệu)
     */
    async fetchProfileStudent(filters: FetchProfileFilters) {
        try {
            const body = {
                api_name: 'fetch_profile_student',
                with_last_update: false,
                filters: {
                    admission_years: filters.admission_years || [],
                    semesters: filters.semesters || [],
                    student_ids: filters.student_ids || [],
                }
            };
            const res = await this.http.post<any>('', body);
            return res.data;
        } catch (e: any) {
            logger.error('EHustDbApi: fetchProfileStudent failed', { error: String(e) });
            throw e;
        }
    }

    /**
     * fetch_full_transcript_student
     * Lấy chi tiết bảng điểm, đầu vào phải là hash_student_id
     */
    async fetchFullTranscriptStudent(hashStudentIds: string[]) {
        try {
            const body = {
                api_name: 'fetch_full_transcript_student',
                with_last_update: false,
                filters: {
                    student_ids: hashStudentIds || [],
                }
            };
            const res = await this.http.post<any>('', body);
            return res.data;
        } catch (e: any) {
            logger.error('EHustDbApi: fetchFullTranscriptStudent failed', { error: String(e) });
            throw e;
        }
    }//died

    async fetchFullTranscriptStudentDS(hashStudentIds: string[]) {
        try {
            const body = {
                api_name: 'fetch_full_transcript_student_ds',
                with_last_update: false,
                filters: {
                    student_ids: hashStudentIds || [],
                }
            };
            const res = await this.http.post<any>('', body);
            return res.data;
        } catch (e: any) {
            logger.error('EHustDbApi: fetchFullTranscriptStudentDS failed', { error: String(e) });
            throw e;
        }
    }
    
    /**
     * fetch_courses
     * Lấy toàn bộ danh sách môn học và tài liệu liên quan của HUST
     */
    async fetchCourses() {
        try {
            const body = {
                api_name: 'fetch_courses',
                with_last_update: false,
                filters: {}
            };
            const res = await this.http.post<any>('', body);
            return res.data;
        } catch (e: any) {
            logger.error('EHustDbApi: fetchCourses failed', { error: String(e) });
            throw e;
        }
    }
}
