/**
 * student-graph.service.ts — HustVA V3
 *
 * Manages per-student Neo4j subgraph populated from eHUST API.
 *
 * Graph model:
 *   (s:Student {id, seededAt, semesterSeeded})
 *     -[:PASSED   {semester, finalMark}]->(c:Course {id, name})
 *     -[:FAILED   {semester, finalMark}]->(c:Course {id, name})
 *     -[:ENROLLED {semester}           ]->(c:Course {id, name})
 *
 * Seed strategy:
 *   - Called ONCE after first login (ensureStudentGraph)
 *   - Re-called by cron at semester start (refreshStudentGraph)
 *   - Both login + demoLogin trigger seed via fire-and-forget
 */
import { Injectable } from '@nestjs/common';
import neo4j from 'neo4j-driver';
import { envConfig } from '@/common/config/env.config';
import { HustApiClient } from '@/agent/tools/clients/hust-api.client';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('StudentGraphService');

@Injectable()
export class StudentGraphService {
    private readonly driver = neo4j.driver(
        envConfig.NEO4J_URI,
        neo4j.auth.basic(envConfig.NEO4J_USER, envConfig.NEO4J_PASSWORD),
    );
    private readonly hustApi = new HustApiClient();

    // ── Check ──────────────────────────────────────────────────────────────────

    /** True if student node already exists AND was seeded this semester */
    async isSeededThisSemester(studentId: string, semester: string): Promise<boolean> {
        const session = this.driver.session({ defaultAccessMode: neo4j.session.READ });
        try {
            const result = await session.run(
                `MATCH (s:Student {id: $id, semesterSeeded: $sem}) RETURN s LIMIT 1`,
                { id: studentId, sem: semester },
            );
            return result.records.length > 0;
        } finally {
            await session.close();
        }
    }

    /** Return all seeded student IDs (for cron refresh) */
    async getAllStudentIds(): Promise<string[]> {
        const session = this.driver.session({ defaultAccessMode: neo4j.session.READ });
        try {
            const result = await session.run(`MATCH (s:Student) RETURN s.id AS id`);
            return result.records.map(r => r.get('id') as string);
        } finally {
            await session.close();
        }
    }

    // ── Seed ───────────────────────────────────────────────────────────────────

    /**
     * Ensures student graph exists for the current semester.
     * No-ops if already seeded this semester → safe to call on every login.
     */
    async ensureStudentGraph(studentId: string): Promise<void> {
        let currentSemester: string;
        try {
            const sems: any = await this.hustApi.getSemesters();
            const semesters = Array.isArray(sems) ? sems : sems?.data || [];
            const activeSemester = semesters.find(s => s.currentForClass === true);
            
            if (activeSemester) {
                currentSemester = activeSemester.semester || activeSemester.id || envConfig.HUST_DEFAULT_SEMESTER;
            } else {
                const sorted = [...semesters].sort((a: any, b: any) =>
                    String(b.semester || b.id || '').localeCompare(String(a.semester || a.id || ''))
                );
                currentSemester = sorted[0]?.semester || sorted[0]?.id || envConfig.HUST_DEFAULT_SEMESTER;
            }
        } catch {
            currentSemester = envConfig.HUST_DEFAULT_SEMESTER;
        }

        if (await this.isSeededThisSemester(studentId, currentSemester)) {
            logger.debug('Student graph up-to-date, skip seed', { studentId, currentSemester });
            return;
        }

        await this.refreshStudentGraph(studentId, currentSemester);
    }

    /**
     * Force re-seed for a student (used by cron + ensureStudentGraph when stale).
     */
    async refreshStudentGraph(studentId: string, semester?: string): Promise<void> {
        logger.info('Seeding student graph', { studentId, semester });

        // Resolve semester if not provided
        if (!semester) {
            try {
                const sems: any = await this.hustApi.getSemesters();
                const semesters = Array.isArray(sems) ? sems : sems?.data || [];
                const activeSemester = semesters.find(s => s.currentForClass === true);
                
                if (activeSemester) {
                    semester = activeSemester.semester || activeSemester.id || envConfig.HUST_DEFAULT_SEMESTER;
                } else {
                    const sorted = [...semesters].sort((a: any, b: any) => String(b.semester || b.id || '').localeCompare(String(a.semester || a.id || '')));
                    semester = sorted[0]?.semester || sorted[0]?.id || envConfig.HUST_DEFAULT_SEMESTER;
                }
            } catch {
                semester = envConfig.HUST_DEFAULT_SEMESTER;
            }
        }

        // Guarantee semester is a non-null string before passing to getClasses
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const resolvedSemester: string = semester!;

        // Fetch data in parallel
        const [gradesRes, classesRes] = await Promise.allSettled([
            this.hustApi.getGrades(studentId),
            this.hustApi.getClasses(studentId, semester!),
        ]);

        const grades: any[] = gradesRes.status === 'fulfilled'
            ? (Array.isArray(gradesRes.value) ? gradesRes.value : (gradesRes.value as any)?.data || [])
            : [];

        const classes: any[] = classesRes.status === 'fulfilled'
            ? (Array.isArray(classesRes.value) ? classesRes.value : (classesRes.value as any)?.data || [])
            : [];

        const session = this.driver.session({ defaultAccessMode: neo4j.session.WRITE });
        try {
            // Upsert Student node
            await session.run(
                `MERGE (s:Student {id: $id})
                 SET s.seededAt = $now, s.semesterSeeded = $sem`,
                { id: studentId, now: new Date().toISOString(), sem: resolvedSemester },
            );

            // Ensure constraints exist (idempotent)
            await session.run(`CREATE CONSTRAINT student_id IF NOT EXISTS FOR (s:Student) REQUIRE s.id IS UNIQUE`).catch(() => { });
            await session.run(`CREATE CONSTRAINT course_id_sg IF NOT EXISTS FOR (c:Course) REQUIRE c.id IS UNIQUE`).catch(() => { });

            // Remove old edges for this student (clean reseed)
            await session.run(
                `MATCH (s:Student {id: $id})-[r:PASSED|FAILED|ENROLLED]->() DELETE r`,
                { id: studentId },
            );

            // Seed grade history
            for (const g of grades) {
                const courseId: string = g.courseId || g.id;
                const courseName: string = g.courseName || g.name || courseId;
                if (!courseId) continue;

                const passed = g.finalMarkLetter && !['F', 'I', 'X'].includes(g.finalMarkLetter);
                const rel = passed ? 'PASSED' : 'FAILED';

                await session.run(
                    `MERGE (c:Course {id: $cid}) SET c.name = $name
                     WITH c
                     MATCH (s:Student {id: $sid})
                     MERGE (s)-[r:${rel} {semester: $sem}]->(c)
                     SET r.finalMark = $mark, r.finalMarkLetter = $letter`,
                    {
                        cid: courseId,
                        name: courseName,
                        sid: studentId,
                        sem: g.semester || semester,
                        mark: g.finalMark ?? null,
                        letter: g.finalMarkLetter ?? null,
                    },
                );
            }

            // Seed current enrollment
            for (const cls of classes) {
                const courseId: string = cls.courseId || cls.subjectId || cls.id;
                const courseName: string = cls.courseName || cls.subjectName || courseId;
                if (!courseId) continue;

                await session.run(
                    `MERGE (c:Course {id: $cid}) SET c.name = $name
                     WITH c
                     MATCH (s:Student {id: $sid})
                     MERGE (s)-[r:ENROLLED {semester: $sem}]->(c)`,
                    { cid: courseId, name: courseName, sid: studentId, sem: semester },
                );
            }

            logger.info('Student graph seeded', {
                studentId,
                semester,
                gradesCount: grades.length,
                enrolledCount: classes.length,
            });
        } finally {
            await session.close();
        }
    }
}
