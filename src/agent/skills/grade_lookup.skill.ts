import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { SkillDefinition } from './registry';
import { StateAnnotation } from '../graph/graph/state';
import { RedisClient } from '../tools/clients/redis.client';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('GradeLookupSkill');

export function createGradeLookupSkill(redis: RedisClient): SkillDefinition {
    return {
        name: 'grade_lookup',
        description: 'Tra cứu điểm số, tín chỉ, trạng thái qua môn của một hoặc nhiều môn học cụ thể dựa trên từ khóa (mã môn, tên môn, tên viết tắt tiếng Anh/Việt).',

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

            logger.info(`🚨 GRADE LOOKUP EXECUTED | Query: "${query}"`);

            try {
                // 1. Lấy Bảng điểm cá nhân
                const transcriptCache = await redis.get(`hustva:student:${studentId}:transcript`);
                if (!transcriptCache) {
                    return { skill_results: [{ skill: 'grade_lookup', success: false, error: 'Chưa có dữ liệu bảng điểm. Vui lòng chờ hệ thống đồng bộ (khoảng 1 phút).' }] };
                }
                const transcript: any[] = JSON.parse(transcriptCache);

                // 2. Hydrate: Lấy Tên môn, Tín chỉ & Tên viết tắt từ Global Cache
                const uniqueCourseIds = [...new Set(transcript.map(t => t.course_id))];
                const courseInfoPromises = uniqueCourseIds.map(id => redis.get(`hustva:course:${id}`));
                const courseInfosRaw = await Promise.all(courseInfoPromises);
                
                const courseDict: Record<string, any> = {};
                uniqueCourseIds.forEach((id, index) => {
                    if (courseInfosRaw[index]) {
                        const info = JSON.parse(courseInfosRaw[index]!);
                        courseDict[id] = { 
                            name_vn: info.course_name_vn || '', 
                            name_en: info.course_name_en || '',
                            abbrs: info.abbrs || [], 
                            credit: info.credit 
                        };
                    } else {
                        courseDict[id] = { name_vn: 'Không xác định', name_en: '', abbrs: [], credit: 0 };
                    }
                });

                // 3. Gom nhóm môn học
                const groupedTranscript: Record<string, any> = {};
                for (const t of transcript) {
                    const cid = t.course_id;
                    if (!groupedTranscript[cid]) {
                        groupedTranscript[cid] = {
                            course_id: cid,
                            course_name_vn: courseDict[cid].name_vn,
                            course_name_en: courseDict[cid].name_en,
                            abbrs: courseDict[cid].abbrs, 
                            credit: courseDict[cid].credit,
                            records: []
                        };
                    }
                    groupedTranscript[cid].records.push({
                        semester: t.term_id,
                        grade_qt: t.grade_class,
                        grade_ck: t.grade_exam,
                        grade_letter: t.mark_char
                    });
                }

// =========================================================
                // 4. KỊCH BẢN 3: BẮT BỐI CẢNH THỜI GIAN (KỲ HỌC)
                // =========================================================
                const normalize = (str: string) => str ? str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim() : '';
                const replaceRoman = (str: string) => str.replace(/\b(i{1,3}|iv|v)\b/g, match => {
                    if (match === 'iv') return '4'; if (match === 'v') return '5'; return String(match.length);
                });
                
                let normQuery = replaceRoman(normalize(query));
                logger.info(normQuery);
                // Trích xuất toàn bộ các kỳ học sinh viên đã có điểm, sắp xếp giảm dần (Mới nhất lên đầu)
                const allSemesters = [...new Set(transcript.map(t => String(t.term_id)))].sort((a, b) => b.localeCompare(a));
                const latestSemester = allSemesters[0]; // VD: "20251"

                let targetSemester: string | null = null;
                
                // Nhận diện cụm từ "kỳ vừa rồi", "kỳ này", "kỳ mới nhất", "năm ngoái"
                if (/(ky|ki|hoc ky|hoc ki)\s*(vua roi|truoc|moi nhat|gan nhat|moi day)/i.test(normQuery)) {
                    targetSemester = latestSemester;
                } else {
                    // Nhận diện mã kỳ cụ thể do sinh viên gõ đa dạng format
                    // Hỗ trợ: 20241, 2024.1, 2024,1, 2024 1, 2024-1
                    const semMatch = normQuery.match(/\b(20\d{2})[.,\s\-]?([1-3])\b/);
                    if (semMatch) {
                        // semMatch[1] là năm (VD: "2024"), semMatch[2] là kỳ (VD: "1")
                        targetSemester = semMatch[1] + semMatch[2]; // Ép chuẩn về "20241"
                    }
                }
                logger.info(`target semeter: ${targetSemester}`);
                // NẾU SINH VIÊN HỎI THEO KỲ -> BỎ QUA SCORING MÔN HỌC, TRẢ VỀ TOÀN BỘ MÔN CỦA KỲ ĐÓ
                if (targetSemester) {
                    const coursesInSemester = Object.values(groupedTranscript).filter((c: any) => 
                        c.records.some((r: any) => String(r.semester) === targetSemester)
                    ).map((c: any) => {
                        // Lọc bỏ các record điểm của kỳ khác để LLM không bị rối
                        const filteredRecords = c.records.filter((r: any) => String(r.semester) === targetSemester);
                        return { ...c, records: filteredRecords };
                    });

                    if (coursesInSemester.length > 0) {
                        logger.info(`✅ GradeLookup: Kịch bản 3 - Trả về ${coursesInSemester.length} môn trong kỳ ${targetSemester}`);
                        return {
                            skill_results: [{ 
                                skill: 'grade_lookup', success: true, 
                                data: { matched_courses: coursesInSemester, target_semester: targetSemester },
                                llm_instruction: `Đây là TOÀN BỘ BẢNG ĐIỂM HỌC KỲ ${targetSemester} của sinh viên. BẮT BUỘC trình bày danh sách môn học dưới dạng Bảng Markdown (Markdown Table) gồm các cột: Mã học phần, Tên học phần, Số tín chỉ, Điểm quá trình, Điểm cuối kỳ, Điểm chữ. BẠN TUYỆT ĐỐI KHÔNG BỊA ĐIỂM. Hãy liệt kê điểm chi tiết theo YÊU CẦU BAN ĐẦU của sinh viên.`
                            }]
                        };
                    }
                }

                // =========================================================
                // 5. KỊCH BẢN 1 & 2: MULTI-COURSE SCORING (Không có giới hạn Top-K cứng)
                // =========================================================
                const queryNoSpace = normQuery.replace(/\s+/g, '');
                const queryWordsRaw = normQuery.split(/\s+/).filter(w => w.length > 0);
                const queryGeneratedAbbr = queryWordsRaw.map(w => w.charAt(0)).join('');
                const cleanQueryWords = normQuery.replace(/\b(va|cho|cua|diem|nhieu|la|gi|hay|mot|cach|sao|ck|gk|qt|tk)\b/g, '').trim().split(/\s+/).filter(w => w.length > 1);

                // TRÍCH XUẤT NHIỀU MÃ MÔN CÙNG LÚC (Sử dụng Set thay vì Break)
                const queryExtractedCids = new Set<string>();
                const allStudentCids = Object.keys(groupedTranscript);
                
                for (const cid of allStudentCids) {
                    const lowerCid = cid.toLowerCase();
                    const match = lowerCid.match(/^([a-z]+)(\d+)([a-z]*)$/);
                    if (match) {
                        const exactCidRegex = new RegExp(`\\b${match[1]}\\s*${match[2]}\\s*${match[3]}\\b`, 'i');
                        if (exactCidRegex.test(normQuery)) {
                            queryExtractedCids.add(lowerCid); // Lấy TẤT CẢ mã môn tìm thấy
                        }
                    }
                }

                let scoredCourses = Object.values(groupedTranscript).map((course: any) => {
                    let score = 0;
                    const normNameVn = replaceRoman(normalize(course.course_name_vn));
                    const normNameEn = replaceRoman(normalize(course.course_name_en));
                    const nameVnNoSpace = normNameVn.replace(/\s+/g, '');
                    const nameEnNoSpace = normNameEn.replace(/\s+/g, '');
                    const cid = course.course_id.toLowerCase();

                    // --- ƯU TIÊN 1 (100đ): KHỚP MÃ MÔN ---
                    if (queryExtractedCids.has(cid)) { 
                        score += 100;
                    } 
                    // --- ƯU TIÊN 2 (90đ): KHỚP TÊN MÔN ---
                    else if ((normNameVn.length > 3 && normQuery.includes(normNameVn)) || 
                             (normNameEn && normNameEn.length > 3 && normQuery.includes(normNameEn))) {
                        score += 90;
                    }

                    // --- ƯU TIÊN 3: TỪ VIẾT TẮT ---
                    const abbrs = course.abbrs || [];
                    let maxAbbrScore = 0;
                    for (const abbr of abbrs) {
                        for (const word of queryWordsRaw) {
                            if (word.length >= 2 && abbr.includes(word)) {
                                const tempScore = 60 + ((word.length / abbr.length) * 25);
                                if (tempScore > maxAbbrScore) maxAbbrScore = tempScore;
                            }
                        }
                        if (queryGeneratedAbbr.length >= 2 && abbr.includes(queryGeneratedAbbr)) {
                            const tempScore = 60 + ((queryGeneratedAbbr.length / abbr.length) * 25);
                            if (tempScore > maxAbbrScore) maxAbbrScore = tempScore;
                        }
                    }
                    if (maxAbbrScore > score) score = maxAbbrScore;

                    // --- ƯU TIÊN 4: VIẾT LIỀN ---
                    if (score < 80) {
                        if ((nameVnNoSpace.length > 5 && queryNoSpace.includes(nameVnNoSpace)) || 
                            (nameEnNoSpace.length > 5 && queryNoSpace.includes(nameEnNoSpace))) {
                            score = Math.max(score, 75);
                        }
                    }

                    // --- ƯU TIÊN 5: FUZZY MATCH ---
                    if (score < 75 && cleanQueryWords.length > 0) {
                        let matchCount = 0;
                        cleanQueryWords.forEach(qw => {
                            if (normNameVn.includes(qw) || normNameEn.includes(qw)) matchCount++;
                        });
                        const ratio = matchCount / cleanQueryWords.length;
                        if (ratio >= 0.4) {
                            score = Math.max(score, Math.floor(ratio * 60));
                        }
                    }

                    return { ...course, _score: score };
                });

                scoredCourses = scoredCourses.filter(c => c._score >= 30).sort((a, b) => b._score - a._score);

                if (scoredCourses.length === 0) {
                    if (!targetSemester && latestSemester) {
                        logger.info(`⚠️ GradeLookup Fallback: Không tìm thấy môn. Tự động trả về kỳ mới nhất ${latestSemester}`);
                        
                        const coursesInLatestSemester = Object.values(groupedTranscript).filter((c: any) => 
                            c.records.some((r: any) => String(r.semester) === latestSemester)
                        ).map((c: any) => {
                            const filteredRecords = c.records.filter((r: any) => String(r.semester) === latestSemester);
                            return { ...c, records: filteredRecords };
                        });

                        return {
                            skill_results: [{ 
                                skill: 'grade_lookup', success: true, 
                                data: { matched_courses: coursesInLatestSemester, target_semester: latestSemester },
                                llm_instruction: `Sinh viên muốn xem điểm nhưng không nói rõ kỳ nào và môn nào. Hệ thống đã tự động lấy TOÀN BỘ BẢNG ĐIỂM HỌC KỲ MỚI NHẤT (${latestSemester}). BẮT BUỘC trình bày danh sách môn học dưới dạng Bảng Markdown (Markdown Table) gồm các cột: Mã học phần, Tên học phần, Số tín chỉ, Điểm quá trình, Điểm cuối kỳ, Điểm chữ. BẠN TUYỆT ĐỐI KHÔNG BỊA ĐIỂM.`
                            }]
                        };
                    } else {
                        // Nếu đã có targetSemester (nhưng lỗi) hoặc không có cả latestSemester
                        return {
                            skill_results: [{
                                skill: 'grade_lookup', success: false, error: 'Không tìm thấy môn học.',
                                llm_instruction: 'KHÔNG TÌM THẤY MÔN HỌC. Giải thích nhẹ nhàng rằng bạn không tìm thấy môn học trong bảng điểm. Gợi ý cung cấp Mã môn chuẩn (VD: IT3100). NGHIÊM CẤM BỊA ĐIỂM.'
                            }]
                        };
                    }
                }

                // =========================================================
                // 6. XUẤT KẾT QUẢ THEO ĐỘ TIN CẬY
                // =========================================================
                const highestScore = scoredCourses[0]._score;
                let finalResults:any = [];
                let llm_instruction = "";

                if (highestScore >= 80) {
                    // Nếu Sinh viên hỏi 3 môn, và cả 3 môn đều ăn >80 điểm -> Trả cả 3 môn (Multi-Course Triumphant!)
                    finalResults = scoredCourses.filter(c => c._score >= 80).map(({ _score, ...rest }) => rest);
                    
                    if (finalResults.length > 1) {
                        llm_instruction = `Hệ thống tìm thấy điểm của ${finalResults.length} môn học sinh viên yêu cầu. BẠN TUYỆT ĐỐI KHÔNG BỊA ĐIỂM. Hãy báo cáo điểm rõ ràng cho từng môn.`;
                    } else {
                        llm_instruction = "Dưới đây là thông tin điểm của môn học. BẠN TUYỆT ĐỐI KHÔNG BỊA ĐIỂM.";
                    }
                } else {
                    // Mờ mịt (Fuzzy) -> Trả Top 5 để mồi, GIẤU ĐIỂM CHỐNG ẢO GIÁC
                    finalResults = scoredCourses.slice(0, 5).map(c => ({
                        course_id: c.course_id,
                        course_name_vn: c.course_name_vn,
                        abbrs: c.abbrs
                    }));
                    llm_instruction = "Hệ thống không tìm thấy môn học khớp 100%. Dưới đây là các môn gần giống nhất (ĐIỂM SỐ ĐÃ BỊ ẨN ĐỂ TRÁNH ẢO GIÁC). BẠN TUYỆT ĐỐI KHÔNG ĐƯỢC BÁO CÁO ĐIỂM SỐ. Hãy hỏi lại sinh viên: 'Ý bạn có phải là một trong các môn sau không?' và liệt kê ra.";
                }

                logger.info(`✅ GradeLookup: Multi-Match trả về ${finalResults.length} môn. Highest Score: ${highestScore}.`);

                return {
                    skill_results: [{ 
                        skill: 'grade_lookup', success: true, 
                        data: { matched_courses: finalResults },
                        llm_instruction: llm_instruction
                    }],
                };

            } catch (error: any) {
                logger.error(`❌ GradeLookup Error`, { error: error.message });
                return { skill_results: [{ skill: 'grade_lookup', success: false, error: 'Lỗi hệ thống khi truy xuất điểm.' }] };
            }
        },
    };
}