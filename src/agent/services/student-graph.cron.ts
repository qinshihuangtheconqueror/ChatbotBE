/**
 * student-graph.cron.ts — HustVA V3
 *
 * Auto-refreshes Neo4j student graphs at the start of each HUST semester.
 *
 * HUST semester calendar:
 *   Semester 1 (20XXX1): starts ~Sept 1   → cron: 0 3 1 9 *
 *   Semester 2 (20XXX2): starts ~Feb  1   → cron: 0 3 1 2 *
 *   Summer     (20XXX3): starts ~June 15  → cron: 0 3 15 6 *
 *
 * On each trigger:
 *   - Fetch all Student IDs from Neo4j
 *   - For each student, call refreshStudentGraph()
 *   - Rate-limited: one student per 2 seconds to avoid eHUST API overload
 */
import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { StudentGraphService } from './student-graph.service';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('StudentGraphCron');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

@Injectable()
export class StudentGraphCron {
    constructor(private readonly studentGraph: StudentGraphService) {}

    /** Semester 1 — ~September 1 at 03:00 */
    @Cron('0 3 1 9 *', { name: 'refresh_graph_sem1', timeZone: 'Asia/Ho_Chi_Minh' })
    async refreshSemester1() {
        logger.info('Cron: refreshing student graphs for Semester 1');
        await this.runRefreshAll();
    }

    /** Semester 2 — ~February 1 at 03:00 */
    @Cron('0 3 1 2 *', { name: 'refresh_graph_sem2', timeZone: 'Asia/Ho_Chi_Minh' })
    async refreshSemester2() {
        logger.info('Cron: refreshing student graphs for Semester 2');
        await this.runRefreshAll();
    }

    /** Summer semester — ~June 15 at 03:00 */
    @Cron('0 3 15 6 *', { name: 'refresh_graph_summer', timeZone: 'Asia/Ho_Chi_Minh' })
    async refreshSummer() {
        logger.info('Cron: refreshing student graphs for Summer semester');
        await this.runRefreshAll();
    }

    private async runRefreshAll(): Promise<void> {
        let studentIds: string[];
        try {
            studentIds = await this.studentGraph.getAllStudentIds();
        } catch (e) {
            logger.error('Cron: failed to fetch student IDs', { error: String(e) });
            return;
        }

        logger.info(`Cron: refreshing ${studentIds.length} students`);
        let success = 0, failed = 0;

        for (const studentId of studentIds) {
            try {
                await this.studentGraph.refreshStudentGraph(studentId);
                success++;
            } catch (e) {
                logger.warn('Cron: failed to refresh student', { studentId, error: String(e) });
                failed++;
            }
            // Rate limit: 1 student per 2 seconds — respectful to eHUST API
            await sleep(2000);
        }

        logger.info(`Cron: refresh complete`, { success, failed, total: studentIds.length });
    }
}
