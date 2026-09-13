import { Module, MiddlewareConsumer, RequestMethod } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminController } from './controllers/admin.controller'; 
import { ChatController, HealthController } from '@/server/controllers/chat.controller';
import { AuthController } from '@/server/controllers/auth.controller';
import { HistoryController } from '@/server/controllers/history.controller';
import { ChatService } from '@/server/services/chat.service';
import { AuthService } from '@/server/services/auth.service';
import { HistoryService } from '@/server/services/history.service';
import { MultiAgentProvider } from '@/server/services/multi-agent.provider';
import { AgentProvider } from '@/server/services/agent.provider';
import { AuthMiddleware, RateLimitMiddleware } from '@/server/middleware/auth.middleware';
import { StudentGraphService } from '@/agent/services/student-graph.service';
import { RedisClient } from '@/agent/tools/clients/redis.client';
import { HustApiClient } from '@/agent/tools/clients/hust-api.client';
import { EHustDbApiClient } from '@/agent/tools/clients/ehust-db.client';
import { SemesterCacheService } from '@/agent/services/semester-cache.service';
import { CurriculumCacheService } from '@/agent/services/curriculum-cache.service';
import { StudentCacheService } from '@/agent/services/student-cache.service';
import { TopicCacheService } from '@/agent/services/topic-cache.service';
import { envConfig } from '@/common/config/env.config';

@Module({
    imports: [
        MongooseModule.forRoot(envConfig.MONGO_URI),
        ScheduleModule.forRoot(),
    ],
    controllers: [ChatController, HealthController, AuthController, HistoryController, AdminController],
    providers: [ChatService, HistoryService, MultiAgentProvider, AgentProvider,AuthService, 
                StudentGraphService, 
                SemesterCacheService, CurriculumCacheService, StudentCacheService, TopicCacheService, 
                RedisClient, HustApiClient, EHustDbApiClient],
})
export class AppModule {
    configure(consumer: MiddlewareConsumer) {
        consumer
            .apply(AuthMiddleware, RateLimitMiddleware)
            // Guard chat + history routes — /v1/auth/* is public
            .forRoutes(
                { path: 'v1/chat/*path', method: RequestMethod.ALL },
                { path: 'v1/history/*path', method: RequestMethod.ALL },
            );
    }
}

