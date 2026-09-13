import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { SkillDefinition } from './registry';
import { StateAnnotation } from '../graph/graph/state';
import { RedisClient } from '../tools/clients/redis.client';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('ProgramSkill');

export function createProgramSkill(redis: RedisClient): SkillDefinition {
    return {
        name: 'program',
        description: 'Tư vấn đăng ký môn học, kiểm tra tiến độ chương trình đào tạo, thống kê nợ môn, phân tích môn cần cải thiện để nâng hạng bằng.',

        async run(
            state: typeof StateAnnotation.State,
            config?: LangGraphRunnableConfig,
        ): Promise<Partial<typeof StateAnnotation.State>> {
            const studentId = config?.configurable?.student_id as string;
            
            if (!studentId) return { skill_results: [] };

            logger.info(`🚨 PROGRAM SKILL EXECUTED | student_id: ${studentId}`);

            try {
                // =========================================================
                // 1. FETCH DỮ LIỆU TỪ REDIS
                // =========================================================
                const [infoCache, transcriptCache, scheduleCache, academicCache] = await Promise.all([
                    redis.get(`hustva:student:${studentId}:info`),
                    redis.get(`hustva:student:${studentId}:transcript`),
                    redis.get(`hustva:student:${studentId}:schedule_v2`) || redis.get(`hustva:student:${studentId}:schedule`),
                    redis.get(`hustva:student:${studentId}:academic_results`)
                ]);

                if (!infoCache || !transcriptCache) {
                    return { skill_results: [{ skill: 'program', success: false, error: 'Dữ liệu Bảng điểm hoặc Hồ sơ chưa sẵn sàng. Vui lòng chờ đồng bộ.' }] };
                }

                const studentInfo = JSON.parse(infoCache);
                const programId = studentInfo.program_id;
                const studentYear = parseInt(studentInfo.student_year) || 1; 

                const progCache = await redis.get(`hustva:program:${programId}`);
                if (!progCache) {
                    return { skill_results: [{ skill: 'program', success: false, error: 'Chưa có dữ liệu Khung CTĐT của ngành này.' }] };
                }

                const programData = JSON.parse(progCache);
                const programCourses: any[] = programData.courses || [];
                const transcriptData: any[] = JSON.parse(transcriptCache);
                const scheduleData: any[] = scheduleCache ? JSON.parse(scheduleCache) : [];
                
                let latestAcademic: any = null;
                if (academicCache) {
                    const allAca = JSON.parse(academicCache);
                    if (Array.isArray(allAca) && allAca.length > 0) {
                        allAca.sort((a, b) => String(b.semester).localeCompare(String(a.semester)));
                        latestAcademic = allAca[0];
                    }
                }

                // =========================================================
                // 1.5. LẤY TỪ ĐIỂN MÔN HỌC
                // =========================================================
                const detailPromises = programCourses.map(c => redis.get(`hustva:course:${c.course_id}`));
                const detailsRaw = await Promise.all(detailPromises);

                const globalCourseMap = new Map<string, any>();
                detailsRaw.forEach((raw, index) => {
                    if (raw) {
                        globalCourseMap.set(programCourses[index].course_id.toLowerCase(), JSON.parse(raw));
                    }
                });

                // =========================================================
                // 2. MAP DỮ LIỆU ĐỂ ĐÁNH GIÁ TRẠNG THÁI
                // =========================================================
                const gradeToPoint: Record<string, number> = {
                    'A+': 4.0, 'A': 4.0, 'B+': 3.5, 'B': 3.0, 'C+': 2.5, 'C': 2.0, 'D+': 1.5, 'D': 1.0, 'F': 0.0
                };

                const transcriptMap = new Map<string, string>();
                transcriptData.forEach(t => transcriptMap.set(t.course_id.toLowerCase(), t.mark_char));

                const scheduleSet = new Set<string>();
                scheduleData.forEach(s => scheduleSet.add(s.course_id.toLowerCase()));

                const validCourseIdsInProgram = new Set<string>();
                const courseNameMap = new Map<string, string>();
                
                programCourses.forEach(c => {
                    const cid = c.course_id.toLowerCase();
                    validCourseIdsInProgram.add(cid);
                    courseNameMap.set(cid, c.course_name);
                });

                // 🔥 Tối ưu Helper Đánh giá trạng thái (PASSED > STUDYING > FAILED > PENDING)
                const getCourseStatus = (cid: string) => {
                    if (transcriptMap.has(cid) && transcriptMap.get(cid) !== 'F') return 'PASSED';
                    if (scheduleSet.has(cid)) return 'STUDYING';
                    if (transcriptMap.has(cid) && transcriptMap.get(cid) === 'F') return 'FAILED';
                    return 'PENDING';
                };

                // 🔥 THUẬT TOÁN ĐÁNH GIÁ ĐIỀU KIỆN (TIÊN QUYẾT / SONG HÀNH / HỌC TRƯỚC) 🔥
                const checkPrerequisites = (prereqStr: string) => {
                    if (!prereqStr || prereqStr.trim() === '') {
                        return { is_eligible: true, missing_prereqs: [], studying_prereqs: [] };
                    }

                    const cleanStr = prereqStr.replace(/[()\s]/g, ''); // Lưu ý: KHÔNG replace ! và =
                    const andGroups = cleanStr.split(','); 
                    
                    const missingPrereqs: string[] = [];
                    const studyingPrereqs: string[] = [];
                    let is_eligible = true;

                    for (const group of andGroups) {
                        if (!group) continue;
                        const orItemsRaw = group.split('/'); 
                        
                        // Bóc mã môn và ký hiệu ra riêng
                        const orItems = orItemsRaw.map(rawItem => {
                            const match = rawItem.match(/^([a-zA-Z]+\d+[a-zA-Z]*)([!=]?)$/);
                            if (match) {
                                return { cid: match[1].toLowerCase(), symbol: match[2] };
                            }
                            return null;
                        }).filter(item => item !== null) as {cid: string, symbol: string}[];

                        const validOrItems = orItems.filter(item => validCourseIdsInProgram.has(item.cid));
                        const itemsToEval = validOrItems.length > 0 ? validOrItems : orItems;
                        
                        let groupPassed = false;
                        let groupStudying = false;
                        const studyingItemsInGroup: string[] = [];

                        for (const item of itemsToEval) {
                            const status = getCourseStatus(item.cid);
                            const sym = item.symbol;
                            
                            let itemSatisfied = false;
                            let itemTentative = false;

                            if (sym === '!') {
                                // Tiên quyết: Chỉ chấp nhận PASSED. Đang học thì cho nợ (Tentative).
                                if (status === 'PASSED') itemSatisfied = true;
                                else if (status === 'STUDYING') itemTentative = true;
                            } else if (sym === '=') {
                                // Song hành: PASSED, FAILED (đã học), STUDYING đều được tính là thỏa mãn
                                if (status === 'PASSED' || status === 'FAILED' || status === 'STUDYING') itemSatisfied = true;
                            } else {
                                // Học trước: PASSED, FAILED (đã học xong dẫu trượt), STUDYING đều được
                                if (status === 'PASSED' || status === 'FAILED' || status === 'STUDYING') itemSatisfied = true;
                            }

                            if (itemSatisfied) {
                                groupPassed = true;
                                break;
                            } else if (itemTentative) {
                                groupStudying = true;
                                const name = courseNameMap.get(item.cid) || '';
                                studyingItemsInGroup.push(`${item.cid.toUpperCase()} - ${name} [Tiên quyết]`);
                            }
                        }

                        if (groupPassed) {
                            // Cụm OR này đã đạt
                        } else if (groupStudying) {
                            studyingPrereqs.push(studyingItemsInGroup.join(' HOẶC '));
                        } else {
                            // Cụm OR này RỚT -> Đánh rớt môn
                            is_eligible = false;
                            const formatted = itemsToEval.map(item => {
                                const name = courseNameMap.get(item.cid) || '';
                                let typeStr = 'Học trước';
                                if (item.symbol === '!') typeStr = 'Tiên quyết';
                                if (item.symbol === '=') typeStr = 'Song hành';
                                return `${item.cid.toUpperCase()} - ${name} [${typeStr}]`;
                            }).join(' HOẶC ');
                            missingPrereqs.push(formatted);
                        }
                    }

                    return { is_eligible, missing_prereqs: missingPrereqs, studying_prereqs: studyingPrereqs };
                };

                // =========================================================
                // 3. ĐÁNH GIÁ ĐIỀU KIỆN TỪNG MÔN
                // =========================================================
                const processedCourses = programCourses
                    .filter(c => c.optional !== -1)
                    .map(c => {
                        const cid = c.course_id.toLowerCase();
                        const status = getCourseStatus(cid);
                        const grade = status === 'PASSED' || status === 'FAILED' ? transcriptMap.get(cid) || null : null;

                        const is_odd = c.semester % 2 !== 0;
                        const term_type = (c.semester && c.semester !== 99) ? (is_odd ? 'LẺ' : 'CHẴN') : 'ALL';
                        const is_summer_eligible = cid.startsWith('mi') || cid.startsWith('pe') || cid.startsWith('ssh');

                        const globalInfo = globalCourseMap.get(cid) || {};
                        const prereqCheck = checkPrerequisites(globalInfo.prerequisite || '');

                        return {
                            course_id: c.course_id,
                            course_name: c.course_name,
                            credit: c.credit || 0,
                            semester: c.semester || 99,
                            term_type: term_type, 
                            is_summer_eligible: is_summer_eligible, 
                            optional: c.optional,
                            module_name: c.module_name,
                            status: status,
                            grade: grade,
                            is_eligible: status === 'FAILED' ? true : prereqCheck.is_eligible,
                            missing_prereqs: prereqCheck.missing_prereqs,
                            studying_prereqs: prereqCheck.studying_prereqs
                        };
                    });

                // TẠO DANH SÁCH TỔNG HỢP MÔN ĐÃ HỌC VÀ ĐANG HỌC
                const courses_studying = processedCourses
                    .filter(c => c.status === 'STUDYING')
                    .map(c => ({ course_id: c.course_id, course_name: c.course_name, credit: c.credit }));

                const courses_passed = processedCourses
                    .filter(c => c.status === 'PASSED')
                    .map(c => ({ course_id: c.course_id, course_name: c.course_name, credit: c.credit, grade: c.grade }));

                // =========================================================
                // 3.5. BỘ LỌC CHỐNG ẢO GIÁC ĐẾM SỐ (ANTI-HALLUCINATION)
                // =========================================================
                const pePassedCount = processedCourses.filter(c => c.course_id.toLowerCase().startsWith('pe') && (c.status === 'PASSED' || c.status === 'STUDYING')).length;
                const peCompleted = pePassedCount >= 5;

                const moduleMap = new Map<string, { required_courses: number, passed_courses: number, is_completed: boolean, progress_status: string }>();
                
                processedCourses.forEach(c => {
                    const cidLower = c.course_id.toLowerCase();
                    if (cidLower.startsWith('pe') || cidLower.startsWith('ssh') || cidLower.startsWith('mil')) return;

                    if (c.optional === 1 && c.module_name) {
                        const mName = c.module_name;
                        if (!moduleMap.has(mName)) {
                            moduleMap.set(mName, { required_courses: 0, passed_courses: 0, is_completed: false, progress_status: '' });
                        }
                        const mData = moduleMap.get(mName)!;
                        mData.required_courses++; 
                        if (c.status === 'PASSED' || c.status === 'STUDYING') mData.passed_courses++;
                    }
                });

                moduleMap.forEach((data, name) => {
                    const isBoTro = name.toLowerCase().includes('bổ trợ') || name.toLowerCase().includes('tự do');
                    
                    if (isBoTro) {
                        data.required_courses = 3; 
                        if (data.passed_courses >= 3) data.is_completed = true;
                    } else if (data.passed_courses >= data.required_courses && data.required_courses > 0) {
                        data.is_completed = true;
                    }

                    data.progress_status = data.is_completed 
                        ? `Đã hoàn thành yêu cầu` 
                        : `Chưa hoàn thành (Đã đạt ${data.passed_courses}/${data.required_courses} môn)`;
                });

                const filteredCourses = processedCourses.filter(c => {
                    if (c.status !== 'PENDING') return true; 

                    const cid = c.course_id.toLowerCase();
                    if (cid.startsWith('pe') || cid.startsWith('ssh') || cid.startsWith('mil')) return false;

                    if (c.optional === 1 && c.module_name) {
                        const mData = moduleMap.get(c.module_name);
                        if (mData && mData.is_completed) return false;
                    }

                    return true;
                });

                // =========================================================
                // 4. BUCKETING BẰNG DỮ LIỆU ĐÃ LỌC SẠCH
                // =========================================================
                const mustRetakeCourses = filteredCourses.filter(c => 
                    c.status === 'FAILED' && 
                    (c.optional === 0 || (c.optional === 1 && c.credit > 0))
                ).map(({ course_id, course_name, credit, term_type, is_summer_eligible }) => 
                    ({ course_id, course_name, credit, term_type, is_summer_eligible })
                );

                const improvementCandidates = filteredCourses
                    .filter(c => c.status === 'PASSED' && c.credit > 0 && c.grade && gradeToPoint[c.grade] !== undefined)
                    .map(c => {
                        const point = gradeToPoint[c.grade as string];
                        const potentialGain = (4.0 - point) * c.credit;
                        return { ...c, potential_gain: potentialGain };
                    })
                    .filter(c => c.potential_gain > 0)
                    .sort((a, b) => b.potential_gain - a.potential_gain)
                    .map(({ course_id, course_name, credit, grade, potential_gain, term_type, is_summer_eligible }) => 
                        ({ course_id, course_name, credit, grade, potential_gain, term_type, is_summer_eligible })
                    );

                const peCourses = processedCourses.filter(c => c.course_id.toLowerCase().startsWith('pe'));
                const sshCourses = processedCourses.filter(c => c.course_id.toLowerCase().startsWith('ssh'));

                const peProgress = {
                    progress_status: peCompleted ? "Đã hoàn thành yêu cầu (Đạt 5/5 học phần)" : `Chưa hoàn thành (Mới đạt ${pePassedCount}/5 học phần)`,
                    is_completed: peCompleted,
                    passed_or_studying_list: peCourses.filter(c => c.status === 'PASSED' || c.status === 'STUDYING').map(c => ({ id: c.course_id, name: c.course_name, status: c.status, grade: c.grade })),
                    pending_list: peCompleted ? [] : peCourses.filter(c => c.status === 'PENDING').slice(0, 3).map(c => ({
                        id: c.course_id, name: c.course_name, is_eligible: c.is_eligible, missing_prereqs: c.missing_prereqs, studying_prereqs: c.studying_prereqs
                    })) 
                };
                
                const sshProgress = {
                    progress_status: `Đã hoàn thành ${sshCourses.filter(c => c.status === 'PASSED' || c.status === 'STUDYING').length}/${sshCourses.length} học phần`,
                    passed_or_studying_list: sshCourses.filter(c => c.status === 'PASSED' || c.status === 'STUDYING').map(c => ({ id: c.course_id, name: c.course_name, status: c.status, grade: c.grade })),
                    pending_list: sshCourses.filter(c => c.status === 'PENDING').map(c => ({ 
                        id: c.course_id, name: c.course_name, is_eligible: c.is_eligible, missing_prereqs: c.missing_prereqs, studying_prereqs: c.studying_prereqs
                    }))
                };

                const corePending = filteredCourses
                    .filter(c => c.status === 'PENDING' && c.optional === 0)
                    .sort((a, b) => a.semester - b.semester) 
                    .slice(0, 15) 
                    .map(({ course_id, course_name, credit, semester, term_type, is_summer_eligible, is_eligible, missing_prereqs, studying_prereqs }) => 
                        ({ course_id, course_name, credit, semester, term_type, is_summer_eligible, is_eligible, missing_prereqs, studying_prereqs })
                    );

                const activeModules = new Set(
                    filteredCourses
                        .filter(c => c.optional === 1 && c.credit > 0 && (c.status === 'PASSED' || c.status === 'STUDYING'))
                        .map(c => c.module_name)
                        .filter(m => m)
                );

                const modulePending = filteredCourses
                    .filter(c => c.status === 'PENDING' && c.optional === 1 && c.module_name && activeModules.has(c.module_name))
                    .map(({ course_id, course_name, credit, module_name, term_type, is_summer_eligible, is_eligible, missing_prereqs, studying_prereqs }) => 
                        ({ course_id, course_name, credit, module_name, term_type, is_summer_eligible, is_eligible, missing_prereqs, studying_prereqs })
                    );

                const coreCourses = filteredCourses.filter(c => c.optional === 0);

                const curriculumOverview = {
                    core_progress: {
                        total_courses: coreCourses.length,
                        passed_courses: coreCourses.filter(c => c.status === 'PASSED').length,
                    },
                    modules_summary: [] as any[]
                };

                moduleMap.forEach((data, name) => {
                    const passedOrStudying = processedCourses
                        .filter(c => c.module_name === name && (c.status === 'PASSED' || c.status === 'STUDYING'))
                        .map(c => ({ id: c.course_id, name: c.course_name, status: c.status, grade: c.grade }));

                    curriculumOverview.modules_summary.push({
                        module_name: name,
                        progress_status: data.progress_status,
                        is_completed: data.is_completed,
                        passed_or_studying_list: passedOrStudying
                    });
                });

                const detailedModuleMap = new Map<string, Array<{id: string, name: string}>>();
                filteredCourses.forEach(c => {
                    const mName = c.module_name || (c.optional === 0 ? 'Khối kiến thức bắt buộc' : 'Khối kiến thức khác');
                    if (!detailedModuleMap.has(mName)) {
                        detailedModuleMap.set(mName, []);
                    }
                    detailedModuleMap.get(mName)!.push({ id: c.course_id, name: c.course_name });
                });

                const curriculumDetailsFiltered: Record<string, string[]> = {};
                detailedModuleMap.forEach((courses, mName) => {
                    if (mName.toLowerCase().includes('bổ trợ')) return; 
                    curriculumDetailsFiltered[mName] = courses.map(c => `${c.id} - ${c.name}`);
                });

                // =========================================================
                // 5. ĐÓNG GÓI DỮ LIỆU & LLM INSTRUCTION
                // =========================================================
                const finalData = {
                    student_year: studentYear, 
                    academic_progress: {
                        cpa: latestAcademic?.cpa,
                        gpa_latest: latestAcademic?.gpa,
                        cumulate_credit: latestAcademic?.cumulate_credit,
                        warning_level: latestAcademic?.warning_level
                    },
                    curriculum_overview: curriculumOverview, 
                    curriculum_details: curriculumDetailsFiltered,
                    courses_passed: courses_passed,
                    courses_studying: courses_studying,
                    courses_failed_must_retake: mustRetakeCourses,
                    improvement_candidates: improvementCandidates.slice(0, 15),
                    common_courses: { physical_education: peProgress, philosophy_politics: sshProgress },
                    core_pending: corePending,
                    active_modules_pending: modulePending
                };

                const llmInstruction = `
BẠN LÀ CỐ VẤN HỌC TẬP (ACADEMIC ADVISOR) TẠI ĐHBK HÀ NỘI. Sinh viên đang học NĂM THỨ ${studentYear}.

[QUY TẮC CỐT LÕI - TUYỆT ĐỐI TUÂN THỦ]:
1. KHÔNG BAO GIỜ tiết lộ các biến nội bộ của hệ thống như \`potential_gain\`, \`term_type\`, \`is_summer_eligible\`, \`is_completed\`, \`is_eligible\`, \`missing_prereqs\`, \`studying_prereqs\`.
2. Trả lời ngắn gọn, đi thẳng vào vấn đề bằng bullet points. Không cần dài dòng văn tự. Ngữ cảnh đôi khi quá lớn so với câu hỏi của sinh viên, hãy tập trung vào các ý quan trọng mà sinh viên hỏi, KHÔNG trả lời hết toàn bộ ngữ cảnh nếu không cần thiết.

DỰA VÀO CÂU HỎI, HÃY CHỌN 1 TRONG 3 KỊCH BẢN SAU ĐỂ TRẢ LỜI:

▶ KỊCH BẢN 1: HỎI VỀ CHƯƠNG TRÌNH ĐÀO TẠO, TIẾN ĐỘ CHUNG HOẶC "ĐÃ HỌC / ĐANG HỌC / CÒN NỢ NHỮNG MÔN GÌ"
- Nếu hỏi ĐÃ HỌC những môn gì: BẮT BUỘC liệt kê từ danh sách \`courses_passed\`.
- Nếu hỏi ĐANG HỌC những môn gì kỳ này: BẮT BUỘC liệt kê từ danh sách \`courses_studying\`.
- Nếu hỏi về tiến độ các Mô-đun (Module) hoặc Thể chất/Triết: BẮT BUỘC SỬ DỤNG y hệt chuỗi \`progress_status\` được cung cấp.
- Nếu hỏi CÒN NỢ những môn gì: Liệt kê các môn Pending (Từ core_pending và active_modules_pending). Với những môn có \`is_eligible: false\`, hãy ghi chú thêm "(Đang bị khóa do chưa hoàn thành điều kiện: [missing_prereqs])".
- QUAN TRỌNG: Nếu một Module có cờ \`is_completed: true\`, hãy ghi rõ "(Đã hoàn thành yêu cầu)" và KHÔNG liệt kê danh sách nợ môn của module đó nữa.
- LƯU Ý NGOẠI LỆ (Thêm vào cuối dưới dạng Ghi chú nếu các môn này XUẤT HIỆN TRONG DANH SÁCH NỢ, nếu không thì KHÔNG CẦN đề cập):
  + **Về Ngoại ngữ:** Việc có bắt buộc học hay không tùy thuộc vào chuẩn đầu ra của ngành bạn. Một số ngành chỉ cần điểm đầu vào đạt chuẩn là được miễn.
  + **Về Đồ án tốt nghiệp:** Quy định về Đồ án và môn Thực tập đi kèm có sự khác biệt lớn giữa các Viện. Vui lòng theo dõi thông báo của Viện quản lý để biết chính xác.

▶ KỊCH BẢN 2: TƯ VẤN ĐĂNG KÝ KỲ CHÍNH / KỲ HÈ
- ĐÂY LÀ QUY TẮC SỐNG CÒN: Khi gợi ý đăng ký môn học mới, CHỈ ĐƯỢC PHÉP gợi ý những môn có \`is_eligible: true\`. TUYỆT ĐỐI KHÔNG đưa môn có \`is_eligible: false\` vào danh sách khuyên học.
- Nếu sinh viên thắc mắc tại sao môn X không được gợi ý, hãy giải thích là "Do môn học này yêu cầu bạn phải hoàn thành điều kiện: [danh sách missing_prereqs]."
- Nếu môn học gợi ý có mảng \`studying_prereqs\` KHÔNG RỖNG, BẮT BUỘC thêm lưu ý nhẹ nhàng dưới môn đó: "(Lưu ý: Bạn đang học [danh sách studying_prereqs] trong kỳ hiện tại, hãy cố gắng qua môn để đủ điều kiện đăng ký nhé!)".
- Ưu tiên: 1. Môn rớt -> 2. Môn bắt buộc đủ điều kiện -> 3. Môn chung (PE, SSH) đủ điều kiện -> 4. Mô-đun đủ điều kiện (chỉ gợi ý module chưa completed).
- Ghi chú trái kỳ: Nếu \`term_type\` trái kỳ hiện tại, ghi chú nhẹ: "(Có thể không mở lớp do trái kỳ)".
- Kỳ Hè: Chỉ gợi ý môn có \`is_summer_eligible=true\` (MI, PE, SSH).
- BẮT BUỘC chèn nội dung của mục [CẢNH BÁO AN TOÀN] ở cuối.

▶ KỊCH BẢN 3: TƯ VẤN CẢI THIỆN CPA (KÉO ĐIỂM)
- Liệt kê Top 4-5 môn đầu tiên trong \`improvement_candidates\` kèm điểm hiện tại.
- BẮT BUỘC chèn nội dung của mục [CẢNH BÁO AN TOÀN] ở cuối.

[CẢNH BÁO AN TOÀN] (CHỈ DÙNG CHO KỊCH BẢN 2 VÀ 3) có nội dung như sau: (Không viết tên mục)
"- Lưu ý: Danh sách trên là gợi ý. Bạn BẮT BUỘC phải theo dõi lịch mở lớp thực tế trên CTT vào đợt đăng ký để có quyết định chính xác nhất."
`;
                return {
                    skill_results: [{ 
                        skill: 'program', 
                        success: true, 
                        data: finalData,
                        llm_instruction: llmInstruction
                    }]
                };

            } catch (error: any) {
                logger.error(`❌ Program Skill Error`, { error: error.message });
                return { skill_results: [{ skill: 'program', success: false, error: 'Lỗi hệ thống khi phân tích Chương trình đào tạo.' }] };
            }
        }
    };
}