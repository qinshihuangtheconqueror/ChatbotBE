import { MongoDBSaver } from '@langchain/langgraph-checkpoint-mongodb';
import { MongoClient } from 'mongodb';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('Checkpointer');

export function createMongoSaver(client: MongoClient): MongoDBSaver {
    logger.info('Creating MongoDBSaver checkpointer');
    return new MongoDBSaver({
        client: client as any,
        dbName: 'hustva_v3',
        checkpointCollectionName: 'checkpoints',
        checkpointWritesCollectionName: 'checkpoint_writes',
    });
}
