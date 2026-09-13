import { MilvusSearchClient } from './src/agent/tools/clients/milvus.client';
import { envConfig } from './src/common/config/env.config';

async function main() {
    const client = new MilvusSearchClient();
    await client.warmEmbedder();

    console.log("=== Testing 'Học bổng khuyến khích' with category 'ĐH' ===");
    try {
        const results1 = await client.search('học bổng khuyến khích học tập', {
            topK: 5,
            threshold: -1.0,
            categories: ['ĐH']
        });
        console.log("Results with 'ĐH':", results1.map(r => r.payload.title));

        const results2 = await client.search('học bổng khuyến khích học tập', {
            topK: 5,
            threshold: -1.0,
            categories: []
        });
        console.log("Results without category filter:", results2.map(r => r.payload.title));

        // Also let's try with 'H' just in case
        const results3 = await client.search('học bổng khuyến khích học tập', {
            topK: 5,
            threshold: -1.0,
            categories: ['H']
        });
        console.log("Results with 'H':", results3.map(r => r.payload.title));

    } catch (e) {
        console.error("Error connecting to Milvus:", e);
    }
}
main();
