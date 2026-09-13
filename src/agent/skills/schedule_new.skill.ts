import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { SkillDefinition } from './registry';
import { StateAnnotation } from '../graph/graph/state';
import { RedisClient } from '../tools/clients/redis.client';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('ScheduleSkill');

export function createScheduleSkill(redis: RedisClient): SkillDefinition {
    return {
        name: 'schedule',
        description: 'Tra cứu lịch học (thời khóa biểu), phòng học, và lịch thi của sinh viên.',

        async run(
            state: typeof StateAnnotation.State,
            config?: LangGraphRunnableConfig,
        ): Promise<Partial<typeof StateAnnotation.State>> {
            const studentId = config?.configurable?.student_id as string;
            if (!studentId) return { skill_results: [] };

            let rawQuery = state.rewritten_query;
            if (!rawQuery) {
                const lastMsg = state.messages?.at(-1);
                rawQuery = typeof lastMsg?.content === 'string' ? lastMsg.content : '';
            }
            const query = String(rawQuery || '').toLowerCase();

            logger.info(`🚨 SCHEDULE EXECUTED | Query: "${query}" | student_id: ${studentId}`);

            try {
                // =========================================================
                // 1. KÉO TOÀN BỘ DỮ LIỆU TỪ CACHE
                // =========================================================
                const [scheduleCache, examsCache] = await Promise.all([
                    redis.get(`hustva:student:${studentId}:schedule_v2`),
                    redis.get(`hustva:student:${studentId}:exams_v2`)
                ]);

                if (!scheduleCache) {
                    return { 
                        skill_results: [{ 
                            skill: 'schedule', 
                            success: false, 
                            error: 'Thời khóa biểu của bạn đang được hệ thống đồng bộ ngầm hoặc chưa có dữ liệu. Vui lòng hỏi lại sau vài giây nhé!' 
                        }] 
                    };
                }

                const scheduleData: any[] = JSON.parse(scheduleCache);
                const examsData: any[] = examsCache ? JSON.parse(examsCache) : [];

                // =========================================================
                // 2. NHẬN DIỆN BỐI CẢNH THỜI GIAN (TARGET SEMESTER)
                // =========================================================
                const normalize = (str: string) => str ? str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim() : '';
                let normQuery = normalize(query);

                // Trích xuất các kỳ học hiện có trong Data, sắp xếp giảm dần (VD: ['20241', '20233', '20232'])
                const allSems = [...new Set([
                    ...scheduleData.map(s => String(s.semester)),
                    ...examsData.map(e => String(e.semester))
                ])].filter(Boolean).sort((a, b) => b.localeCompare(a));

                // Mặc định lấy kỳ hiện tại từ State (Global Context)
                const currentSemester = (state.student_context as any)?.current_semester || allSems[0] || '';
                let targetSemester = currentSemester; 

                // A. Nhận diện mốc thời gian cụ thể (VD: 20241, 2024.1, 2024 1)
                const semMatch = normQuery.match(/\b(20\d{2})[.,\s\-]?([1-3])\b/);
                if (semMatch) {
                    targetSemester = semMatch[1] + semMatch[2];
                } 
                // B. Nhận diện các từ khóa chỉ quá khứ ("kỳ trước", "vừa rồi")
                else if (/(ky|ki|hoc ky|hoc ki)\s*(truoc|vua roi|truoc day|gan nhat|vua xong)/i.test(normQuery)) {
                    // Tìm vị trí của kỳ hiện tại trong mảng. Kỳ trước nó chính là index + 1 (vì mảng sort giảm dần)
                    const currentIndex = allSems.indexOf(currentSemester);
                    if (currentIndex >= 0 && currentIndex + 1 < allSems.length) {
                        targetSemester = allSems[currentIndex + 1];
                    } else {
                        // Fallback tính toán tay nếu mảng bị thiếu: 20241 -> 20233, 20232 -> 20231
                        let y = parseInt(currentSemester.substring(0, 4));
                        let s = parseInt(currentSemester.substring(4));
                        if (s === 1) { y--; s = 3; } else { s--; }
                        targetSemester = `${y}${s}`;
                    }
                }

                logger.info(`Schedule Target Semester: ${targetSemester} (Current: ${currentSemester})`);

                // =========================================================
                // 3. LỌC DỮ LIỆU ĐÚNG VỚI KỲ HỌC ĐÃ CHỌN
                // =========================================================
                const filteredSchedule = scheduleData.filter(item => String(item.semester) === targetSemester);
                const filteredExams = examsData.filter(item => String(item.semester) === targetSemester);

                if (filteredSchedule.length === 0 && filteredExams.length === 0) {
                    return {
                        skill_results: [{
                            skill: 'schedule',
                            success: false,
                            error: `Không tìm thấy dữ liệu lịch học hoặc lịch thi cho học kỳ ${targetSemester}.`,
                            llm_instruction: `Hãy báo cho sinh viên biết hệ thống không tìm thấy lịch học/lịch thi của học kỳ ${targetSemester}. Dừng lại và KHÔNG ĐƯỢC BỊA THÔNG TIN.`
                        }]
                    };
                }

                const data = {
                    target_semester: targetSemester,
                    schedule: filteredSchedule,
                    exams: filteredExams
                };
                
                // =========================================================
                // 4. XÂY DỰNG LLM INSTRUCTION (CHỐNG ẢO GIÁC)
                // =========================================================
                const llm_instruction = `
ĐÂY LÀ DỮ LIỆU LỊCH HỌC VÀ LỊCH THI CỦA SINH VIÊN TRONG HỌC KỲ ${targetSemester}. BẠN BẮT BUỘC TUÂN THỦ CÁC QUY TẮC SAU:

1. ĐỐI CHIẾU THỜI GIAN: 
- Nếu sinh viên hỏi "Hôm nay", "Ngày mai", "Tuần này": Hãy kiểm tra xem biến 'current_semester' có trùng với '${targetSemester}' không. Nếu trùng, dùng 'current_hust_week' (Tuần học hiện tại) để đối chiếu với 'place_time_info'.
- Môn học thường quy định học vào "Thứ X", "Tiết Y-Z", tại "Phòng ABC", trong các "Tuần a-b". Chỉ liệt kê ra nếu 'current_hust_week' nằm trong khoảng "Tuần a-b".

2. MÔN ĐẶC THÙ: 
- Các môn có tên chứa "Đồ án", "Thực tập", "Thực hành" thường không có lịch cố định. Hãy nhắc sinh viên chủ động liên hệ Giảng viên.

3. LỊCH THI ('exams'):
- Nếu mảng 'exams' trống ([]): Hãy trả lời "Hiện tại chưa có dữ liệu lịch thi cho học kỳ ${targetSemester}."
- Nếu có dữ liệu: BẮT BUỘC trình bày danh sách lịch thi dưới dạng Bảng Markdown (gồm cột: Mã học phần, Tên học phần, Thời gian thi, Phòng thi, Nhóm/Ca thi).

4. TUYỆT ĐỐI KHÔNG BỊA DỮ LIỆU. Chỉ cung cấp thông tin nằm trong JSON.
`;

                logger.info(`✅ Lọc thành công Schedule (${filteredSchedule.length} lớp) và Exams (${filteredExams.length} môn) cho kỳ ${targetSemester}`);

                return {
                    skill_results: [{ 
                        skill: 'schedule', 
                        success: true, 
                        data: data,
                        llm_instruction: llm_instruction
                    }],
                };

            } catch (error: any) {
                logger.error(`❌ Schedule Error | ${studentId}`, { error: error.message });
                return { 
                    skill_results: [{ 
                        skill: 'schedule', 
                        success: false, 
                        error: 'Lỗi hệ thống khi truy xuất thời khóa biểu.' 
                    }] 
                };
            }
        },
    };
}