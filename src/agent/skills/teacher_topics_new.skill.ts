import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { SkillDefinition } from './registry';
import { StateAnnotation } from '../graph/graph/state';

import { RedisClient } from '../tools/clients/redis.client';
import { HustApiClient } from '../tools/clients/hust-api.client';

import { TopicCacheService } from '../services/topic-cache.service';

import { createLogger } from '@/common/logger/logger';

const logger = createLogger('TeacherTopicsSkill');

function normalize(str: string): string {
    if (!str) return '';

    return str
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

export function createTeacherTopicsSkill(
    redis: RedisClient,
    hustApi: HustApiClient,
    topicCacheService: TopicCacheService,
): SkillDefinition {

    return {

        name: 'teacher_topics',

        description:
            'Tìm kiếm danh sách đề tài nghiên cứu, đồ án của một Giảng viên cụ thể.',

        async run(
            state: typeof StateAnnotation.State,
            config?: LangGraphRunnableConfig,
        ): Promise<Partial<typeof StateAnnotation.State>> {

            try {

                const studentId =
                    config?.configurable?.student_id as string;

                if (!studentId) {
                    return {
                        skill_results: []
                    };
                }

                // =====================================================
                // 1. QUERY
                // =====================================================

                const query = String(
                    state.rewritten_query ||
                    state.messages?.at(-1)?.content ||
                    ''
                ).trim();

                if (!query) {

                    return {
                        skill_results: [
                            {
                                skill: 'teacher_topics',
                                success: false,
                                error: 'Missing query'
                            }
                        ]
                    };
                }

                logger.info(`🚨 TEACHER SEARCH`, {
                    query
                });

                // =====================================================
                // 2. LOAD STUDENT INFO
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

                    logger.warn(
                        `Cannot load student school`
                    );
                }

                // =====================================================
                // 3. SEARCH TEACHER
                // =====================================================

                const searchRes: any =
                    await hustApi.searchTeacher(query);

                let teachers = Array.isArray(searchRes)
                    ? searchRes
                    : searchRes?.data || [];

                // remove empty school teachers
                teachers = teachers.filter(
                    (t: any) =>
                        t.schoolName &&
                        t.schoolName.trim() !== ''
                );

                if (teachers.length === 0) {

                    return {
                        skill_results: [
                            {
                                skill: 'teacher_topics',
                                success: true,
                                data: {
                                    query,
                                    matched_teachers: []
                                }
                            }
                        ]
                    };
                }

                // =====================================================
                // 4. RANKING
                // =====================================================

                const normQuery =
                    normalize(query);

                const normStudentSchool =
                    normalize(studentSchool);

                teachers = teachers
                    .map((teacher: any) => {

                        let score = 0;

                        const teacherName =
                            normalize(
                                teacher.fullName || ''
                            );

                        const teacherSchool =
                            normalize(
                                teacher.schoolName || ''
                            );

                        // =========================================
                        // NAME MATCH
                        // =========================================

                        const queryWords = normQuery
                            .split(/\s+/)
                            .filter(
                                w => w.length > 1
                            );

                        let matchedWords = 0;

                        queryWords.forEach(word => {

                            if (
                                teacherName.includes(word)
                            ) {
                                matchedWords++;
                            }

                            if (
                                teacherSchool.includes(word)
                            ) {
                                matchedWords++;
                            }

                        });

                        score += matchedWords * 10;

                        // =========================================
                        // SAME SCHOOL BOOST
                        // =========================================

                        const isSameSchool =
                            normStudentSchool &&
                            (
                                teacherSchool.includes(
                                    normStudentSchool
                                ) ||
                                normStudentSchool.includes(
                                    teacherSchool
                                )
                            );

                        if (isSameSchool) {
                            score += 100;
                        }

                        return {
                            ...teacher,
                            _score: score
                        };
                    })
                    .sort(
                        (a: any, b: any) =>
                            b._score - a._score
                    );

                // =====================================================
                // 5. TAKE TOP TEACHERS
                // =====================================================

                let topTeachers: any[] = [];

                if (teachers.length > 0) {

                    const highestScore =
                        teachers[0]._score;

                    topTeachers = teachers
                        .filter(
                            (t: any) =>
                                t._score === highestScore
                        )
                        .slice(0, 3);

                    // fallback
                    if (topTeachers.length === 0) {
                        topTeachers =
                            teachers.slice(0, 3);
                    }
                }

                logger.info(
                    `✅ MATCHED TEACHERS`,
                    {
                        count: topTeachers.length
                    }
                );

                // =====================================================
                // 6. LOAD TOPICS
                // =====================================================

                const matchedTeachers =
                    await Promise.all(

                        topTeachers.map(
                            async (teacher: any) => {

                                try {

                                    const topics =
                                        await topicCacheService
                                            .getTeacherTopicsWithCache(
                                                teacher.id
                                            );

                                    return {

                                        teacher_info: {

                                            id:
                                                teacher.id,

                                            full_name:
                                                teacher.fullName,

                                            email:
                                                teacher.email,

                                            school:
                                                teacher.schoolName,

                                            matched_score:
                                                teacher._score
                                        },

                                        total_topics:
                                            topics.length,

                                        topics
                                    };

                                } catch (error: any) {

                                    logger.error(
                                        `❌ LOAD TEACHER TOPICS ERROR`,
                                        {
                                            teacherId:
                                                teacher.id,

                                            error:
                                                error.message
                                        }
                                    );

                                    return {

                                        teacher_info: {
                                            id:
                                                teacher.id,

                                            full_name:
                                                teacher.fullName
                                        },

                                        error:
                                            'Cannot load teacher topics'
                                    };
                                }
                            }
                        )
                    );

                // =====================================================
                // 7. RETURN
                // =====================================================

                return {

                    skill_results: [
                        {
                            skill:
                                'teacher_topics',

                            success: true,

                            data: {

                                query,

                                student_school:
                                    studentSchool,

                                total_teachers:
                                    matchedTeachers.length,

                                matched_teachers:
                                    matchedTeachers
                            }
                        }
                    ]
                };

            } catch (error: any) {

                logger.error(
                    `❌ TEACHER TOPICS ERROR`,
                    {
                        error: error.message
                    }
                );

                return {

                    skill_results: [
                        {
                            skill:
                                'teacher_topics',

                            success: false,

                            error:
                                error.message ||
                                'Teacher topics error'
                        }
                    ]
                };
            }
        }
    };
}