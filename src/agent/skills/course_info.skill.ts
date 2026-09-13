import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { SkillDefinition } from './registry';
import { StateAnnotation } from '../graph/graph/state';
import { RedisClient } from '../tools/clients/redis.client';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('CourseInfoSkill');

export function createCourseInfoSkill(redis: RedisClient): SkillDefinition {
    return {
        name: 'course_info',
        description: 'Tra cứu thông tin chi tiết (tín chỉ, trọng số, tài liệu, đề cương, slide, giảng viên) của các môn học NẰM TRONG CHƯƠNG TRÌNH ĐÀO TẠO của sinh viên.',

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

            logger.info(`🚨 COURSE INFO EXECUTED | Query: "${query}"`);

            try {
                // =========================================================
                // 1. LẤY KHUNG CTĐT CÁ NHÂN VÀ LỌC MODULE
                // =========================================================
                const infoCache = await redis.get(`hustva:student:${studentId}:info`);
                if (!infoCache) {
                    return { skill_results: [{ skill: 'course_info', success: false, error: 'Không tìm thấy thông tin hồ sơ sinh viên.' }] };
                }
                
                const programId = JSON.parse(infoCache).program_id;
                if (!programId) {
                    return { skill_results: [{ skill: 'course_info', success: false, error: 'Sinh viên chưa được phân bổ vào chương trình đào tạo nào.' }] };
                }

                const progCache = await redis.get(`hustva:program:${programId}`);
                if (!progCache) {
                    return { skill_results: [{ skill: 'course_info', success: false, error: 'Hệ thống chưa đồng bộ Khung chương trình đào tạo của ngành bạn.' }] };
                }

                const programSkeleton = JSON.parse(progCache);
                const programCoursesRaw: any[] = programSkeleton.courses || [];
                
                // Lọc bỏ các phần tử là Tên Module (optional === -1)
                const programCourses = programCoursesRaw.filter(c => c.optional !== -1);

                // =========================================================
                // 2. HYDRATE: KÉO DỮ LIỆU GLOBAL CHO DANH SÁCH MÔN HỌC
                // =========================================================
                const detailPromises = programCourses.map(c => redis.get(`hustva:course:${c.course_id}`));
                const detailsRaw = await Promise.all(detailPromises);

                const encodeUrlArraySpaces = (urls: string[] | undefined) => {
                    if (!urls || !Array.isArray(urls)) return [];
                    return urls.map(url => url.replace(/ /g, '%20'));
                };

                // Helper 1: Sinh tập hợp tất cả các mã môn trong CTĐT của sinh viên này
                const validCourseIdsInProgram = new Set(programCourses.map(c => c.course_id.toLowerCase()));

                // Tạo từ điển tra cứu Tên môn nhanh
                const courseNameMap = new Map<string, string>();
                programCourses.forEach((pc, index) => {
                    let globalInfo: any = {};
                    if (detailsRaw[index]) {
                        globalInfo = JSON.parse(detailsRaw[index]!);
                    }
                    const bestName = globalInfo.course_name_vn || pc.course_name;
                    courseNameMap.set(pc.course_id.toLowerCase(), bestName);
                });

                // 🔥 THUẬT TOÁN MỚI: TỰ ĐỘNG CẮT TỈA CHUỖI LOGIC ĐIỀU KIỆN 🔥
                const parseConditionLogic = (conditionStr: string | undefined) => {
                    if (!conditionStr || conditionStr.trim() === '') return null;

                    let cleanStr = conditionStr;
                    const regex = /([a-zA-Z]+\d+[a-zA-Z]*)([!=]?)/g;
                    const courseDetails = new Map<string, string>();

                    // Bước 1: Xóa các mã môn không có trong ngành học
                    cleanStr = cleanStr.replace(regex, (match, cid, symbol) => {
                        const lowerCid = cid.toLowerCase();
                        if (validCourseIdsInProgram.has(lowerCid)) {
                            const name = courseNameMap.get(lowerCid) || 'Chưa rõ tên môn';
                            let type = 'Học trước (Chỉ cần học xong)';
                            if (symbol === '!') type = 'Tiên quyết (Phải đạt)';
                            if (symbol === '=') type = 'Song hành (Có thể học cùng lúc)';

                            courseDetails.set(lowerCid, `${lowerCid.toUpperCase()} - ${name} [${type}]`);
                            return match; // Giữ lại môn này
                        }
                        return ""; // Môn ngoại lai -> Thay bằng rỗng
                    });

                    // Bước 2: Vòng lặp dọn dẹp các ký tự thừa để lại sau khi xóa môn
                    let prevStr = "";
                    while (cleanStr !== prevStr) {
                        prevStr = cleanStr;
                        cleanStr = cleanStr.replace(/,\s*,/g, ','); // Chống 2 dấu phẩy ,, -> ,
                        cleanStr = cleanStr.replace(/\/\s*\//g, '/'); // Chống 2 dấu // -> /
                        cleanStr = cleanStr.replace(/\(\s*,/g, '('); // Chống (, -> (
                        cleanStr = cleanStr.replace(/,\s*\)/g, ')'); // Chống ,) -> )
                        cleanStr = cleanStr.replace(/\(\s*\//g, '('); // Chống (/ -> (
                        cleanStr = cleanStr.replace(/\/\s*\)/g, ')'); // Chống /) -> )
                        cleanStr = cleanStr.replace(/\(\s*\)/g, '');  // Chống ngoặc rỗng () -> Xóa
                        cleanStr = cleanStr.replace(/^[,/]+|[,/]+$/g, ''); // Xóa , hoặc / ở 2 đầu chuỗi
                    }

                    if (cleanStr.trim() === '') return null; // Nếu cắt xong mà rỗng hết thì trả về null

                    return {
                        logic_string: cleanStr,
                        course_details: Array.from(courseDetails.values())
                    };
                };

                // Hợp nhất dữ liệu: Local (CTĐT) + Global (Từ điển)
                const unifiedCourses = programCourses.map((pc, index) => {
                    let globalInfo: any = {};
                    if (detailsRaw[index]) {
                        globalInfo = JSON.parse(detailsRaw[index]!);
                    }
                    
                    // Phân tích và cắt tỉa chuỗi tổng hợp từ trường prerequisite
                    const courseConditions = parseConditionLogic(globalInfo.prerequisite);

                    return {
                        course_id: pc.course_id,
                        course_name_vn: globalInfo.course_name_vn || pc.course_name,
                        course_name_en: globalInfo.course_name_en || '',
                        abbrs: globalInfo.abbrs || [],
                        credit: pc.credit || globalInfo.credit,
                        semester: pc.semester,
                        optional: pc.optional,             
                        exam_weight: pc.exam_weight,       
                        module_name: pc.module_name,       
                        link_slide_urls: encodeUrlArraySpaces(globalInfo.link_slide_urls),
                        outline_urls: encodeUrlArraySpaces(globalInfo.outline_urls),
                        practice_urls: encodeUrlArraySpaces(globalInfo.practice_urls),
                        description: globalInfo.description || '',
                        staff_names: globalInfo.staff_names || '',
                        
                        // Đưa khối điều kiện SẠCH vào
                        conditions: courseConditions
                    };
                });

                const normalize = (str: string) => str ? str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim() : '';
                
                const replaceRoman = (str: string) => str.replace(/\b(i{1,3}|iv|v)\b/g, match => {
                    if (match === 'iv') return '4';
                    if (match === 'v') return '5';
                    return String(match.length);
                });
                
                let normQuery = replaceRoman(normalize(query));
                const queryNoSpace = normQuery.replace(/\s+/g, '');
                
                const queryWordsRaw = normQuery.split(/\s+/).filter(w => w.length > 0);
                const queryGeneratedAbbr = queryWordsRaw.map(w => w.charAt(0)).join('');
                const cleanQueryWords = normQuery.replace(/\b(va|cho|cua|diem|nhieu|la|gi|hay|mot|cach|sao|ck|gk|qt|tk)\b/g, '').trim().split(/\s+/).filter(w => w.length > 1);

                // Trích xuất mã môn chuẩn xác
                let queryExtractedCid: string | null = null;
                for (const course of unifiedCourses) {
                    const lowerCid = course.course_id.toLowerCase();
                    const match = lowerCid.match(/^([a-z]+)(\d+)([a-z]*)$/);
                    if (match) {
                        const exactCidRegex = new RegExp(`\\b${match[1]}\\s*${match[2]}\\s*${match[3]}\\b`, 'i');
                        if (exactCidRegex.test(normQuery)) {
                            queryExtractedCid = lowerCid;
                            break; 
                        }
                    }
                }

                let scoredCourses = unifiedCourses.map((course: any) => {
                    let score = 0;
                    const normNameVn = replaceRoman(normalize(course.course_name_vn));
                    const normNameEn = replaceRoman(normalize(course.course_name_en));
                    const nameVnNoSpace = normNameVn.replace(/\s+/g, '');
                    const nameEnNoSpace = normNameEn.replace(/\s+/g, '');
                    const cid = course.course_id.toLowerCase();

                    // --- ƯU TIÊN 1 (100đ): Khớp mã môn ---
                    if (queryExtractedCid === cid) {
                        score += 100;
                    }
                    // --- ƯU TIÊN 2 (90đ): Khớp hoàn toàn tên ---
                    else if (normQuery.includes(normNameVn) || (normNameEn && normQuery.includes(normNameEn))) {
                        score += 90;
                    }

                    // --- ƯU TIÊN 3 (Tối đa 85đ): TỪ VIẾT TẮT ---
                    const abbrs = course.abbrs || [];
                    let maxAbbrScore = 0;

                    for (const abbr of abbrs) {
                        for (const word of queryWordsRaw) {
                            if (word.length >= 2 && abbr.includes(word)) {
                                const ratio = word.length / abbr.length;
                                const tempScore = 60 + (ratio * 25);
                                if (tempScore > maxAbbrScore) maxAbbrScore = tempScore;
                            }
                        }

                        if (queryGeneratedAbbr.length >= 2 && abbr.includes(queryGeneratedAbbr)) {
                            const ratio = queryGeneratedAbbr.length / abbr.length;
                            const tempScore = 60 + (ratio * 25);
                            if (tempScore > maxAbbrScore) maxAbbrScore = tempScore;
                        }
                    }
                    
                    if (maxAbbrScore > score) score = maxAbbrScore;

                    // --- ƯU TIÊN 4 (75đ): Viết liền không dấu cách ---
                    if (score < 80) { 
                        if ((nameVnNoSpace.length > 5 && queryNoSpace.includes(nameVnNoSpace)) || 
                            (nameEnNoSpace.length > 5 && queryNoSpace.includes(nameEnNoSpace))) {
                            score = Math.max(score, 75);
                        }
                    }

                    // --- ƯU TIÊN 5 (Max 60đ): Sai chính tả / Fuzzy Overlap ---
                    if (score < 75 && cleanQueryWords.length > 0) {
                        let matchCount = 0;
                        cleanQueryWords.forEach(qw => {
                            if (normNameVn.includes(qw) || normNameEn.includes(qw)) matchCount++;
                        });
                        const overlapRatio = matchCount / cleanQueryWords.length;
                        if (overlapRatio >= 0.4) {
                            score = Math.max(score, Math.floor(overlapRatio * 60));
                        }
                    }

                    return { ...course, _score: score };
                });

                scoredCourses = scoredCourses.filter(c => c._score >= 30).sort((a, b) => b._score - a._score);

                if (scoredCourses.length === 0) {
                    return {
                        skill_results: [{
                            skill: 'course_info',
                            success: false,
                            error: 'Không tìm thấy thông tin môn học.',
                            llm_instruction: 'HỆ THỐNG KHÔNG TÌM THẤY MÔN HỌC TRONG CHƯƠNG TRÌNH ĐÀO TẠO CỦA SINH VIÊN. Hãy nhắc nhở sinh viên rằng môn học này không nằm trong ngành học của họ, hoặc họ đang gõ sai tên. Gợi ý sinh viên cung cấp Mã môn chuẩn (VD: IT3100). NGHIÊM CẤM BỊA THÔNG TIN MÔN HỌC.'
                        }]
                    };
                }

                // =========================================================
                // 4. DYNAMIC TOP-K
                // =========================================================
                const highestScore = scoredCourses[0]._score;
                const topK = highestScore >= 80 ? 2 : 5;
                const topResults = scoredCourses.slice(0, topK).map(({ _score, ...rest }) => rest);

                // =========================================================
                // 5. LLM INSTRUCTION CHUYÊN BIỆT
                // =========================================================
                const searchStatusContext = highestScore >= 80 
                    ? (topResults.length >= 2 && scoredCourses[1]._score >= 80 
                        ? "Hệ thống tìm thấy 2 môn học khớp hoàn toàn. Hãy hỏi sinh viên xem họ muốn xem thông tin chi tiết môn nào." 
                        : "Dưới đây là thông tin chi tiết của môn học sinh viên yêu cầu.")
                    : "Hệ thống không tìm thấy môn học nào khớp 100%, dưới đây là các môn gần giống. Hãy hỏi sinh viên xem họ đang tìm môn nào trong số này.";

                const dictionaryInstruction = `
HƯỚNG DẪN GIẢI THÍCH THUẬT NGỮ (Chỉ giải thích nếu cần, không nói dông dài):
- 'optional': Nếu bằng 1, là môn TỰ CHỌN. Nếu bằng 0, là môn BẮT BUỘC.
- 'exam_weight': Trọng số điểm Cuối kỳ. VD: 0.7 nghĩa là Thi CK chiếm 70%, Quá trình 30%.
- 'semester': Học kỳ ĐỀ XUẤT trong lộ trình. (Nếu là -1, đây là Giáo dục thể chất, có thể học kỳ nào cũng được).
- Điều kiện đăng ký môn học (nếu có) sẽ nằm trong trường 'conditions':
   + 'logic_string': Chuỗi công thức điều kiện (Dấu "," là VÀ, Dấu "/" là HOẶC. Các ký tự đi kèm mã môn: "!" là Tiên quyết, "=" là Song hành, rỗng là Học trước).
   + 'course_details': Danh sách giải nghĩa Tên môn và Loại điều kiện của các mã môn có trong chuỗi trên.
   -> BẠN BẮT BUỘC phải show nguyên văn chuỗi 'logic_string' (hiểu là "Học phần điều kiện") ra trước, sau đó dựa vào 'course_details' để giải thích chi tiết cho sinh viên dễ hiểu (đặc biệt lưu ý giải thích rõ ngoặc hoặc dấu / nghĩa là chỉ cần chọn 1 trong các môn).
- Các đường link 'link_slide_urls', 'outline_urls', 'practice_urls': Cung cấp dạng danh sách Markdown sạch sẽ nếu có tài liệu.
**NGHIÊM CẤM: BỊA THÔNG TIN MÔN HỌC. NGOÀI RA CÁC BIẾN TRUYỀN VÀO PROMPT (Ví dụ logic_string) CHỈ VỚI MỤC ĐÍCH CUNG CẤP THÔNG TIN CHO LLM, CẦN THAY ĐỔI CÁCH VIẾT ĐỂ TRÁNH LỘ DỮ LIỆU. 
`;

                logger.info(`✅ CourseInfo tìm thấy ${topResults.length} môn. Highest Score: ${highestScore}.`);

                return {
                    skill_results: [{ 
                        skill: 'course_info', 
                        success: true, 
                        data: { matched_courses: topResults },
                        llm_instruction: searchStatusContext + "\n" + dictionaryInstruction + "KHÔNG ĐƯỢC BỊA THÔNG TIN MÔN HỌC. PHẢI DỰA TRÊN DỮ LIỆU CÓ SẴN. Nếu không chắc chắn, hãy hỏi lại sinh viên để lấy thêm thông tin thay vì đoán mò."
                    }],
                };

            } catch (error: any) {
                logger.error(`❌ CourseInfo Error`, { error: error.message });
                return { skill_results: [{ skill: 'course_info', success: false, error: 'Lỗi hệ thống khi tra cứu thông tin môn học.' }] };
            }
        },
    };
}