import neo4j, { Driver, Session } from 'neo4j-driver';
import { envConfig } from '@/common/config/env.config';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('Neo4jClient');

export class Neo4jClient {
    private driver: Driver;

    constructor() {
        this.driver = neo4j.driver(
            envConfig.NEO4J_URI,
            neo4j.auth.basic(envConfig.NEO4J_USER, envConfig.NEO4J_PASSWORD),
            { maxConnectionLifetime: 3 * 60 * 60 * 1000 },
        );
        logger.info('Neo4j driver created', { uri: envConfig.NEO4J_URI });
    }

    async query<T = Record<string, unknown>>(
        cypher: string,
        params?: Record<string, unknown>,
    ): Promise<T[]> {
        const session: Session = this.driver.session({ defaultAccessMode: neo4j.session.READ });
        try {
            const result = await session.run(cypher, params);
            return result.records.map(r => r.toObject() as T);
        } finally {
            await session.close();
        }
    }

    async verifyConnectivity(): Promise<void> {
        await this.driver.verifyConnectivity();
        logger.info('Neo4j connectivity verified');
    }

    async close(): Promise<void> {
        await this.driver.close();
    }
}
