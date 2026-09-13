import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { SkillDefinition } from './registry';
import { StateAnnotation } from '../graph/graph/state';

import { RedisClient } from '../tools/clients/redis.client';
import { HustApiClient } from '../tools/clients/hust-api.client';

import { TopicCacheService } from '../services/topic-cache.service';

import { createLogger } from '@/common/logger/logger';

const logger = createLogger('CompanyTopicsSkill');

function normalize(str: string): string {
    if (!str) return '';

    return str
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

export function createCompanyTopicsSkill(
    redis: RedisClient,
    hustApi: HustApiClient,
    topicCacheService: TopicCacheService,
): SkillDefinition {

    return {
        name: 'company_topics',

        description:
            'Tìm kiếm công ty và lấy danh sách đề tài thực tập/đồ án phù hợp với sinh viên.',

        async run(
            state: typeof StateAnnotation.State,
            config?: LangGraphRunnableConfig,
        ): Promise<Partial<typeof StateAnnotation.State>> {

            try {

                const studentId =
                    config?.configurable?.student_id as string;

                const query = String(
                    state.rewritten_query ||
                    state.messages?.at(-1)?.content ||
                    ''
                ).trim();

                if (!query) {
                    return {
                        skill_results: [
                            {
                                skill: 'company_topics',
                                success: false,
                                error: 'Missing query'
                            }
                        ]
                    };
                }

                logger.info(`🚨 COMPANY SEARCH`, {
                    query
                });

                // =====================================================
                // 1. LOAD STUDENT INFO
                // =====================================================

                let studentSchool = '';

                try {

                    const infoCache = await redis.get(
                        `hustva:student:${studentId}:info`
                    );

                    if (infoCache) {
                        const parsed = JSON.parse(infoCache);

                        studentSchool =
                            parsed?.school?.toLowerCase() || '';
                    }

                } catch (e) {
                    logger.warn(`Cannot load student school`);
                }

                // =====================================================
                // 2. SEARCH COMPANIES
                // =====================================================

                const searchRes: any =
                    await hustApi.searchCompanies(query);

                let companies = Array.isArray(searchRes)
                    ? searchRes
                    : searchRes?.data || [];

                if (companies.length === 0) {

                    return {
                        skill_results: [
                            {
                                skill: 'company_topics',
                                success: true,
                                data: {
                                    query,
                                    results: []
                                }
                            }
                        ]
                    };
                }

                // =====================================================
                // 3. RANKING
                // =====================================================

                const normQuery = normalize(query);

                if (companies.length > 2) {

                    const queryWords = normQuery
                        .split(/\s+/)
                        .filter(w => w.length > 2);

                    companies = companies
                        .map((company: any) => {

                            let score = 0;

                            const fuzzyValue = normalize(
                                company.valueForFuzzyMatching ||
                                company.fullName ||
                                ''
                            );

                            queryWords.forEach(word => {

                                if (fuzzyValue.includes(word)) {
                                    score += 10;
                                }

                            });

                            return {
                                ...company,
                                _score: score
                            };
                        })
                        .sort(
                            (a: any, b: any) =>
                                b._score - a._score
                        );
                }

                // =====================================================
                // 4. TAKE TOP COMPANIES
                // =====================================================

                const topCompanies = companies.slice(0, 5);

                logger.info(`✅ MATCHED COMPANIES`, {
                    count: topCompanies.length
                });

                // =====================================================
                // 5. LOAD TOPICS
                // =====================================================

                const results = await Promise.all(

                    topCompanies.map(async (company: any) => {

                        try {

                            const allTopics =
                                await topicCacheService
                                    .getCompanyTopicsWithCache(
                                        company.id
                                    );

                            // =========================================
                            // FILTER BY SCHOOL
                            // =========================================

                            const matchedTopics =
                                allTopics.filter((topic: any) => {

                                    if (
                                        !topic.unit_names ||
                                        topic.unit_names.length === 0
                                    ) {
                                        return true;
                                    }

                                    if (!studentSchool) {
                                        return true;
                                    }

                                    const unitsString =
                                        topic.unit_names
                                            .join(' ')
                                            .toLowerCase();

                                    return unitsString.includes(
                                        studentSchool
                                    );
                                });

                            return {

                                company_info: {
                                    id: company.id,
                                    full_name: company.fullName,
                                    short_name: company.shortName,
                                    website: company.website
                                },

                                ranking_score:
                                    company._score || 0,

                                total_topics_in_db:
                                    allTopics.length,

                                matched_topics:
                                    matchedTopics
                            };

                        } catch (error: any) {

                            logger.error(
                                `❌ LOAD COMPANY TOPICS ERROR`,
                                {
                                    companyId: company.id,
                                    error: error.message
                                }
                            );

                            return {

                                company_info: {
                                    id: company.id,
                                    full_name: company.fullName
                                },

                                error:
                                    'Cannot load company topics'
                            };
                        }
                    })
                );

                // =====================================================
                // 6. RETURN
                // =====================================================
                 const llm_instruction = `
Bạn là người tư vấn thực tập. Dưới đây là các đề tài của công ty PHÙ HỢP VỚI NGÀNH HỌC của sinh viên.
- Nếu 'total_topics_in_db' lớn hơn 0 nhưng 'matched_topics' rỗng, hãy giải thích nhẹ nhàng: "Công ty có đăng đề tài, nhưng không tuyển sinh viên thuộc Trường của bạn."
- Chú ý các thông tin 'salary_offer' (mức lương) và 'student_num' (số lượng) để tư vấn.`;
                return {

                    skill_results: [
                        {
                            skill: 'company_topics',

                            success: true,

                            data: {
                                query,
                                student_school: studentSchool,
                                total_companies: results.length,
                                results,
                                llm_instruction: llm_instruction
                            }
                        }
                    ]
                };

            } catch (error: any) {

                logger.error(`❌ COMPANY TOPICS ERROR`, {
                    error: error.message
                });

                return {

                    skill_results: [
                        {
                            skill: 'company_topics',

                            success: false,

                            error:
                                error.message ||
                                'Company topics error'
                        }
                    ]
                };
            }
        }
    };
}