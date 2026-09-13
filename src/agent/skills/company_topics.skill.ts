import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { SkillDefinition } from './registry';
import { StateAnnotation } from '../graph/graph/state';
import { RedisClient } from '../tools/clients/redis.client';
import { HustApiClient } from '../tools/clients/hust-api.client';
import { TopicCacheService } from '../services/topic-cache.service';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('CompanyTopicsSkill');

// Key lưu trữ toàn bộ hồ sơ Công ty đã từng được tìm thấy
const GLOBAL_COMPANIES_CACHE_KEY = 'hustva:global_companies_cache';
const TTL_30_DAYS = 30 * 24 * 60 * 60;

export function createCompanyTopicsSkill(
    redis: RedisClient,
    hustApi: HustApiClient,
    topicCacheService: TopicCacheService
): SkillDefinition {
    return {
        name: 'company_topics',
        description: 'Tìm kiếm danh sách đề tài thực tập, đồ án từ các Công ty/Doanh nghiệp.',

        async run(
            state: typeof StateAnnotation.State & { extracted_company_name?: string },
            config?: LangGraphRunnableConfig,
        ): Promise<Partial<typeof StateAnnotation.State>> {
            const studentId = config?.configurable?.student_id as string;
            if (!studentId) return { skill_results: [] };

            const cleanKeyword = state.extracted_company_name?.trim().toLowerCase() || '';

            if (!cleanKeyword || cleanKeyword.length < 2) {
                return { skill_results: [{ skill: 'company_topics', success: false, error: 'Vui lòng cung cấp rõ tên Công ty/Doanh nghiệp cần tìm.' }] };
            }

            try {
                // 1. Kéo thông tin sinh viên để lọc theo trường
                const infoCache = await redis.get(`hustva:student:${studentId}:info`);
                const studentSchool = infoCache ? JSON.parse(infoCache).school?.toLowerCase() || '' : '';

                // HÀM CHUẨN HÓA CHUỖI
                const normalize = (str: string) => str ? str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim() : '';
                const qKeywordNorm = normalize(cleanKeyword);
                
                // 2. TẠO MẢNG TỪ KHÓA FALLBACK ĐỂ "HACK" API eHUST (Thay thế cho LLM)
                // VD: "viettel telecom" -> Thử "viettel telecom" -> Thử "viettel" -> Thử "telecom"
                const searchKeywords = [qKeywordNorm];
                const qWords = qKeywordNorm.split(/\s+/).filter(w => w.length > 2); // Chỉ lấy từ có nghĩa
                
                if (qWords.length > 1) {
                    searchKeywords.push(qWords[0]); // Từ đầu tiên (Thường là core name: viettel, fpt, vng)
                    
                    const longestWord = [...qWords].sort((a, b) => b.length - a.length)[0];
                    if (longestWord !== qWords[0]) searchKeywords.push(longestWord); // Thêm từ dài nhất để dự phòng
                }

                // 3. LẤY DANH SÁCH TỪ REDIS POOL
                let cachedCompanies: any[] = [];
                try {
                    const cacheStr = await redis.get(GLOBAL_COMPANIES_CACHE_KEY);
                    if (cacheStr) cachedCompanies = JSON.parse(cacheStr);
                } catch (e) {
                    logger.error('Lỗi khi đọc cache danh sách công ty', e);
                }

                // 4. VÒNG LẶP GỌI API (Dừng ngay khi API nhả kết quả)
                let apiCompanies: any[] = [];
                for (const kw of searchKeywords) {
                    logger.info(`🚨 COMPANY EXTRACT | Thử Search API với: "${kw}"`);
                    const searchRes: any = await hustApi.searchCompanies(kw);
                    const results = Array.isArray(searchRes) ? searchRes : searchRes?.data || [];
                    if (results.length > 0) {
                        apiCompanies = results;
                        logger.info(`✅ TÌM THẤY ${results.length} CÔNG TY BẰNG API VỚI TỪ KHÓA: "${kw}"`);
                        break; 
                    }
                }

                // 5. GỘP DỮ LIỆU & LOẠI BỎ TRÙNG LẶP (DEDUPLICATE)
                const mergedMap = new Map();
                apiCompanies.forEach((c: any) => mergedMap.set(c.id, c));
                cachedCompanies.forEach((c: any) => {
                    if (!mergedMap.has(c.id)) mergedMap.set(c.id, c);
                });
                const allCompanies = Array.from(mergedMap.values());

                // LƯU LẠI VÀO REDIS (Fire & Forget)
                redis.set(GLOBAL_COMPANIES_CACHE_KEY, JSON.stringify(allCompanies), TTL_30_DAYS).catch(e => logger.error('Lỗi lưu cache công ty', e));

                // 6. CHẤM ĐIỂM FUZZY MATCHING (Giải quyết ViettelTelecom vs Viettel Telecom)
                let highMatchCompanies: any[] = [];
                let lowMatchCompanies: any[] = [];
                const qKeywordNoSpace = qKeywordNorm.replace(/\s+/g, ''); 
                const originalWords = qKeywordNorm.split(/\s+/); 

                allCompanies.forEach((c: any) => {
                    const fuzzyValueNorm = normalize(c.valueForFuzzyMatching || c.fullName || c.displayName || '');
                    const fuzzyNoSpace = fuzzyValueNorm.replace(/\s+/g, '');
                    
                    let score = 0;
                    let matchRatio = 0;

                    // KIỂM TRA 1: Khớp nguyên cụm dài hoặc khớp kiểu viết dính liền (vietteltelecom == vietteltelecom)
                    if (fuzzyNoSpace.includes(qKeywordNoSpace) && qKeywordNoSpace.length > 3) {
                        matchRatio = 1.0;
                        score = 1000; // Điểm tuyệt đối
                    } 
                    // KIỂM TRA 2: Chấm điểm từng từ rời rạc
                    else {
                        let matchedWords = 0;
                        originalWords.forEach(w => {
                            if (fuzzyValueNorm.includes(w)) {
                                matchedWords++;
                                score += (w.length * 10); // Từ dài (telecom) sẽ được cộng nhiều điểm hơn từ ngắn (ai)
                            }
                        });
                        matchRatio = originalWords.length > 0 ? (matchedWords / originalWords.length) : 0;
                    }

                    // Điều kiện vào chung kết: Phải match >= 50% số từ
                    if (matchRatio >= 0.5) {
                        highMatchCompanies.push({ ...c, _score: score });
                    } else if (matchRatio > 0) {
                        lowMatchCompanies.push({ ...c, _score: score });
                    }
                });

                // Sắp xếp ưu tiên những công ty có điểm match cao nhất lên đầu
                highMatchCompanies.sort((a, b) => b._score - a._score);
                lowMatchCompanies.sort((a, b) => b._score - a._score);

                if (highMatchCompanies.length === 0 && lowMatchCompanies.length === 0) {
                     return {
                        skill_results: [{
                            skill: 'company_topics',
                            success: true,
                            data: { keyword: cleanKeyword },
                            llm_instruction: `Không tìm thấy công ty nào khớp với từ khóa "${cleanKeyword}" trong hệ thống.`
                        }]
                    };
                }

                // 7. KỊCH BẢN XỬ LÝ DỮ LIỆU ĐẦU RA
                const finalResults: any = {
                    exact_matches: [], // >= 50% -> Kéo đề tài
                    need_clarification: [] // < 50% -> Chỉ trả tên
                };

                let llm_instruction = "";

                // TH1: Tìm ra DUY NHẤT 1 công ty (Ưu tiên lấy đề tài luôn)
                if (highMatchCompanies.length + lowMatchCompanies.length === 1) {
                    const theCompany = highMatchCompanies.length > 0 ? highMatchCompanies[0] : lowMatchCompanies[0];
                    const topicsData = await fetchAndFilterCompanyTopics(theCompany, studentSchool, topicCacheService);
                    finalResults.exact_matches.push(topicsData);
                    
                    llm_instruction = "Hệ thống tìm thấy 1 công ty duy nhất khớp tên. Hãy kiểm tra: Nếu 'total_topics_in_db' lớn hơn 0 nhưng 'matched_topics' rỗng, hãy giải thích: 'Công ty có đăng đề tài, nhưng không dành cho ngành học của bạn.' Chú ý 'salary_offer' và 'student_num' để tư vấn.";
                } 
                // TH2: Có NHIỀU công ty
                else {
                    // Lấy tối đa top 10 High Match có điểm cao nhất để kéo đề tài 
                    const topHighMatches = highMatchCompanies.slice(0, 10);
                    for (const company of topHighMatches) {
                        const topicsData = await fetchAndFilterCompanyTopics(company, studentSchool, topicCacheService);
                        finalResults.exact_matches.push(topicsData);
                    }

                    // Đưa phần còn lại vào list làm rõ
                    for (const company of lowMatchCompanies) {
                        finalResults.need_clarification.push({
                            id: company.id, full_name: company.fullName, website: company.website
                        });
                    }

                    // Điều hướng LLM Prompt
                    if (finalResults.exact_matches.length > 0 && finalResults.need_clarification.length === 0) {
                        llm_instruction = "Trình bày danh sách công ty và đề tài phù hợp với Viện/Trường của sinh viên. Nếu 'matched_topics' rỗng, hãy nói rõ công ty không tuyển sinh viên trường này.";
                    } else if (finalResults.exact_matches.length === 0 && finalResults.need_clarification.length > 0) {
                        llm_instruction = "Từ khóa quá chung chung, tìm thấy nhiều công ty có tên tương tự nhưng độ khớp thấp (<50%). Hãy liệt kê danh sách 'need_clarification' và YÊU CẦU sinh viên chọn công ty cụ thể.";
                    } else {
                        llm_instruction = "Tìm thấy các công ty khớp tốt (đã kèm đề tài) và một số công ty tương tự. Trình bày các công ty khớp tốt trước (chú ý lọc đề tài theo trường), sau đó hỏi sinh viên nếu họ đang tìm công ty khác trong danh sách chưa rõ.";
                    }
                }

                return {
                    skill_results: [{ 
                        skill: 'company_topics', 
                        success: true, 
                        data: finalResults, 
                        llm_instruction: llm_instruction 
                    }]
                };

            } catch (error: any) {
                logger.error(`❌ Company Topics Error`, { error: error.message });
                return { skill_results: [{ skill: 'company_topics', success: false, error: 'Lỗi hệ thống khi tìm kiếm công ty.' }] };
            }
        }
    };
}

// ── HÀM PHỤ TRỢ: KÉO ĐỀ TÀI VÀ LỌC THEO TRƯỜNG ──
async function fetchAndFilterCompanyTopics(company: any, studentSchool: string, topicCacheService: TopicCacheService) {
    const allTopics = await topicCacheService.getCompanyTopicsWithCache(company.id);
    
    const filteredTopics = allTopics.filter((topic: any) => {
        if (!topic.unit_names || topic.unit_names.length === 0) return true; // Công ty không kén chọn trường -> Nhận tất
        const unitsString = topic.unit_names.join(' ').toLowerCase();
        return studentSchool && unitsString.includes(studentSchool);
    });

    return {
        company_info: {
            id: company.id,
            full_name: company.fullName,
            website: company.website,
            score: company._score
        },
        total_topics_in_db: allTopics.length,
        matched_topics: filteredTopics
    };
}