import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { BaseMessage } from '@langchain/core/messages';
import { HistoryStore } from '@/agent/persistence/history.store';
import { createLogger } from '@/common/logger/logger';
import * as fs from 'fs';
import * as path from 'path';

const logger = createLogger('HistoryService');

/**
 * Concrete MongoDB implementation of HistoryStore.
 * Stores conversation turns in `hustva_v3.conversations` collection.
 */
@Injectable()
export class HistoryService implements HistoryStore, OnModuleInit {
    constructor(@InjectConnection() private readonly conn: Connection) { }

    // =========================================================================
    // GIẢI PHÁP A: TỰ ĐỘNG TẠO INDEX KHI KHỞI ĐỘNG SERVER
    // =========================================================================
    async onModuleInit() {
        try {
            const col = this.conn.collection('conversations');
            logger.info('Đang kiểm tra và tạo MongoDB Indexes cho HistoryService...');
            await col.createIndex({ thread_id: 1 }, { unique: true });
            await col.createIndex({ student_id: 1, updated_at: -1 });

            // Index cho checkpointer
            const checkCol = this.conn.collection('checkpoints');
            await checkCol.createIndex({ thread_id: 1, checkpoint_ns: 1, checkpoint_id: -1 });

            const writeCol = this.conn.collection('checkpoint_writes');
            await writeCol.createIndex({ thread_id: 1, checkpoint_ns: 1, checkpoint_id: 1 });

            logger.info('✅ Đã tạo MongoDB Indexes thành công. CPU sẽ được tối ưu!');
        } catch (error) {
            logger.error('❌ Lỗi khi tạo MongoDB Indexes', error);
        }
    }

    async loadContext(
        threadId: string,
        _studentId: string,
    ): Promise<{ turns: BaseMessage[]; summary: string }> {
        try {
            const col = this.conn.collection('conversations');
            const doc = await col.findOne({ thread_id: threadId });
            if (!doc) return { turns: [], summary: '' };
            return { turns: doc.turns || [], summary: doc.summary || '' };
        } catch (e) {
            logger.error('loadContext failed', e, { threadId });
            return { turns: [], summary: '' };
        }
    }

    // =========================================================================
    // GIẢI PHÁP B: TỐI ƯU HÓA PAYLOAD GHI MẢNG `TURNS` BẰNG $PUSH
    // =========================================================================
    async saveContext(
        threadId: string,
        studentId: string,
        turns: BaseMessage[],
        summary: string,
        threadTitle?: string,
    ): Promise<void> {
        try {
            const col = this.conn.collection('conversations');

            // 1. Tìm bản ghi hiện tại để xem mảng turns đang dài bao nhiêu
            // Nhờ có Index (Giải pháp A), lệnh findOne này chạy cực nhanh (< 1ms)
            const existingDoc = await col.findOne(
                { thread_id: threadId }, 
                { projection: { turns: 1 } }
            );

            const updatePayload: any = {
                student_id: studentId,
                summary, 
                updated_at: new Date(),
            };
            if (threadTitle) updatePayload.thread_title = threadTitle;

            // Nếu Thread ĐÃ TỒN TẠI
            if (existingDoc && Array.isArray(existingDoc.turns)) {
                const existingCount = existingDoc.turns.length;
                
                // Cắt lấy phần đuôi (những tin nhắn mới)
                const newTurns = turns.slice(existingCount).map(m => ({ type: m.getType(), content: m.content }));

                const updateOp: any = { $set: updatePayload };
                
                // Nếu có tin nhắn mới, dùng $push kết hợp $each để chèn thêm vào cuối mảng, không đè lại toàn bộ
                if (newTurns.length > 0) {
                    updateOp.$push = { turns: { $each: newTurns } };
                }

                await col.updateOne({ thread_id: threadId }, updateOp);
            } 
            // Nếu Thread CHƯA TỒN TẠI (Lần chat đầu tiên)
            else {
                updatePayload.thread_id = threadId;
                updatePayload.turns = turns.map(m => ({ type: m.getType(), content: m.content }));
                
                await col.updateOne(
                    { thread_id: threadId },
                    {
                        $set: updatePayload,
                        $setOnInsert: { created_at: new Date() },
                    },
                    { upsert: true }
                );
            }
        } catch (e) {
            logger.error('saveContext failed', e, { threadId });
        }
    }

    async saveDualContext(
        threadId: string,
        studentId: string,
        userQuery: string,
        contentA: string,
        contentB: string,
        threadTitle?: string // 🔥 THÊM THAM SỐ NÀY ĐỂ NHẬN TIÊU ĐỀ
    ): Promise<void> {
        try {
            const col = this.conn.collection('conversations');
            const summarySnippet = `\nSV: ${userQuery.substring(0, 80)}...\nAI: ${contentA.substring(0, 80)}...`;

            const newTurns = [
                { type: 'human', content: userQuery },
                { 
                    type: 'ai', 
                    content: contentA, 
                    ques_type: 'dual', 
                    content_A: contentA,
                    content_B: contentB
                }
            ];

            const existingDoc = await col.findOne({ thread_id: threadId }, { projection: { _id: 1, summary: 1 } });
            
            // Khởi tạo payload linh hoạt
            const updatePayload: any = {
                updated_at: new Date()
            };
            
            // 🔥 NẾU CÓ TIÊU ĐỀ THÌ MỚI ĐẨY VÀO PAYLOAD GHI ĐÈ
            if (threadTitle) updatePayload.thread_title = threadTitle;

            if (existingDoc) {
                const newSummary = (existingDoc.summary || '') + summarySnippet;
                updatePayload.summary = newSummary;

                await col.updateOne(
                    { thread_id: threadId }, 
                    { 
                        $set: updatePayload,
                        $push: { turns: { $each: newTurns } as any } 
                    }
                );
            } else {
                updatePayload.thread_id = threadId;
                updatePayload.student_id = studentId;
                updatePayload.summary = summarySnippet;
                updatePayload.turns = newTurns;

                await col.updateOne(
                    { thread_id: threadId },
                    {
                        $set: updatePayload,
                        $setOnInsert: { created_at: new Date() },
                    },
                    { upsert: true }
                );
            }
            logger.info('Dual Context saved with title metadata', { threadId, hasTitle: !!threadTitle });
        } catch (e) {
            logger.error('saveDualContext failed', e, { threadId });
        }
    }

    // 1. Sửa hàm addFeedback để nhận thêm 2 biến
    async addFeedback(
        threadId: string,
        messageId: string,
        like: boolean,
        comment: string,
        userQuestion?: string, // 🌟 Thêm dòng này
        botAnswer?: string     // 🌟 Thêm dòng này
    ): Promise<void> {
        try {
            const col = this.conn.collection('conversations');
            await col.updateOne(
                { thread_id: threadId },
                {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    $push: {
                        feedbacks: {
                            message_id: messageId,
                            like,
                            comment,
                            userQuestion, // 🌟 Lưu thẳng vào DB
                            botAnswer,    // 🌟 Lưu thẳng vào DB
                            timestamp: new Date(),
                        }
                    } as any,
                }
            );
        } catch (e) {
            logger.error('addFeedback failed', e, { threadId });
        }
    }

    /**
     * Xử lý lựa chọn Dual-Agent:
     * 1. Lưu feedback chứa đầy đủ: Câu hỏi, Câu chọn, Câu loại phục vụ Thống kê A/B Testing.
     * 2. Cắt gọt turns: Đổi ques_type về 'single', lưu câu được chọn, xóa content_A/B thừa.
     */
    async processComparisonSelection(
        threadId: string,
        messageId: string,
        userQuestion: string,
        chosenAnswer: string,
        rejectedAnswer: string,
        comment: string
    ): Promise<void> {
        try {
            const col = this.conn.collection('conversations');

            // 1. LƯU FEEDBACK ĐẦY ĐỦ PHỤC VỤ THỐNG KÊ (Lưu cả câu chọn và câu loại)
            await col.updateOne(
                { thread_id: threadId },
                {
                    $push: {
                        feedbacks: {
                            message_id: messageId,
                            type: 'comparison',
                            comment, // Chứa thông tin Chosen: A hoặc B
                            userQuestion,
                            botAnswer: chosenAnswer,       // Câu trả lời tốt hơn
                            rejectedAnswer: rejectedAnswer, // Câu trả lời bị loại
                            timestamp: new Date(),
                        }
                    } as any
                }
            );

            // 2. HỢP NHẤT MẢNG TURNS (Biến đổi dữ liệu hiển thị và bối cảnh)
            if (messageId.includes('-msg-')) {
                const turnIndexStr = messageId.split('-msg-')[1];
                const turnIndex = parseInt(turnIndexStr, 10);

                if (!isNaN(turnIndex)) {
                    await col.updateOne(
                        { thread_id: threadId },
                        {
                            // Đổi kiểu về single và gán content chính bằng câu được chọn
                            $set: {
                                [`turns.${turnIndex}.ques_type`]: 'single',
                                [`turns.${turnIndex}.content`]: chosenAnswer
                            },
                            // Loại bỏ các trường content phụ để dọn sạch DB, turn sau F5 không bị chia cột nữa
                            $unset: {
                                [`turns.${turnIndex}.content_A`]: "",
                                [`turns.${turnIndex}.content_B`]: ""
                            }
                        }
                    );
                    logger.info(`Atomically merged Dual to Single for analytics`, { threadId, turnIndex });
                }
            }
        } catch (e) {
            logger.error('processComparisonSelection failed', e, { threadId });
        }
    }

    // ====================================================================
    // LẤY DỮ LIỆU ĐÁNH GIÁ SO SÁNH (DUAL-AGENT A/B TESTING)
    // ====================================================================
    async getCompareFeedbacks(): Promise<any[]> {
        try {
            const col = this.conn.collection('conversations');
            
            // TỐI ƯU: Chỉ lấy các đoạn chat có tồn tại ít nhất 1 feedback loại 'comparison'
            const docs = await col.find(
                { "feedbacks.type": "comparison" },
                { projection: { student_id: 1, thread_id: 1, feedbacks: 1 } } 
            ).toArray();

            const formattedLogs: any[] = [];

            for (const doc of docs) {
                const studentId = doc.student_id || 'Ẩn danh';
                const threadId = doc.thread_id;
                const feedbacks = doc.feedbacks || [];

                for (const fb of feedbacks) {
                    // CHỈ LỌC LẤY NHỮNG FEEDBACK LÀ COMPARISON
                    if (fb.type === 'comparison') {
                        
                        // Bóc tách nhãn Version (A hoặc B) từ comment "[COMPARE] Chosen: A"
                        let chosenLabel = 'Unknown';
                        if (fb.comment && fb.comment.includes('Chosen: ')) {
                            chosenLabel = fb.comment.split('Chosen: ')[1].trim();
                        }

                        formattedLogs.push({
                            studentId,
                            threadId,
                            messageId: fb.message_id,
                            userQuestion: fb.userQuestion || 'Không có dữ liệu',
                            chosenAnswer: fb.botAnswer || 'Không có dữ liệu',
                            rejectedAnswer: fb.rejectedAnswer || 'Không có dữ liệu',
                            chosenLabel: chosenLabel, // Trả về 'A' hoặc 'B'
                            timestamp: fb.timestamp || new Date(),
                        });
                    }
                }
            }

            // Sắp xếp mới nhất lên đầu
            return formattedLogs.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        } catch (e) {
            logger.error('getCompareFeedbacks failed', e);
            return [];
        }
    }

    // 2. Sửa hàm getAllFeedbacks cực kỳ ngắn gọn (không cần lặp tìm turns nữa)
    async getAllFeedbacks(): Promise<any[]> {
        try {
            const col = this.conn.collection('conversations');
            
            // TỐI ƯU Ở ĐÂY: Dùng projection để chỉ lấy đúng 3 trường cần thiết, bỏ qua mảng 'turns' siêu nặng
            const docs = await col.find(
                { feedbacks: { $exists: true, $not: { $size: 0 } } },
                { projection: { student_id: 1, thread_id: 1, feedbacks: 1 } } 
            ).toArray();

            const formattedLogs: any[] = [];

            for (const doc of docs) {
                const studentId = doc.student_id || 'Ẩn danh';
                const threadId = doc.thread_id;
                const feedbacks = doc.feedbacks || [];

                for (const fb of feedbacks) {
                    formattedLogs.push({
                        studentId,
                        threadId,
                        messageId: fb.message_id,
                        userQuestion: fb.userQuestion || 'Không có dữ liệu (Do bản ghi cũ)',
                        botAnswer: fb.botAnswer || 'Không có dữ liệu (Do bản ghi cũ)',
                        status: fb.like ? 'LIKE 👍' : 'DISLIKE 👎',
                        comment: fb.comment ? fb.comment.trim() : '',
                        timestamp: fb.timestamp || new Date(),
                    });
                }
            }

            return formattedLogs.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        } catch (e) {
            logger.error('getAllFeedbacks failed', e);
            return [];
        }
    }

    // ─── History REST API methods ────────────────────────────────────────────

    /**
     * List all conversation threads for a student (sidebar data).
     * Returns lightweight summaries sorted newest-first, max 60 items.
     */
    async getThreadsList(studentId: string): Promise<Array<{
        thread_id: string;
        title: string;
        message_count: number;
        updated_at: string;
    }>> {
        try {
            const col = this.conn.collection('conversations');
            
            // Dùng Aggregation để xử lý dữ liệu ngay dưới Database
            const docs = await col.aggregate([
                { $match: { student_id: studentId } },
                { $sort: { updated_at: -1 } },
                { $limit: 60 },
                { 
                    $project: { 
                        thread_id: 1, 
                        thread_title: 1, 
                        summary: 1, 
                        updated_at: 1, 
                        created_at: 1,
                        // 1. Nhờ DB đếm TỔNG số tin nhắn (thay cho d.turns.length)
                        message_count: { $size: { $ifNull: ["$turns", []] } },
                        // 2. CHỈ cắt lấy 2 tin nhắn đầu tiên để hàm extractTitle dùng
                        turns: { $slice: [{ $ifNull: ["$turns", []] }, 2] } 
                    } 
                }
            ]).toArray();

            return docs.map(d => ({
                thread_id: d.thread_id,
                // Vẫn dùng được extractTitle bình thường vì d.turns giờ là mảng mini (tối đa 2 phần tử)
                title: d.thread_title || this.extractTitle(d.turns) || 'Cuộc trò chuyện mới',
                // Dùng thẳng kết quả DB đã đếm hộ
                message_count: d.message_count, 
                updated_at: (d.updated_at || d.created_at || new Date()).toISOString?.() ?? new Date().toISOString(),
            }));
        } catch (e) {
            logger.error('getThreadsList failed', e, { studentId });
            return [];
        }
    }

    /**
     * Get full conversation detail for a specific thread.
     */
    async getThreadDetail(threadId: string, studentId: string): Promise<{
        thread_id: string;
        messages: Array<{ 
            role: string; 
            content: string; 
            id?: string; 
            rated?: boolean; 
            isLike?: boolean;
            ques_type?: string;    // 🔥 Trả về cờ dual
            content_A?: string;    // 🔥 Trả về text A
            content_B?: string;    // 🔥 Trả về text B
        }>;
        summary: string;
    } | null> {
        try {
            const col = this.conn.collection('conversations');
            const doc = await col.findOne({ thread_id: threadId, student_id: studentId });
            if (!doc) return null;

            // Mapping Feedback
            const feedbackMap = new Map();
            if (doc.feedbacks && Array.isArray(doc.feedbacks)) {
                for (const fb of doc.feedbacks) {
                    if (fb.message_id) feedbackMap.set(fb.message_id, fb);
                }
            }

            const messages = (doc.turns || []).map((t: any, index: number) => {
                const role = t.type === 'human' ? 'user' : 'assistant';
                const content = typeof t.content === 'string' ? t.content : JSON.stringify(t.content);
                const msgId = `${threadId}-msg-${index}`; 

                const messageObj: any = { role, content, id: msgId };

                // 🔥 ĐÂY LÀ ĐOẠN QUAN TRỌNG NHẤT: Bơm dữ liệu Dual lên cho Frontend
                if (t.ques_type === 'dual') {
                    messageObj.ques_type = 'dual';
                    messageObj.content_A = t.content_A;
                    messageObj.content_B = t.content_B;
                }

                if (role === 'assistant') {
                    const existingFeedback = feedbackMap.get(msgId);
                    if (existingFeedback) {
                        messageObj.rated = true;
                        messageObj.isLike = existingFeedback.like; 
                        
                        // 🌟 TUYỆT CHIÊU: Nếu đã được Like, ép nó thành Single
                        // Frontend sẽ nhận được text của câu đã Like ở thuộc tính 'content' 
                        // và không vẽ 2 cột nữa
                        messageObj.ques_type = 'single';
                    } else {
                        messageObj.rated = false;
                        messageObj.isLike = null;
                    }
                }

                return messageObj;
            });

            return {
                thread_id: doc.thread_id,
                messages,
                summary: doc.summary || '',
            };
        } catch (e) {
            logger.error('getThreadDetail failed', e, { threadId });
            return null;
        }
    }


    /**
     * Delete a conversation thread. Enforces ownership via studentId filter.
     */
    async deleteThread(threadId: string, studentId: string): Promise<boolean> {
        try {
            // Xóa trong conversations
            const col = this.conn.collection('conversations');
            const result = await col.deleteOne({ thread_id: threadId, student_id: studentId });
            
            // XÓA RÁC CỦA LANGGRAPH
            if (result.deletedCount && result.deletedCount > 0) {
                await this.conn.collection('checkpoints').deleteMany({ thread_id: threadId });
                await this.conn.collection('checkpoint_writes').deleteMany({ thread_id: threadId });
            }

            return true;
        } catch (e) {
            return false;
        }
    }

    /** (KHÔNG DÙNG NỮA) Extract a title from the first human message in turns array */
    private extractTitle(turns: any[]): string {
        if (!Array.isArray(turns)) return '';
        const first = turns.find((t: any) => t.type === 'human');
        if (!first) return '';
        const text = typeof first.content === 'string' ? first.content : '';
        return text.slice(0, 60) + (text.length > 60 ? '...' : '');
    }

    async exportAllMessagesToFile(): Promise<string> {
        return new Promise(async (resolve, reject) => {
            try {
                // 1. Tạo thư mục chứa file export (Nằm ở thư mục gốc của project)
                const exportDir = path.join(process.cwd(), 'exports_backup');
                if (!fs.existsSync(exportDir)) {
                    fs.mkdirSync(exportDir, { recursive: true });
                }

                // 2. Tạo tên file theo thời gian thực
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const fileName = `chat_backup_${timestamp}.json`;
                const filePath = path.join(exportDir, fileName);

                const col = this.conn.collection('conversations');
                
                // Mở luồng ghi file
                const writeStream = fs.createWriteStream(filePath, { encoding: 'utf8' });
                writeStream.write('[\n'); // Mở ngoặc mảng JSON

                // 3. Dùng Cursor (Con trỏ) để duyệt DB. Đọc từng bản ghi và ghi thẳng ra file
                const cursor = col.find({});
                let isFirst = true;
                let count = 0;

                for await (const doc of cursor) {
                    if (!isFirst) {
                        writeStream.write(',\n');
                    }
                    writeStream.write(JSON.stringify(doc));
                    isFirst = false;
                    count++;
                }

                writeStream.write('\n]'); // Đóng ngoặc mảng JSON
                writeStream.end();

                // 4. Lắng nghe sự kiện ghi file hoàn tất
                writeStream.on('finish', () => {
                    logger.info(`✅ Đã xuất thành công ${count} cuộc hội thoại ra file: ${filePath}`);
                    resolve(filePath);
                });

                writeStream.on('error', (err) => {
                    logger.error('❌ Lỗi khi ghi file export', err);
                    reject(err);
                });

            } catch (error) {
                logger.error('❌ Lỗi hệ thống khi export', error);
                reject(error);
            }
        });
    }
}
