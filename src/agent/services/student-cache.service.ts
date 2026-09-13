import { Injectable } from '@nestjs/common';
import { RedisClient } from '@/agent/tools/clients/redis.client';
import { HustApiClient } from '@/agent/tools/clients/hust-api.client';
import { EHustDbApiClient } from '@/agent/tools/clients/ehust-db.client';
import { SemesterCacheService } from './semester-cache.service'; // Lấy kỳ hiện tại
import { createLogger } from '@/common/logger/logger';

import {FallbackTranscriptProvider} from './provider/fallback.provider'
import {OfficialTranscriptProvider} from './provider/official.provider'
import {TranscriptProvider} from './transcript.provider'


const logger = createLogger('StudentCacheService');

// Định nghĩa TTL
const TTL_7_DAYS = 7 * 24 * 60 * 60;
const TTL_30_DAYS = 30 * 24 * 60 * 60;

@Injectable()
export class StudentCacheService {
    private readonly transcriptProvider: TranscriptProvider;
    private readonly transcriptProviderType: 'fallback' | 'official';

    constructor(
        private readonly redis: RedisClient,
        private readonly hustApi: HustApiClient,
        private readonly ehustDbApi: EHustDbApiClient,
        private readonly semesterCache: SemesterCacheService,
    ) {
        this.transcriptProviderType =
            (process.env.TRANSCRIPT_PROVIDER as 'fallback' | 'official') ??
            'fallback';

        switch (this.transcriptProviderType) {
            case 'official':
                this.transcriptProvider =
                    new OfficialTranscriptProvider(this.ehustDbApi);
                break;

            case 'fallback':
            default:
                this.transcriptProvider =
                    new FallbackTranscriptProvider(
                        this.ehustDbApi,
                        this.hustApi,
                    );
                break;
        }

        logger.info(
            `Transcript provider: ${this.transcriptProviderType}`,
        );
    }

    /**
     * Helper: Format ngày thi từ Timestamp sang chuẩn VN
     */
    private formatExamDate(timestamp: number | string): string {
        const ts = Number(timestamp);
        if (!ts || ts < 0) return 'Chưa có lịch';
        const date = new Date(ts);
        // Trả về dạng: 14:00 25/05/2026
        return date.toLocaleString('vi-VN', { 
            hour: '2-digit', minute: '2-digit', 
            day: '2-digit', month: '2-digit', year: 'numeric',
            timeZone: 'Asia/Ho_Chi_Minh'
        });
    }

    /**
     * Helper: Trích xuất năm nhập học từ MSSV (VD: 20224854 -> 2022)
     */
    private getAdmissionYear(studentId: string): number {
        const yearMatch = studentId.match(/^(\d{4})/);
        return yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();
    }

    private generateSemesters(startYear: number, currentSemester: string): string[] {
        const currentYear = parseInt(currentSemester.substring(0, 4));
        const currentSemNum = parseInt(currentSemester.substring(4));
        const semesters: string[] = [];

        for (let y = startYear; y <= currentYear; y++) {
            for (let s = 1; s <= 3; s++) { // Quét cả kỳ hè (kỳ 3)
                if (y === currentYear && s > currentSemNum) break;
                semesters.push(`${y}${s}`);
            }
        }
        return semesters;
    }
    /**
     * HÀM CHÍNH: Kích hoạt từ AuthController sau khi Login thành công
     * Chạy ngầm (Không cần await khi gọi hàm này ở ngoài)
     */
    async prewarmPersonalData(studentId: string): Promise<void> {
        logger.info(`[${studentId}] Bắt đầu tiến trình Cache Cá nhân...`);

        // Lấy kỳ học hiện tại từ Global Cache
        let currentSemester = '';
        try {
            const currentSemCache = await this.redis.get('hustva:global:semester:current');
            if (!currentSemCache) {
                logger.warn(`[${studentId}] Không có cache học kỳ, hủy tiến trình.`);
                return;
            }
            currentSemester = JSON.parse(currentSemCache).semester;
        } catch (error) {
            logger.error(`[${studentId}] Lỗi parse cache học kỳ, hủy tiến trình.`, { error: String(error) });
            return;
        }

        // Bắn 2 luồng Nhanh và Chậm chạy song song, không chờ nhau
        this.processFastPath(studentId, currentSemester).catch(e => 
            logger.error(`[${studentId}] Lỗi Luồng Nhanh`, { error: String(e) })
        );


        this.processSlowPath(studentId, currentSemester).catch(e => 
            logger.error(`[${studentId}] Lỗi Luồng Chậm (eHUST)`, { error: String(e) })
        );
    }

    // ============================================================================
    // LUỒNG NHANH (~1s): Lấy xong là lưu ngay lập tức
    // ============================================================================
    private async processFastPath(studentId: string, currentSemester: string) {
        const [infoCache, academicCache, scheduleCache, examsCache] = await Promise.all([
            this.redis.get(`hustva:student:${studentId}:info`),
            this.redis.get(`hustva:student:${studentId}:academic_results`),
            this.redis.get(`hustva:student:${studentId}:schedule_v2`),
            this.redis.get(`hustva:student:${studentId}:exams_v2`)
        ]);

        // Nếu tất cả dữ liệu đều đang có sẵn trong Redis -> Ngắt mạch, không gọi API
        if (infoCache && academicCache && scheduleCache && examsCache) {
            logger.info(`[${studentId}] [Hit Cache] Dữ liệu Luồng Nhanh đã có sẵn, bỏ qua fetch API.`);
            return;
        }
        // ---------------------------------------------

        logger.info(`[${studentId}] [Miss Cache] Đang chạy Luồng Nhanh (~1s)...`);
        
        const admissionYear = this.getAdmissionYear(studentId);
        const targetSemesters = this.generateSemesters(admissionYear, currentSemester);

        // Gọi API Info và Academic
        const [infoRes, academicRes] = await Promise.allSettled([
            this.hustApi.getStudentInfo(studentId),
            this.hustApi.getAcademicResult(studentId)
        ]);

        // Gọi API HÀNG LOẠT cho tất cả các kỳ học (Classes & Exams)
        const classesSettled = await Promise.allSettled(
            targetSemesters.map(sem => this.hustApi.getClasses(studentId, sem).then(v => ({ sem, data: v })))
        );
        const examsSettled = await Promise.allSettled(
            targetSemesters.map(sem => this.hustApi.getExams(studentId, sem).then(v => ({ sem, data: v })))
        );

        // 1. Xử lý Student Info
        if (infoRes.status === 'fulfilled' && infoRes.value) {
            const raw = infoRes.value as any;
            const infoData = {
                student_id: raw.studentId,
                full_name: raw.fullName,
                birthdate: raw.birthdate,
                gender: raw.gender,
                program: raw.program,
                school: raw.school,
                student_class: raw.studentClass,
                program_id: raw.programId,
                // Chỉ lấy Tên và Email của GV
                teachers: (raw.teachers || []).map((t: any) => ({
                    full_name: t.fullName,
                    email: t.email
                }))
            };
            await this.redis.set(`hustva:student:${studentId}:info`, JSON.stringify(infoData), TTL_7_DAYS);
        }

        // 2. Xử lý Academic Results (Tổng kết các kỳ)
        if (academicRes.status === 'fulfilled' && academicRes.value) {
            const rawArr = Array.isArray(academicRes.value) ? academicRes.value : (academicRes.value as any).data || [];
            const resultsData = rawArr.map((r: any) => ({
                semester: r.semester,
                level: r.level,
                gpa: r.gpa,
                cpa: r.cpa,
                tpa: r.tpa,
                cumulate_credit: r.cumulateCredit, // Tích lũy
                register_credit: r.registerCredit, // Đã đăng ký
                gpa_credit: r.gpaCredit,           // Tín chỉ tính điểm
                warning_level: r.warningLevel
            }));
            await this.redis.set(`hustva:student:${studentId}:academic_results`, JSON.stringify(resultsData), TTL_7_DAYS);
        }

        // 3. Xử lý Classes (Gom tất cả các kỳ lại)
        const allClasses: any[] = [];
        classesSettled.forEach(res => {
            if (res.status === 'fulfilled' && res.value.data) {
                const sem = res.value.sem;
                const rawArr = Array.isArray(res.value.data) ? res.value.data : (res.value.data as any).data || [];
                
                const mapped = rawArr.map((c: any) => ({
                    semester: sem, // Đánh dấu kỳ học
                    class_id: c.classId,
                    course_id: c.courseId,
                    name: c.name,
                    class_type: c.classType,
                    semester_type: c.semesterType,
                    place_time_info: c.placeTimeInfo
                }));
                allClasses.push(...mapped);
            }
        });
        if (allClasses.length > 0) {
            await this.redis.set(`hustva:student:${studentId}:schedule_v2`, JSON.stringify(allClasses), TTL_7_DAYS);
        }

        // 4. Xử lý Exams (Gom tất cả các kỳ lại)
        const allExams: any[] = [];
        examsSettled.forEach(res => {
            if (res.status === 'fulfilled' && res.value.data) {
                const sem = res.value.sem;
                const rawArr = Array.isArray(res.value.data) ? res.value.data : (res.value.data as any).data || [];
                
                const mapped = rawArr.map((e: any) => ({
                    semester: sem, // Đánh dấu kỳ thi
                    class_id: e.classId,
                    course_id: e.courseId,
                    course_name: e.courseName,
                    exam_date: this.formatExamDate(e.examDate),
                    exam_id: e.examId,
                    place: e.place,
                    exam_group: e.examGroup,
                    session: e.session
                }));
                allExams.push(...mapped);
            }
        });
        if (allExams.length > 0) {
            await this.redis.set(`hustva:student:${studentId}:exams_v2`, JSON.stringify(allExams), TTL_7_DAYS);
        }

        logger.info(`[${studentId}] ✅ Luồng Nhanh hoàn tất! Đã lưu Redis (${allClasses.length} lớp học, ${allExams.length} lịch thi).`);
    }

    // ============================================================================
    // LUỒNG CHẬM (~1 phút): Kéo dữ liệu eHUST DB
    // ============================================================================
    // ============================================================================
// LUỒNG CHẬM (~1 phút): Kéo dữ liệu eHUST DB
// ============================================================================
private async processSlowPath(studentId: string, currentSemester: string) {
    const [profileCacheStr, transcriptCacheStr] = await Promise.all([
        this.redis.get(`hustva:student:${studentId}:extended_profile`),
        this.redis.get(`hustva:student:${studentId}:transcript`)
    ]);

    if (profileCacheStr && transcriptCacheStr) {
        logger.info(`[${studentId}] [Hit Cache] Profile và Bảng điểm đều còn hạn. Bỏ qua hoàn toàn Luồng Chậm.`);
        return;
    }

    logger.info(`[${studentId}] [Miss Cache] Có dữ liệu hết hạn. Bắt đầu Luồng Chậm eHUST...`);

    const provider = (process.env.TRANSCRIPT_PROVIDER ?? 'fallback').toLowerCase();

    try {
        // =====================================================================
        // FALLBACK PROVIDER
        // Profile và Transcript độc lập => chạy song song
        // =====================================================================
        if (provider === 'fallback') {
            const tasks: Promise<void>[] = [];

            if (!profileCacheStr) {
                tasks.push((async () => {
                    logger.info(`[${studentId}] Profile hết hạn. Đang fetchProfileStudent (~25s)...`);

                    const admissionYear = this.getAdmissionYear(studentId);

                    const profileRaw = await this.ehustDbApi.fetchProfileStudent({
                        student_ids: [studentId],
                        admission_years: [admissionYear]
                    });

                    const profileArray = Array.isArray(profileRaw)
                        ? profileRaw
                        : profileRaw?.data || [];

                    const profileData = profileArray[0];

                    if (!profileData || !profileData.crypt_studentid) {
                        logger.warn(`[${studentId}] Không trích xuất được crypt_studentid từ eHUST DB.`);
                        return;
                    }

                    const extendedProfile = {
                        address: profileData.address || '',
                        crypt_studentid: profileData.crypt_studentid,
                        reward: profileData.reward || [],
                        scholarship: profileData.scholarship || [],
                        student_year: profileData.student_year || '',
                        projects: profileData.projects || []
                    };

                    await this.redis.set(
                        `hustva:student:${studentId}:extended_profile`,
                        JSON.stringify(extendedProfile),
                        TTL_30_DAYS
                    );

                    logger.info(`[${studentId}] Đã kéo và lưu Profile mới.`);
                })());
            } else {
                logger.info(`[${studentId}] Profile còn hạn, tái sử dụng hash_mssv: ${JSON.parse(profileCacheStr).crypt_studentid}`);
            }

            if (!transcriptCacheStr) {
                tasks.push((async () => {
                    logger.info(`[${studentId}] Bảng điểm hết hạn. Đang fetchFullTranscriptStudent (~30s)...`);

                    const transcriptData = await this.transcriptProvider.getFullTranscript(
                        studentId,
                        currentSemester
                    );
                    
                    if (transcriptData && Array.isArray(transcriptData)) {
                        const cleanTranscript = transcriptData.map((t: any) => ({
                            course_id: t.CourseID,
                            grade_class: t.GradeClass,
                            grade_exam: t.GradeExam,
                            mark_char: t.MarkChar,
                            term_id: t.TermID
                        }));

                        await this.redis.set(
                            `hustva:student:${studentId}:transcript`,
                            JSON.stringify(cleanTranscript),
                            TTL_7_DAYS
                        );

                        logger.info(`[${studentId}] Đã cập nhật Bảng điểm ${cleanTranscript.length} môn.`);
                    } else {
                        logger.warn(`[${studentId}] Không trích xuất được mảng full_transcript từ eHUST DB.`);
                    }
                })());
            } else {
                logger.info(`[${studentId}] Bảng điểm vẫn còn hạn, bỏ qua API Transcript.`);
            }

            await Promise.all(tasks);
            return;
        }

        // =====================================================================
        // OFFICIAL PROVIDER
        // Bắt buộc lấy Profile trước để có crypt_studentid
        // =====================================================================

        let hashMssv = '';

        if (!profileCacheStr) {
            logger.info(`[${studentId}] Profile hết hạn. Đang fetchProfileStudent (~25s)...`);

            const admissionYear = this.getAdmissionYear(studentId);

            const profileRaw = await this.ehustDbApi.fetchProfileStudent({
                student_ids: [studentId],
                admission_years: [admissionYear]
            });

            const profileArray = Array.isArray(profileRaw)
                ? profileRaw
                : profileRaw?.data || [];

            const profileData = profileArray[0];

            if (!profileData || !profileData.crypt_studentid) {
                logger.warn(`[${studentId}] Không trích xuất được crypt_studentid từ eHUST DB.`);
                return;
            }

            hashMssv = profileData.crypt_studentid;

            const extendedProfile = {
                address: profileData.address || '',
                crypt_studentid: hashMssv,
                reward: profileData.reward || [],
                scholarship: profileData.scholarship || [],
                student_year: profileData.student_year || '',
                projects: profileData.projects || []
            };

            await this.redis.set(
                `hustva:student:${studentId}:extended_profile`,
                JSON.stringify(extendedProfile),
                TTL_30_DAYS
            );

            logger.info(`[${studentId}] Đã kéo và lưu Profile mới.`);
        } else {
            hashMssv = JSON.parse(profileCacheStr).crypt_studentid;
            logger.info(`[${studentId}] Profile còn hạn, tái sử dụng hash_mssv: ${hashMssv}`);
        }

        if (!hashMssv) {
            return;
        }

        if (!transcriptCacheStr) {
            logger.info(`[${studentId}] Bảng điểm hết hạn. Đang fetchFullTranscriptStudent (~30s)...`);

            const transcriptData = await this.transcriptProvider.getFullTranscript(
                studentId,
                currentSemester
            );

            if (transcriptData && Array.isArray(transcriptData)) {
                const cleanTranscript = transcriptData.map((t: any) => ({
                    course_id: t.CourseID,
                    grade_class: t.GradeClass,
                    grade_exam: t.GradeExam,
                    mark_char: t.MarkChar,
                    term_id: t.TermID
                }));

                await this.redis.set(
                    `hustva:student:${studentId}:transcript`,
                    JSON.stringify(cleanTranscript),
                    TTL_7_DAYS
                );

                logger.info(`[${studentId}] Đã cập nhật Bảng điểm ${cleanTranscript.length} môn.`);
            } else {
                logger.warn(`[${studentId}] Không trích xuất được mảng full_transcript từ eHUST DB.`);
            }
        } else {
            logger.info(`[${studentId}] Bảng điểm vẫn còn hạn, bỏ qua API Transcript.`);
        }

    } catch (error) {
        logger.error(
            `[${studentId}] Lỗi nghiêm trọng tại Luồng Chậm eHUST`,
            { error: String(error) }
        );
    }
}
}