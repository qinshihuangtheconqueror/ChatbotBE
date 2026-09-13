import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { AgentFacade, buildAgentFacade } from '@/agent/runtime/build-multi-agent-facade';
import { HistoryService } from './history.service';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('MultiAgentProvider');

/**
 * Singleton NestJS provider that builds and caches the AgentFacade.
 * Wires Mongoose connection → MongoClient for the checkpointer.
 */
@Injectable()
export class MultiAgentProvider implements OnModuleInit {
    private facade!: AgentFacade;

    constructor(
        @InjectConnection() private readonly connection: Connection,
        private readonly historyService: HistoryService,
    ) { }

    async onModuleInit(): Promise<void> {
        logger.info('Building MultiAgentFacade...');
        this.facade = buildAgentFacade({
            mongoClient: (this.connection as any).getClient(),
            historyStore: this.historyService,
        });
        logger.info('MultiAgentFacade ready');
    }

    getFacade(): AgentFacade {
        return this.facade;
    }
}
