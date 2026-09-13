import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { StateAnnotation, StudentContext, AcademicResult } from './state';
import { HistoryStore } from '../../persistence/history.store';
import { HustApiClient } from '../../tools/clients/hust-api.client';
import { RedisClient } from '../../tools/clients/redis.client';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('LoadContextNode');

/**
 * load_context: Runs at the START of every conversation turn.
 * 
 * Nhiệm vụ:
 * 1. Load History (Tóm tắt lịch sử chat).
 * 2. Lấy Global Temporal Context từ SemesterCacheService (Redis).
 * 3. Load Student Context từ StudentCacheService (Redis).
 */
export async function loadContextNode(
    state: typeof StateAnnotation.State,
    config?: LangGraphRunnableConfig,
    historyStore?: HistoryStore,
    hustApi?: HustApiClient,
    redis?: RedisClient,
): Promise<Partial<typeof StateAnnotation.State>> {
    const threadId = config?.configurable?.thread_id as string | undefined;
    const studentId = config?.configurable?.student_id as string | undefined;

    const result: Partial<typeof StateAnnotation.State> = {
        history_summary: state.history_summary || '',
    };

    // ── 1. Load conversation history ──────────────────────────────────────────
    if (historyStore && threadId) {
        try {
            const persistence = await historyStore.loadContext(threadId, studentId || 'anonymous');
            logger.info('History loaded', { threadId, turns: persistence.turns?.length || 0 });
            result.history_summary = persistence.summary || '';
        } catch (e) {
            logger.error('Failed to load history', e, { threadId });
        }
    }

    // ── 2. Kéo bối cảnh Thời gian (Academic Time) từ Global Cache ─────────────
    let globalSemester = {
        semester: '',
        currentWeek: 1,
        absoluteCurrentWeek: 1
    };

    if (redis) {
        try {
            const semCacheStr = await redis.get('hustva:global:semester:current');
            if (semCacheStr) {
                const parsed = JSON.parse(semCacheStr);
                globalSemester = {
                    semester: parsed.semester || '',
                    currentWeek: parsed.currentWeek || 1,
                    absoluteCurrentWeek: parsed.absoluteCurrentWeek || 1
                };
            }
        } catch (e) {
            logger.warn('Không thể đọc Global Semester Cache', { error: String(e) });
        }
    }

    // Fallback: Lỡ Redis trống, dùng logic nhẩm thô
    if (!globalSemester.semester) {
        logger.info('Global Semester Cache trống, sử dụng fallback logic để ước tính học kỳ hiện tại');
        const now = new Date();
        const month = now.getMonth() + 1;
        const year = now.getFullYear();
        globalSemester.semester = month >= 9 ? `${year}1` : (month >= 2 && month <= 7 ? `${year - 1}2` : (month === 8 ? `${year - 1}3` : `${year - 1}1`));
    }

    // Nếu không có sinh viên đăng nhập hoặc State đã có context -> Dừng sớm
    if (!studentId || state.student_context) {
        return result; 
    }

    if (!redis) {
        logger.warn('Redis client is missing in load_context');
        return result;
    }

    // ── 3. Lấy dữ liệu Cá nhân từ Shared Cache của StudentCacheService ────────
    try {
        const infoCacheKey = `hustva:student:${studentId}:info`;
        const academicCacheKey = `hustva:student:${studentId}:academic_results`;

        const [infoCache, academicCache] = await Promise.all([
            redis.get(infoCacheKey),
            redis.get(academicCacheKey)
        ]);

        let info: any = null;
        let academic: any[] = [];

        if (infoCache) info = JSON.parse(infoCache);
        
        if (academicCache) {
            const parsedAca = JSON.parse(academicCache);
            if (Array.isArray(parsedAca) && parsedAca.length > 0) {
                parsedAca.sort((a, b) => String(b.semester || '').localeCompare(String(a.semester || '')));
                academic = [parsedAca[0]];
            }
        }

        // Fallback: Gọi API trực tiếp nếu Cache cá nhân trống 
        if (!info && hustApi) {
            logger.info('Student Cache trống ở vòng chạy đầu, fetching fallback từ eHUST API...', { studentId });
            const [infoRes, academicRes] = await Promise.allSettled([
                hustApi.getStudentInfo(studentId),
                hustApi.getAcademicResult(studentId),
            ]);

            info = infoRes.status === 'fulfilled' ? infoRes.value : null;
            
            if (academicRes.status === 'fulfilled' && academicRes.value) {
                const rawArr = Array.isArray(academicRes.value) 
                    ? academicRes.value 
                    : (academicRes.value as any).data || [];
                    
                if (rawArr.length > 0) {
                    rawArr.sort((a: any, b: any) => String(b.semester || '').localeCompare(String(a.semester || '')));
                    academic = [rawArr[0]];
                }
            }
        }

        if (!info && academic.length === 0) {
            logger.warn('Không tìm thấy dữ liệu sinh viên trong Cache & API', { studentId });
            return result;
        }


        // ── 4. Đóng gói Context đẩy vào State ───────────────────────────────────
        const ctx: any = {
            // Tương thích cả snake_case (từ Redis) và camelCase (từ API fallback)
            studentId: info?.student_id || info?.studentId || studentId,
            fullName: info?.full_name || info?.fullName || '',
            program: info?.program || '',
            programId: info?.program_id || info?.programId || '',
            school: info?.school || '',
            
            // Do Data chỉ trả về kỳ gần nhất -> Mảng này sẽ có đúng 1 element
            academicResults: (academic || []).map((a: any) => ({
                semester: String(a.semester || ''),
                gpa: a.gpa,
                cpa: a.cpa,
                tpa: a.tpa,
                level: a.warning_level ?? a.warningLevel ?? a.level ?? 0,
            })) as AcademicResult[],
            
            // THÊM Bối cảnh Không gian & Thời gian
            current_time: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
            current_semester: globalSemester.semester,
            current_week: globalSemester.currentWeek,             
            absolute_current_week: globalSemester.absoluteCurrentWeek 
        };

        result.student_context = ctx as StudentContext;
        
        logger.info('student_context loaded successfully', {
            studentId,
            semester: ctx.current_semester,
            week: ctx.current_week
        });

    } catch (e: any) {
        logger.error('Failed to load student context', { error: e.message, studentId });
    }

    return result;
}